use serde_json::Value;
use std::{collections::HashSet, net::TcpListener, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
mod transport;

struct LocalService {
    client: reqwest::Client,
    endpoint: String,
    token: String,
    child: Mutex<Option<Child>>,
    error: Option<String>,
    selected_projects: Mutex<HashSet<String>>,
    tls: Mutex<Option<transport::EphemeralTls>>,
}
impl LocalService {
    fn shutdown(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() { let _ = process.kill(); let _ = process.wait(); }
        }
        if let Ok(mut identity) = self.tls.lock() { identity.take(); }
    }
}
impl Drop for LocalService { fn drop(&mut self) { self.shutdown(); } }

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
fn allowed_route(method: &str, path: &str) -> bool {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') || path.contains('#') || path.contains("..") || path.len() > 8192 { return false; }
    let clean = path.split('?').next().unwrap_or("");
    let parts: Vec<&str> = clean.trim_start_matches('/').split('/').collect();
    let exact = match method {
        "GET" => ["/status", "/settings", "/network/status", "/network/receipts", "/rewards/config"].contains(&path),
        "PUT" => path == "/settings",
        "POST" => ["/model/prepare", "/chat", "/projects/open", "/agent/tasks", "/network/configure", "/network/contribution", "/network/run-once"].contains(&path),
        _ => false,
    };
    if exact { return true; }
    match (method, parts.as_slice()) {
        ("GET", ["projects", id, "file"]) if valid_id(id) => path.split_once('?').is_some_and(|(_, q)| q.starts_with("path=") && !q.contains('&')),
        ("GET", ["agent", "tasks", id]) if valid_id(id) => !path.contains('?'),
        ("POST", ["agent", "tasks", id, verb]) if valid_id(id) => ["cancel", "apply", "revert"].contains(verb) && !path.contains('?'),
        _ => false,
    }
}

#[tauri::command]
async fn api_request(state: State<'_, LocalService>, path: String, method: String, body: Option<Value>) -> Result<Value, String> {
    if !allowed_route(&method, &path) { return Err("本地 API 路径或方法不被允许。".into()); }
    if let Some(error) = &state.error { return Err(error.clone()); }
    if method == "POST" && path == "/projects/open" {
        let selected = body.as_ref().and_then(|data| data.get("path")).and_then(Value::as_str).ok_or("缺少项目路径。")?;
        if !state.selected_projects.lock().map_err(|_| "目录选择状态不可用。")?.contains(selected) {
            return Err("请先通过系统文件夹选择器选择项目。".into());
        }
    }
    let encoded_size = body.as_ref().map(|b| b.to_string().len()).unwrap_or(0);
    if encoded_size > 1_048_576 { return Err("请求超过本地接口的大小限制。".into()); }
    let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "无效请求方法")?;
    let mut request = state.client.request(verb, format!("{}/api{}", state.endpoint, path)).bearer_auth(&state.token);
    if let Some(value) = body { request = request.json(&value); }
    let response = request.send().await.map_err(|_| "无法连接本地服务，请检查 Python 运行时与服务日志。".to_string())?;
    let code = response.status();
    let data: Value = response.json().await.map_err(|_| "本地服务返回的 JSON 无效。".to_string())?;
    if !code.is_success() {
        return Err(data.get("detail").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("本地服务返回 {}: {}", code, data)));
    }
    Ok(data)
}

#[tauri::command]
async fn choose_project(app: tauri::AppHandle, state: State<'_, LocalService>) -> Result<Option<String>, String> {
    let selection = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("选择你的项目文件夹").blocking_pick_folder()
            .map(|value| value.into_path().map(|path| path.to_string_lossy().into_owned()).map_err(|_| "目录不是本地路径。".to_string())).transpose()
    }).await.map_err(|error| error.to_string())??;
    if let Some(path) = &selection { state.selected_projects.lock().map_err(|_| "目录选择状态不可用。")?.insert(path.clone()); }
    Ok(selection)
}

fn wallet_destination(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "钱包地址无效。")?;
    let local_portal = url == "http://127.0.0.1:1421/";
    if !local_portal {
        return Err("钱包地址不在允许列表中。".into());
    }
    Ok(parsed)
}

#[tauri::command]
async fn open_wallet(url: String) -> Result<(), String> {
    let parsed = wallet_destination(&url)?;
    open::that(parsed.as_str()).map_err(|error| format!("无法打开系统浏览器：{}", error))
}

