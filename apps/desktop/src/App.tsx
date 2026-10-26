import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import SafeDiffEditor from './SafeDiffEditor';
import SproutMark from './components/SproutMark';
import SproutVisual from './components/SproutVisual';
import TaskTimeline from './components/TaskTimeline';
import ResizeHandle from './components/ResizeHandle';
import { stopVisualEffects } from './components/effects';
import { modelBackendLabel, modelStateLabel, modelSummary } from './presentation';
import { Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleHelp, Code2, Copy, ExternalLink, FileCode2, FolderOpen, GitCompareArrows, History, Leaf, LoaderCircle, Monitor, Moon, Network, Pause, Play, Plus, RefreshCw, Send, Settings2, ShieldCheck, Sparkles, Square, Sun, Terminal, Wallet, X } from 'lucide-react';
import { api, chooseProject, contributionLabel, formatAmount, formatBytes, isDesktop, openWallet, receiptLabel, taskLabel, terminalTask, type Project, type Receipt, type RewardConfig, type Settings, type Status, type Task } from './api';

type Page = 'workspace' | 'training' | 'wallet' | 'receipts' | 'settings';
const pages: { id: Page; label: string; icon: typeof Code2 }[] = [
  { id: 'workspace', label: '编程工作区', icon: Code2 }, { id: 'training', label: '训练中心', icon: Activity },
  { id: 'wallet', label: '奖励钱包', icon: Wallet }, { id: 'receipts', label: '贡献记录', icon: History }, { id: 'settings', label: '网络与设置', icon: Settings2 },
];
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const language = (path: string) => ({ py: 'python', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown', rs: 'rust', css: 'css', html: 'html', sol: 'sol', sh: 'shell', yaml: 'yaml', yml: 'yaml' }[path.split('.').pop() ?? ''] ?? 'plaintext');
function IconButton({ label, onClick, children, disabled = false }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) { return <button className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>; }
function Pill({ children, good = false }: { children: ReactNode; good?: boolean }) { return <span className={`pill ${good ? 'good' : ''}`}><i />{children}</span>; }
function Empty({ icon: Icon, title, children }: { icon: typeof Code2; title: string; children: ReactNode }) { return <div className="empty"><div className="empty-icon"><Icon size={27} strokeWidth={1.5} /></div><h3>{title}</h3><div className="muted">{children}</div></div>; }
function SectionTitle({ eyebrow, title, children, action }: { eyebrow: string; title: string; children: ReactNode; action?: ReactNode }) { return <div className="section-title"><div><h1>{title}</h1><p>{children}</p></div>{action}</div>; }

export default function App() {
  const [page, setPage] = useState<Page>('workspace');
  const [status, setStatus] = useState<Status | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('heyuna-theme') !== 'light');
  const [textScale, setTextScale] = useState(() => { const value = Number(localStorage.getItem('heyuna-text-scale') ?? 1); return [1, 1.25, 1.5, 2].includes(value) ? value : 1; });
  const [effects, setEffects] = useState(() => localStorage.getItem('heyuna-effects') !== 'off');
  const [treeWidth, setTreeWidth] = useState(210);
  const [assistantWidth, setAssistantWidth] = useState(350);
  const [project, setProject] = useState<Project | null>(null);
  const [projectInput, setProjectInput] = useState('');
  const [projectDialog, setProjectDialog] = useState(false);
  const [file, setFile] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState<Task | null>(null);
  const [review, setReview] = useState(false);
  const [changeIndex, setChangeIndex] = useState(0);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptError, setReceiptError] = useState('');
  const [rewardConfig, setRewardConfig] = useState<RewardConfig | null>(null);
  const [walletDialog, setWalletDialog] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const liveResources = status?.resources && status.resources.rss_bytes > 0 ? status.resources : null;
  const knownIdle = !!status && ['disabled', 'idle', 'configured'].includes(status.contribution.state) && status.model.state !== 'downloading';
  const taskRunning = task && !terminalTask(task.status);
  const notify = (text: string, error = false) => setNotice({ text, error });

  const refresh = useCallback(async () => {
    try { setStatus(await api<Status>('/status')); setConnectionError(''); }
    catch (e) { setStatus(null); setConnectionError(errorText(e)); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 6000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { document.documentElement.style.setProperty('--text-scale', String(textScale)); document.documentElement.dataset.textScale=String(textScale); localStorage.setItem('heyuna-text-scale', String(textScale)); }, [textScale]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('heyuna-theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => {
    if (!projectDialog && !walletDialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const modal = document.querySelector<HTMLElement>('.modal');
    const focusable = () => Array.from(modal?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []);
    (modal?.querySelector<HTMLElement>('input') ?? focusable()[0])?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setProjectDialog(false); setWalletDialog(false); }
      if (event.key === 'Tab') {
        const items = focusable(); const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => { document.removeEventListener('keydown', handleKey); previousFocus?.focus(); };
  }, [projectDialog, walletDialog]);
  useEffect(() => {
    if (!task?.id || terminalTask(task.status)) return;
    const timer = window.setInterval(async () => {
      try { setTask(await api<Task>(`/agent/tasks/${task.id}`)); } catch (e) { notify(errorText(e), true); }
    }, 1500);
    return () => clearInterval(timer);
  }, [task?.id, task?.status]);
  const loadReceipts = useCallback(async () => {
    try { const data = await api<Receipt[] | { receipts: Receipt[] }>('/network/receipts'); setReceipts(Array.isArray(data) ? data : data.receipts); setReceiptError(''); }
    catch (e) { setReceiptError(errorText(e)); }
  }, []);
  useEffect(() => { if (page === 'receipts' || page === 'training') void loadReceipts(); }, [page, loadReceipts]);
  useEffect(() => { if (page === 'wallet') api<RewardConfig>('/rewards/config').then(setRewardConfig).catch(e => notify(errorText(e), true)); }, [page]);
  useEffect(() => {
    if (page === 'settings') api<Settings>('/settings').then(data => { setSettings(data); setSettingsError(''); }).catch(e => setSettingsError(errorText(e)));
  }, [page]);

  async function action(key: string, run: () => Promise<void>) { setBusy(key); try { await run(); } catch (e) { notify(errorText(e), true); } finally { setBusy(''); } }
  async function openProject(path: string) {
    await action('project', async () => {
      const opened = await api<Project>('/projects/open', 'POST', { path });
      setProject(opened); setTask(null); setFile(''); setReview(false); setProjectDialog(false);
      if (opened.files.length) { const first = opened.files[0]; const result = await api<{ content: string }>(`/projects/${opened.id}/file?path=${encodeURIComponent(first)}`); setFile(first); setFileContent(result.content); }
    });
  }
  function selectProject() {
    if (isDesktop()) void action('project', async () => { const path = await chooseProject(); if (path) await openProject(path); });
    else setProjectDialog(true);
  }
  async function selectFile(path: string) {
    if (!project) return;
    await action('file', async () => { const data = await api<{ content: string }>(`/projects/${project.id}/file?path=${encodeURIComponent(path)}`); setFile(path); setFileContent(data.content); setReview(false); });
  }
  async function submitTask(event: FormEvent) {
    event.preventDefault(); if (!project || !prompt.trim()) return;
    stopVisualEffects();
    await action('task', async () => { const data = await api<Task>('/agent/tasks', 'POST', { project_id: project.id, prompt }); setTask({ ...data, events: data.events ?? [], changes: data.changes ?? [] }); setPrompt(''); });
  }
  async function taskAction(verb: 'cancel' | 'apply' | 'revert') {
    if (!task) return;
    await action(verb, async () => {
      await api(`/agent/tasks/${task.id}/${verb}`, 'POST');
      setTask(await api<Task>(`/agent/tasks/${task.id}`));
      if (file && project && verb !== 'cancel') { const data = await api<{ content: string }>(`/projects/${project.id}/file?path=${encodeURIComponent(file)}`); setFileContent(data.content); }
      notify({ cancel: '已请求停止任务。', apply: '变更已应用到项目。', revert: '变更已撤回。' }[verb]);
    });
  }
  async function prepareModel() { await action('model', async () => { const data = await api<{ detail: string }>('/model/prepare', 'POST'); notify(data.detail); await refresh(); }); }
  const selectedChange = task?.changes?.[changeIndex];

  return <div className="app-shell">
    <header className="app-header">
      <button className="brand" onClick={() => setPage('workspace')} aria-label="合芽首页"><SproutMark/><span>Heyuna<span className="brand-cn">合芽</span></span></button>
      <nav aria-label="主导航">{pages.map(({id,label,icon:Icon}) => <button key={id} className={`nav-item ${page===id?'active':''}`} onClick={()=>setPage(id)} aria-current={page===id?'page':undefined}><Icon size={16}/><span>{label}</span></button>)}</nav>
      <div className="header-utilities"><span className="network-badge"><span className="status-dot"/>研究测试网</span><IconButton label={dark?'切换浅色主题':'切换深色主题'} onClick={()=>setDark(!dark)}>{dark?<Sun size={17}/>:<Moon size={17}/>}</IconButton></div>
    </header>
    <main>
      {connectionError && <div className="connection-banner" role="status"><span><Network size={16} />本地服务尚未就绪</span><details><summary>查看原因</summary><p>{connectionError}</p></details></div>}
      {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.text}</span><IconButton label="关闭通知" onClick={() => setNotice(null)}><X size={16} /></IconButton></div>}
      {page === 'workspace' && <div className="workspace-page">
        <div className="workspace-toolbar"><div><Code2 size={17}/><strong>{project?.name ?? '编程工作区'}</strong>{project && <span className="subtle">项目副本 · 审查后应用</span>}</div><div className="toolbar-actions"><span className="small-copy muted">{status?.model.ready?'模型就绪':'模型未就绪'}</span><button className="button secondary small" onClick={selectProject} disabled={!!taskRunning||busy==='project'||!status}><FolderOpen size={15}/>{project?'切换项目':'打开项目'}</button></div></div>
        <div className="workbench" style={{'--tree-width':`${treeWidth}px`,'--assistant-width':`${assistantWidth}px`} as CSSProperties}>
          <aside className="file-tree" aria-label="项目文件"><div className="panel-caption"><span>文件</span><span>{project?.files.length ?? '—'}</span></div>{project ? project.files.length ? project.files.map(path=><button title={path} className={`file-item ${file===path?'selected':''}`} key={path} onClick={()=>void selectFile(path)}><FileCode2 size={14}/><span>{path}</span></button>):<p className="panel-empty">没有可读取的源文件</p>:<div className="tree-placeholder"><FolderOpen size={22} strokeWidth={1.2}/><p>尚未打开项目</p><span>项目文件会显示在这里</span></div>}<div className="tree-bottom"><ShieldCheck size={14}/><span>项目与对话默认不参与共训</span></div></aside>
          <ResizeHandle label="调整文件栏宽度" value={treeWidth} setValue={setTreeWidth} min={160} max={340}/>
          <section className="editor-panel" aria-label="代码与变更">
            <div className="panel-tabs"><button className={!review?'selected':''} onClick={()=>setReview(false)}><FileCode2 size={14}/><span>{file||'代码'}</span></button><button className={review?'selected':''} disabled={!task?.changes?.length} onClick={()=>setReview(true)}><GitCompareArrows size={14}/>变更审查{task?.changes?.length?<span className="count">{task.changes.length}</span>:null}</button></div>
            {review && selectedChange ? <><div className="review-toolbar"><select aria-label="选择变更文件" value={changeIndex} onChange={e=>setChangeIndex(Number(e.target.value))}>{task!.changes.map((change,index)=><option value={index} key={change.path}>{change.path}</option>)}</select><span>原始 → 建议</span></div><SafeDiffEditor original={selectedChange.before??''} modified={selectedChange.after??''} language={language(selectedChange.path)} theme={dark?'vs-dark':'light'} options={{readOnly:true,minimap:{enabled:false},renderSideBySide:true,fontSize:14*textScale,automaticLayout:true}}/></> : file ? <Editor value={fileContent} language={language(file)} theme={dark?'vs-dark':'light'} options={{readOnly:true,minimap:{enabled:false},fontSize:14*textScale,padding:{top:20},scrollBeyondLastLine:false,automaticLayout:true}}/> : <div className="workspace-empty"><SproutVisual known={knownIdle} contributing={!!status?.contribution.enabled} taskRunning={!!taskRunning} busy={!!busy} enabled={effects}/><h1>打开项目，开始协作</h1><p>在本地阅读代码、修改与测试。</p><button className="button primary" onClick={selectProject} disabled={!status}><FolderOpen size={16}/>打开本地项目<ArrowRight size={16}/></button><span className="empty-footnote">你确认之后，变更才会写入原项目。</span></div>}
          </section>
          <ResizeHandle label="调整助手栏宽度" value={assistantWidth} setValue={setAssistantWidth} min={280} max={520} reverse/>
          <section className="assistant-panel" aria-label="编程助手"><div className="assistant-title"><span><Sparkles size={16}/>任务</span><Pill good={!!taskRunning}>{task ? taskLabel(task.status) : '待开始'}</Pill></div><div className="assistant-feed" aria-live="polite">{!task?<div className="assistant-empty"><span className="assistant-empty-icon"><Terminal size={21}/></span><h3>你想完成什么？</h3><p>描述一个具体目标。执行过程和测试输出会留在这里。</p><div className="suggestions">{['梳理项目结构与关键入口','实现一个功能并补充测试','定位问题并给出修复'].map(text=><button key={text} onClick={()=>setPrompt(text)} disabled={!project}>{text}<ArrowUpRight size={14}/></button>)}</div></div>:<><div className="task-header"><strong>{taskLabel(task.status)}</strong><code>{task.id.slice(0,8)}</code></div><TaskTimeline events={task.events??[]}/>{task.summary&&<div className="task-summary">{task.summary}</div>}{task.error&&<div className="inline-error">{task.error}</div>}{!!task.changes?.length&&<div className="task-actions"><button className="button secondary" onClick={()=>setReview(true)}><GitCompareArrows size={15}/>审查 {task.changes.length} 个文件</button>{task.status==='applied'?<button className="button secondary" disabled={!!busy} onClick={()=>void taskAction('revert')}>撤回本次变更</button>:<button className="button primary" disabled={!!busy||!review||!terminalTask(task.status)||['reverted','failed','cancelled'].includes(task.status)} onClick={()=>void taskAction('apply')}><CheckCheck size={15}/>应用已审查变更</button>}</div>}</>}</div>
          <form className="composer" onSubmit={submitTask}><label className="sr-only" htmlFor="task-prompt">编程任务</label><textarea id="task-prompt" placeholder={project?'描述要完成的任务…':'先打开一个项目…'} value={prompt} onChange={e=>setPrompt(e.target.value)} disabled={!project||!!taskRunning} rows={3}/><div className="composer-bottom"><span><ShieldCheck size={12}/>在隔离副本中执行</span>{taskRunning?<IconButton label="停止任务" disabled={!!busy} onClick={()=>void taskAction('cancel')}><Square size={15}/></IconButton>:<button className="send-button" aria-label="提交编程任务" disabled={!project||!prompt.trim()||!status?.model.ready||!status?.sandbox.available||!!busy}><ArrowRight size={18}/></button>}</div></form><div className="assistant-disclaimer">AI 可能出错，请审查代码与测试结果。</div></section>
        </div>
        <div className="workspace-footer"><span><span className={`status-dot ${status?'online':''}`}/>{status?'本地服务已连接':'本地服务未连接'}</span><span>{status ? `本地模型 · ${modelStateLabel(status.model.state)}` : '模型未检测'}</span><span><Terminal size={13}/>{status?.sandbox.available?'隔离环境可用':'隔离环境未就绪'}</span><span className="footer-right">{status?.device.platform??'本机'}{status?.device.memory_gb?` · ${status.device.memory_gb} GB`:''}</span><IconButton label="刷新本地状态" onClick={()=>void refresh()}><RefreshCw size={13}/></IconButton></div>
      </div>}
      {page === 'training' && <div className="content-page">
        <SectionTitle eyebrow="" title="训练中心" action={<Pill good={status?.contribution.enabled}>{status?.contribution.enabled?'已开启贡献':'贡献已关闭'}</Pill>}>在本机完成计算，由网络独立验证每一份贡献。</SectionTitle>
        <div className="training-layout"><div className="training-primary">
          <section className="panel contribution-hero"><div className="contribution-copy"><span className="section-kicker">设备参与状态</span><h2>{status?.contribution.enabled?contributionLabel(status.contribution.state):'设备由你掌控'}</h2><p>{status?.contribution.enabled ? status.contribution.detail || '按已配置的时段与资源限制参与。' : '贡献默认关闭。开启后仍需领取并验证真实任务。'}</p><div className="hero-actions"><button className={`button ${status?.contribution.enabled?'secondary':'primary'}`} disabled={busy==='contribution'||(!status?.contribution.enabled&&(!status?.network.configured||!status?.model.ready))} onClick={()=>{stopVisualEffects(); void action('contribution',async()=>{await api('/network/contribution','POST',{enabled:!status?.contribution.enabled});await refresh();});}}>{status?.contribution.enabled?<><Pause size={16}/>暂停贡献</>:<><Play size={16}/>开启算力贡献</>}</button>{status?.contribution.enabled&&<button className="button secondary" disabled={!!busy||!!taskRunning||status.contribution.state==='training'} onClick={()=>{stopVisualEffects(); void action('train',async()=>{const result=await api<{detail?:string}>('/network/run-once','POST');notify(result.detail??'任务请求已完成，请查看贡献记录。');await refresh();await loadReceipts();});}}>领取任务<ArrowRight size={15}/></button>}</div></div><SproutVisual known={knownIdle} contributing={!!status?.contribution.enabled} taskRunning={!!taskRunning} busy={!!busy} enabled={effects}/></section>
          <section className="panel runtime-panel"><div className="panel-heading"><h2>当前运行</h2><span className="small-copy muted">本机进程采样</span></div><div className="training-telemetry"><div><span>训练进程 · RSS</span><strong>{liveResources?formatBytes(liveResources.rss_bytes):'—'}</strong></div><div><span>进程 CPU</span><strong>{liveResources?`${liveResources.cpu_percent.toFixed(1)}%`:'—'}</strong></div><div><span>今日上传</span><strong>{formatBytes(status?.upload_bytes_today)}</strong></div></div><div className="training-stages" aria-label="真实训练阶段">{[['connecting','连接网络'],['training','本机训练'],['submitting','提交结果'],['pending_verification','等待验证']].map(([value,label])=><span key={value} className={status?.contribution.state===value?'current':''}><i/>{label}</span>)}</div><p className="sampling-note">CPU 为进程采样，多核运行时可超过 100%。</p></section>
          <section className="panel source-panel"><div className="panel-heading"><h2>{status?.current_task?'当前 / 最近任务':'任务信息'}</h2>{status?.current_task&&<code>{status.current_task.task_id.slice(0,16)}</code>}</div>{status?.current_task?<dl className="detail-list"><div><dt>数据来源</dt><dd>{status.current_task.data_source}</dd></div><div><dt>数据许可</dt><dd>{status.current_task.data_license}</dd></div><div><dt>训练步数</dt><dd>{status.current_task.steps}</dd></div><div><dt>任务 ID</dt><dd className="mono">{status.current_task.task_id}</dd></div><div><dt>数据哈希</dt><dd className="mono">{status.current_task.data_hash}</dd></div></dl>:<div className="source-empty"><FileCode2 size={22}/><div><h3>等待领取真实任务</h3><p>数据来源、许可和哈希将在这里显示。</p></div></div>}</section>
        </div><aside className="training-side"><section className="panel compact-panel"><div className="panel-heading"><h2>本地模型</h2><Pill good={status?.model.ready}>{status?.model.ready?'就绪':'待准备'}</Pill></div><h3 className="model-name">语言模型 <span>40 亿参数</span></h3><p className="small-copy muted model-id">固定版本 · 本地运行</p><dl className="detail-list"><div><dt>运行后端</dt><dd>{modelBackendLabel(status?.model.backend)}</dd></div><div><dt>训练方式</dt><dd>固定共享适配器 · 仅训练增量</dd></div><div><dt>状态</dt><dd>{status ? modelStateLabel(status.model.state) : '未连接'}</dd></div></dl><p className="small-copy muted model-detail">{modelSummary(status?.model)}</p>{status?.model.state==='error'&&<p className="tiny muted">技术诊断请查看本地服务日志。</p>}<button className="button secondary full" disabled={!status||status.model.ready||busy==='model'||status.model.state==='downloading'} onClick={()=>void prepareModel()}><ArrowDownToLine size={16}/>{status?.model.state==='downloading'?'模型下载中':'下载并准备模型'}</button><p className="tiny muted">模型文件下载会占用网络与本地磁盘。</p></section><section className="panel compact-panel"><h2>参与条件</h2><div className="readiness-row"><span>协调服务配置</span><strong>{status?.network.configured?'已配置':'未配置'}</strong></div><div className="readiness-row"><span>实际网络连接</span><strong>{status?.network.connected?'已连接':'未连接'}</strong></div><div className="readiness-row"><span>本机任务</span><strong>{status?.contribution.state==='training'?'正在训练':'未在训练'}</strong></div><button className="inline-link" onClick={()=>setPage('settings')}>管理网络与资源<ArrowRight size={14}/></button></section><div className="privacy-card"><ShieldCheck size={18}/><p>项目和对话默认不进入共训数据。完成计算不等于奖励已到账。</p></div></aside></div>
        <div className="section-divider"/><div className="receipt-link"><div><h2>从计算到确认</h2><p>每个状态分别记录，不跳过验证与挑战期。</p></div><button className="button secondary" onClick={()=>setPage('receipts')}>查看贡献记录<ArrowRight size={15}/></button></div><div className="lifecycle" aria-label="贡献流程">{['计算完成','待验证','验证通过','待结算','可领取','链上已确认'].map((label,i)=><div key={label}><span>{String(i+1).padStart(2,'0')}</span>{label}{i<5&&<ChevronRight size={14}/>}</div>)}</div>
      </div>}
      {page === 'wallet' && <div className="content-page"><SectionTitle eyebrow="" title="奖励钱包" action={<Pill>{rewardConfig?.profile==='accelerated-local'?'本地加速测试域':'Heyuna 研究测试网'}</Pill>}>独立钱包核验、独立确认签名。此处不会保管你的私钥。</SectionTitle>
        {rewardConfig?.profile==='accelerated-local'&&<div className="test-domain-note">仅本机实验：3 秒挑战期 · Chain ID 297012。此环境不代表公开研究网的安全参数。</div>}
        <section className="wallet-overview"><div><div className="wallet-title"><SproutMark className="coin-mark"/><div><strong>tHEYUNA</strong><span>{rewardConfig?.asset_kind==='legacy-erc20'?'旧版 ERC-20 测试资产':'Heyuna 原生测试币'}</span></div></div><div className="balance-label">钱包余额</div><div className="balance" aria-label="余额未核验">—<span>tHEYUNA</span></div><div className="wallet-note"><span className="status-dot"/>未核验 · 请在外部钱包读取链上余额</div></div><div className="wallet-actions"><button className="button primary" disabled={!rewardConfig?.wallet_url||!rewardConfig?.rewards_address||!rewardConfig?.genesis_hash} onClick={()=>setWalletDialog(true)}>前往外部钱包<ArrowUpRight size={17}/></button><p>连接和领取分别确认</p></div></section>
        <div className="reward-metrics"><section className="panel"><span>待分配奖励</span><strong>—</strong><p>需要验收和公开分配清单</p></section><section className="panel"><span>可领取</span><strong>—</strong><p>在钱包中核验已最终确认的周期</p></section><section className="panel"><span>研究网创世总量</span><strong>20,000,000</strong><p>18 位小数 · 不代表主网发行</p></section></div>
        <section className="panel contract-panel"><div className="panel-heading"><div><h2>核对网络身份</h2><p>链 ID、创世哈希与奖励库共同识别此网络。</p></div><ShieldCheck size={20}/></div><dl className="detail-list"><div><dt>网络</dt><dd>{rewardConfig?.asset_kind==='legacy-erc20'?'历史 ERC-20 测试网络':rewardConfig?.profile==='accelerated-local'?'Heyuna 本地加速测试域':'Heyuna 研究测试网'}</dd></div><div><dt>链 ID</dt><dd className="mono">{rewardConfig?.chain_id??297011}</dd></div><div><dt>创世哈希</dt><dd className="mono">{rewardConfig?.genesis_hash??'尚未配置'}</dd></div><div><dt>奖励库合约</dt><dd className="mono">{rewardConfig?.rewards_address??'尚未配置'}</dd></div>{rewardConfig?.asset_kind==='legacy-erc20'&&<div><dt>旧版代币合约</dt><dd className="mono">{rewardConfig.token_address??'尚未配置'}</dd></div>}</dl>{!rewardConfig?.rewards_address&&<p className="configuration-note">奖励合约尚未部署或未配置</p>}</section><div className="info-note"><CircleHelp size={18}/><p>测试币不承诺兑换，不显示币价或收益。链上分配记录不能单独证明训练真实或模型质量提升。</p></div>
      </div>}
      {page === 'receipts' && <div className="content-page"><SectionTitle eyebrow="A RECORD OF REAL WORK" title="贡献记录" action={<button className="button secondary" onClick={() => void loadReceipts()}><RefreshCw size={15} />刷新记录</button>}>从任务完成到链上确认，清楚记录每一步。</SectionTitle><section className="panel receipts-panel"><div className="table-heading"><h2>全部贡献</h2><span>{receipts.length} 条回执</span></div>{receiptError && <div className="inline-error">{receiptError}</div>}{receipts.length ? <div className="table-scroll"><table><thead><tr><th>任务</th><th>状态</th><th>标准工作单位</th><th>说明 / 结果摘要</th></tr></thead><tbody>{receipts.map((receipt, index) => <tr key={receipt.receipt_id ?? receipt.id ?? `${receipt.task_id}-${index}`}><td><code title={receipt.task_id}>{receipt.task_id?.slice(0, 16)}</code>{receipt.created_at && <small>{receipt.created_at}</small>}</td><td><span className="receipt-state">{receiptLabel(receipt.status ?? receipt.state)}</span></td><td>{receipt.work_units ?? '—'}</td><td>{receipt.reason ?? receipt.detail ?? (receipt.result_hash ? `${receipt.result_hash.slice(0, 16)}…` : '—')}</td></tr>)}</tbody></table></div> : <Empty icon={History} title="还没有贡献记录"><p>加入受邀网络并完成任务后，<br />你的计算结果和验收状态会显示在这里。</p><button className="button secondary" onClick={() => setPage('training')}>了解如何参与<ArrowRight size={15} /></button></Empty>}</section><p className="small-copy muted">有异议时，请保留任务 ID 与结果摘要，联系受邀网络管理员。当前版本尚未开放链上申诉。</p></div>}
      {page === 'settings' && <div className="content-page settings-page"><SectionTitle eyebrow="ON YOUR TERMS" title="网络与设置">配置参与方式、资源边界和显示偏好。</SectionTitle><section className="panel settings-section"><div><h2>受邀网络</h2><p>只有验证连接后，设备才能领取任务。</p></div><form onSubmit={e => { e.preventDefault(); void action('network', async () => { await api('/network/configure', 'POST', { endpoint, device_token: deviceToken }); setDeviceToken(''); await refresh(); notify('网络配置已提交。连接和任务结果以服务返回为准。'); }); }}><label>协调服务地址<input type="url" placeholder="https://your-coordinator.example" value={endpoint} onChange={e => setEndpoint(e.target.value)} required /></label><label>设备邀请凭据<input type="password" autoComplete="off" placeholder="由网络管理员提供" value={deviceToken} onChange={e => setDeviceToken(e.target.value)} required /></label>{status?.network.configured && <p className="small-copy muted">已配置：{status.network.endpoint}</p>}<button className="button primary" disabled={!status || !!busy}>保存网络配置</button></form></section><section className="panel settings-section"><div><h2>资源与时段</h2><p>用于限制后续贡献任务。编程任务运行时暂停领取新的训练任务。</p></div>{settings ? <form onSubmit={e => { e.preventDefault(); void action('settings', async () => { setSettings(await api<Settings>('/settings', 'PUT', { start_time: settings.start_time, end_time: settings.end_time, max_cpu_percent: settings.max_cpu_percent, max_memory_gb: settings.max_memory_gb, max_upload_mb_day: settings.max_upload_mb_day })); notify('资源设置已保存。'); }); }}><div className="form-row"><label>开始时间<input type="time" value={settings.start_time} onChange={e => setSettings({ ...settings, start_time: e.target.value })} required /></label><label>结束时间<input type="time" value={settings.end_time} onChange={e => setSettings({ ...settings, end_time: e.target.value })} required /></label></div><div className="form-row"><label>CPU 上限（% · 未支持时禁用）<input type="number" min="10" max="100" disabled={!settings.supported_limits?.includes("max_cpu_percent")} title="当前运行时尚未保证 CPU 百分比限制" value={settings.max_cpu_percent} onChange={e => setSettings({ ...settings, max_cpu_percent: Number(e.target.value) })} /></label><label>内存上限（GB）<input type="number" min="4" max="128" value={settings.max_memory_gb} onChange={e => setSettings({ ...settings, max_memory_gb: Number(e.target.value) })} /></label></div><label>每日上传上限（MB）<input type="number" min="1" max="10240" value={settings.max_upload_mb_day} onChange={e => setSettings({ ...settings, max_upload_mb_day: Number(e.target.value) })} /></label><button className="button secondary" disabled={!!busy}>保存资源限制</button></form> : <p className="inline-error">{settingsError || '正在读取设置…'}</p>}</section><section className="panel settings-section"><div><h2>外观</h2><p>适应你的工作环境。</p></div><div><div className="theme-options"><button className={`button secondary ${!dark ? 'theme-selected' : ''}`} onClick={() => setDark(false)}><Sun size={17} />浅色</button><button className={`button secondary ${dark ? 'theme-selected' : ''}`} onClick={() => setDark(true)}><Moon size={17} />深色</button></div><label className="effects-setting"><input type="checkbox" checked={effects} onChange={e => { if (!e.target.checked) stopVisualEffects(); setEffects(e.target.checked); localStorage.setItem('heyuna-effects', e.target.checked ? 'on' : 'off'); }}/>空间动效<span>计算任务期间自动释放图形资源</span></label><label className="text-size-control">文字大小<select aria-label="文字大小" value={textScale} onChange={event => setTextScale(Number(event.target.value))}><option value={1}>标准 · 100%</option><option value={1.25}>较大 · 125%</option><option value={1.5}>大 · 150%</option><option value={2}>最大 · 200%</option></select></label></div></section><div className="about-line"><Leaf size={17} /><strong>Heyuna 合芽</strong><span>{status?.version ?? '0.1.0'} · 受邀 Alpha</span><span>以可验证的贡献，共同培育智能。</span></div></div>}
    </main>
    {projectDialog && <div className="modal-backdrop" onClick={() => setProjectDialog(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onClick={e => e.stopPropagation()}><div className="modal-heading"><h2 id="project-dialog-title">打开本地项目</h2><IconButton label="关闭项目选择" onClick={() => setProjectDialog(false)}><X size={18} /></IconButton></div><p>浏览器开发预览使用本地绝对路径。桌面应用使用系统文件夹选择器。</p><form onSubmit={e => { e.preventDefault(); void openProject(projectInput); }}><label>项目文件夹<input value={projectInput} placeholder="/Users/you/Projects/my-project" onChange={e => setProjectInput(e.target.value)} required /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setProjectDialog(false)}>取消</button><button className="button primary" disabled={!!busy || !projectInput.trim()}>打开项目</button></div></form></section></div>}
    {walletDialog && rewardConfig && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title"><div className="modal-heading"><h2 id="wallet-dialog-title">打开外部钱包</h2><IconButton label="关闭钱包确认" onClick={() => setWalletDialog(false)}><X size={18} /></IconButton></div><p>合芽不会在此步骤请求签名。请在外部钱包中分别核验连接与领取交易。</p><dl className="detail-list"><div><dt>网络</dt><dd>{rewardConfig.asset_kind==='legacy-erc20'?'历史 ERC-20 测试网络':rewardConfig.profile==='accelerated-local'?'Heyuna 本地加速测试域':'Heyuna 研究测试网'} · {rewardConfig.chain_id}</dd></div><div><dt>奖励库</dt><dd className="mono">{rewardConfig.rewards_address}</dd></div><div><dt>金额与费用</dt><dd>由钱包读取链上数据后显示</dd></div></dl><div className="modal-actions"><button className="button secondary" onClick={() => setWalletDialog(false)}>取消</button><button className="button primary" onClick={() => void action('wallet', async () => { await openWallet(rewardConfig.wallet_url!); setWalletDialog(false); })}>继续到钱包<ExternalLink size={15} /></button></div></section></div>}
  </div>;
}
