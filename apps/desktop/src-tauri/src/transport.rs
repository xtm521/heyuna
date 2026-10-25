//! A per-launch, pinned TLS identity protects both credentials and project data.
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}, time::Duration};

pub struct EphemeralTls {
    directory: PathBuf,
    pub certificate: PathBuf,
    pub private_key: PathBuf,
    certificate_pem: String,
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

impl EphemeralTls {
    pub fn create(parent: &Path) -> Result<Self, String> {
        let directory = parent.join(format!("runtime-tls-{}", uuid::Uuid::new_v4().simple()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&directory).map_err(|_| "无法创建私有本地 TLS 目录。")?;
        let mut identity = Self { certificate: directory.join("certificate.pem"), private_key: directory.join("private-key.pem"), directory, certificate_pem: String::new() };
        let rcgen::CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()])
            .map_err(|_| "无法生成本地服务 TLS 身份。")?;
        identity.certificate_pem = cert.pem();
        write_private(&identity.certificate, identity.certificate_pem.as_bytes()).map_err(|_| "无法保存本地 TLS 证书。")?;
        write_private(&identity.private_key, signing_key.serialize_pem().as_bytes()).map_err(|_| "无法保存本地 TLS 私钥。")?;
        Ok(identity)
    }

    pub fn client(&self) -> Result<reqwest::Client, String> {
        let certificate = reqwest::Certificate::from_pem(self.certificate_pem.as_bytes()).map_err(|_| "本地 TLS 证书无效。")?;
        // Trust only this app launch's identity. No OS roots, proxy, redirect,
        // insecure verification bypass, or HTTP fallback is permitted.
        reqwest::Client::builder().https_only(true).tls_built_in_root_certs(false)
            .add_root_certificate(certificate).no_proxy().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(600))
            .build().map_err(|_| "无法建立受限本地 TLS 客户端。".into())
    }
}

impl Drop for EphemeralTls {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.directory); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::{BufRead, BufReader, Read}, net::TcpListener, process::{Child, Command, Stdio}, thread};

    struct TestServer { child: Child, port: u16 }
    impl Drop for TestServer { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }
    fn tls_server(tls: &EphemeralTls, marker: &Path) -> TestServer {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let local_python = root.join(if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" });
        let python = if local_python.is_file() { local_python } else { PathBuf::from(if cfg!(windows) { "python" } else { "python3" }) };
        let script = r#"import http.server,ssl,sys,pathlib
class Handler(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('content-length','0')))
  pathlib.Path(sys.argv[3]).write_bytes(self.headers.get('authorization','').encode()+b'\n'+body)
  self.send_response(307 if self.path=='/redirect' else 200)
  self.send_header('Location','http://127.0.0.1:1/stolen')
  self.send_header('Content-Type','application/json')
  self.end_headers()
  self.wfile.write(b'{"ok":true}')
 def log_message(self,*args): pass
server=http.server.HTTPServer(('127.0.0.1',0),Handler)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1],sys.argv[2])
server.socket=context.wrap_socket(server.socket,server_side=True)
print(server.server_port,flush=True)
server.serve_forever()
"#;
        let mut child = Command::new(python).args(["-u", "-c", script]).arg(&tls.certificate).arg(&tls.private_key).arg(marker)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        TestServer { child, port: line.trim().parse().expect("TLS test server starts") }
    }

    #[test]
    fn pinned_tls_accepts_only_its_own_service_and_never_follows_redirects() {
        let tls = EphemeralTls::create(&std::env::temp_dir()).unwrap();
        let marker = tls.directory.join("received");
        let server = tls_server(&tls, &marker);
        tauri::async_runtime::block_on(async {
            let response = tls.client().unwrap().post(format!("https://127.0.0.1:{}/api/test", server.port))
                .bearer_auth("fixture-secret").body("fixture-project-data").send().await.unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(fs::read_to_string(&marker).unwrap(), "Bearer fixture-secret\nfixture-project-data");
            let response = tls.client().unwrap().post(format!("https://127.0.0.1:{}/redirect", server.port)).send().await.unwrap();
            assert_eq!(response.status(), 307);
        });
    }

    #[test]
    fn wrong_certificate_cannot_receive_credentials_or_project_body() {
        let expected = EphemeralTls::create(&std::env::temp_dir()).unwrap();
        let impostor = EphemeralTls::create(&std::env::temp_dir()).unwrap();
        let marker = impostor.directory.join("received");
        let server = tls_server(&impostor, &marker);
        tauri::async_runtime::block_on(async {
            assert!(expected.client().unwrap().post(format!("https://127.0.0.1:{}/api/test", server.port))
                .bearer_auth("must-not-leak-token").body("must-not-leak-project").send().await.is_err());
        });
        assert!(!marker.exists());
    }

    #[test]
    fn port_squatter_receives_no_plaintext_and_identity_files_are_private_then_removed() {
        let tls = EphemeralTls::create(&std::env::temp_dir()).unwrap();
        let directory = tls.directory.clone();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&directory).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(fs::metadata(&tls.private_key).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let capture = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut bytes = vec![0; 16384];
            let size = socket.read(&mut bytes).unwrap();
            bytes.truncate(size); bytes
        });
        tauri::async_runtime::block_on(async {
            assert!(tls.client().unwrap().post(format!("https://127.0.0.1:{}/api/test", port))
                .bearer_auth("must-not-leak-token").body("must-not-leak-project").send().await.is_err());
        });
        let bytes = capture.join().unwrap();
        for private in [b"must-not-leak-token".as_slice(), b"must-not-leak-project".as_slice(), b"Bearer".as_slice()] {
            assert!(!bytes.windows(private.len()).any(|part| part == private));
        }
        drop(tls);
        assert!(!directory.exists());
    }
}