fn runtime(app: &tauri::AppHandle) -> LocalService {
    let client = reqwest::Client::builder().https_only(true).tls_built_in_root_certs(false).no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(600)).build().expect("HTTP client");
    let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let mut result = LocalService { client, endpoint: String::new(), token, child: Mutex::new(None), error: None, selected_projects: Mutex::new(HashSet::new()), tls: Mutex::new(None) };
    let startup = (|| -> Result<(), String> {
        if let Ok(endpoint) = std::env::var("HEYUNA_API_URL") {
            if !cfg!(debug_assertions) { return Err("发行版只连接应用自身启动并验证 TLS 身份的本地服务。".into()); }
            let url = reqwest::Url::parse(&endpoint).map_err(|_| "HEYUNA_API_URL 无效")?;
            if url.scheme() != "http" || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) || !url.username().is_empty() || url.password().is_some() || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
                return Err("HEYUNA_API_URL 必须指向本地回环 HTTP 服务。".into());
            }
            result.token = std::env::var("HEYUNA_LOCAL_TOKEN").map_err(|_| "连接现有服务需要 HEYUNA_LOCAL_TOKEN。")?;
            if result.token.len() < 32 { return Err("本地服务凭据至少需要 32 个字符。".into()); }
            result.endpoint = endpoint.trim_end_matches('/').to_string();
            result.client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(600)).build().map_err(|_| "无法建立开发客户端。")?;
            return Ok(());
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let sidecar_name = if cfg!(target_os = "windows") { "heyuna-service.exe" } else { "heyuna-service" };
        let resource_sidecar = app.path().resource_dir().ok().map(|path| path.join("sidecar").join(sidecar_name));
        let dev_sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/sidecar").join(sidecar_name);
        let (python, frozen) = if let Some(path) = std::env::var_os("HEYUNA_PYTHON") {
            (PathBuf::from(path), false)
        } else if let Some(path) = resource_sidecar.filter(|path| path.is_file()) {
            (path, true)
        } else if cfg!(debug_assertions) && dev_sidecar.is_file() {
            (dev_sidecar, true)
        } else if cfg!(debug_assertions) {
            (root.join(if cfg!(target_os = "windows") { ".venv/Scripts/python.exe" } else { ".venv/bin/python" }), false)
        } else {
            return Err("此构建未附带 Python 运行时。请安装完整应用包，或配置 HEYUNA_PYTHON。".into());
        };
        if !python.is_file() { return Err("找不到 Python 运行时。请安装项目开发依赖，或设置 HEYUNA_PYTHON。".into()); }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "无法分配本地服务端口。")?;
        let port = listener.local_addr().map_err(|_| "无法读取本地端口。")?.port();
        drop(listener);
        result.endpoint = format!("https://127.0.0.1:{}", port);
        let state_dir = app.path().app_data_dir().map_err(|_| "无法获取应用数据目录。")?;
        std::fs::create_dir_all(&state_dir).map_err(|_| "无法创建应用数据目录。")?;
        let tls = transport::EphemeralTls::create(&state_dir)?;
        result.client = tls.client()?;
        let mut command = Command::new(python);
        command.args(["-m", "heyuna.cli", "serve", "--port", &port.to_string(), "--state-dir"])
            .arg(&state_dir).env("HEYUNA_LOCAL_TOKEN", &result.token)
            .env("HEYUNA_TLS_CERT", &tls.certificate).env("HEYUNA_TLS_KEY", &tls.private_key)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit());
        command.env("PYTHONNOUSERSITE", "1");
        if frozen { command.env_remove("PYTHONPATH"); }
        else if cfg!(debug_assertions) { command.current_dir(&root).env("PYTHONPATH", root.join("backend")); }
        let child = command.spawn().map_err(|error| format!("无法启动本地服务：{}", error))?;
        *result.child.lock().map_err(|_| "服务进程锁不可用。")? = Some(child);
        *result.tls.lock().map_err(|_| "TLS 身份锁不可用。")? = Some(tls);
        Ok(())
    })();
    if let Err(error) = startup { result.error = Some(error); }
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| { app.manage(runtime(app.handle())); Ok(()) })
        .invoke_handler(tauri::generate_handler![api_request, choose_project, open_wallet])
        .build(tauri::generate_context!()).expect("Heyuna desktop startup failed");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) { handle.state::<LocalService>().shutdown(); }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_accepts_only_narrow_api_routes() {
        assert!(allowed_route("GET", "/status"));
        assert!(allowed_route("GET", "/projects/p_123/file?path=src%2Fmain.py"));
        assert!(allowed_route("POST", "/agent/tasks/task-123/apply"));
        for path in ["https://evil.example", "//evil.example", "/status?url=remote", "/projects/../file?path=x", "/projects/p/file?path=x&url=remote", "/admin", "/status#fragment"] { assert!(!allowed_route("GET", path), "{}", path); }
        assert!(!allowed_route("DELETE", "/status"));
        assert!(!allowed_route("POST", "/settings"));
        assert!(!allowed_route("POST", "/agent/tasks/123/execute"));
    }
    #[test]
    fn wallet_destination_cannot_forward_local_credentials_or_change_origin() {
        assert!(wallet_destination("http://127.0.0.1:1421/").is_ok());
        for url in ["http://127.0.0.1:1421/?token=secret", "http://127.0.0.1:1421/#secret", "http://127.0.0.1:1421/claim", "http://localhost:1421/", "https://wallet.example/", "https://127.0.0.1:1421/", "http://user:secret@127.0.0.1:1421/", "http://127.0.0.1:1422/", "javascript:alert(1)", "file:///tmp/wallet.html"] {
            assert!(wallet_destination(url).is_err(), "{}", url);
        }
    }
}
