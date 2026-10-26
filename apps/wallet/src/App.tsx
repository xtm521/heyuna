// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, FileCheck2, Leaf, Moon, ShieldCheck, Sun, Wallet } from 'lucide-react';
import { formatEther, formatUnits } from 'ethers';
import { MAX_FILE_BYTES } from './protocol';
import { parseBundle, parseDeployment, connect, prepareClaim, sendClaim, waitForConfirmation, category, feeSymbol, networkName, isNative, readVerifiedBalance, type Bundle, type Deployment, type Quote } from './adapter';
import SproutMark from '../../desktop/src/components/SproutMark';
import { type Connection, type InjectedProvider } from './wallet';
import { WalletCheckError, displayWalletError as displayError } from './presentation';

declare global { interface Window { ethereum?: InjectedProvider } }
type Transaction = { hash: string; quote: Quote; state: 'pending' | 'confirmed' | 'uncertain'; detail: string };
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

export function App() {
  const [config, setConfig] = useState<Deployment | null>(null);
  const [configError, setConfigError] = useState('正在读取公开部署配置…');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [filename, setFilename] = useState('');
  const [claimIndex, setClaimIndex] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('heyuna-wallet-theme') !== 'light');
  const session = useRef(0);
  const claims = bundle?.claims.filter((claim) => claim.recipient.toLowerCase() === connection?.account.toLowerCase()) ?? [];
  const claim = claims.find((row) => row.index === claimIndex) ?? claims[0];

  useEffect(() => {
    let active = true;
    fetch('./deployment.json', { cache: 'no-store', credentials: 'omit' }).then(async (response) => {
      if (!response.ok) throw new WalletCheckError('无法读取公开部署配置。');
      const text = await response.text();
      if (text.length > 32768) throw new WalletCheckError('部署配置过大。');
      return parseDeployment(JSON.parse(text));
    }).then((value) => { if (active) { setConfig(value); setConfigError(''); } }).catch((error) => {
      if (active) setConfigError(displayError(error));
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('heyuna-wallet-theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    if (!connection) return;
    const invalidated = () => {
      session.current += 1;
      setConnection(null); setQuote(null); setBalance(null);
      setMessage('钱包账户、网络或连接已变化。请重新连接并核验；已发送交易请保留其 hash。');
    };
    for (const event of ['chainChanged', 'accountsChanged', 'disconnect']) connection.injected.on?.(event, invalidated);
    return () => { for (const event of ['chainChanged', 'accountsChanged', 'disconnect']) connection.injected.removeListener?.(event, invalidated); };
  }, [connection]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label); setMessage('');
    try { await action(); } catch (error) { setMessage(displayError(error)); }
    finally { setBusy(''); }
  }
  async function importLegacy(file?: File) { if (!file) return; await run('读取旧版部署', async () => { if (file.size > 32768) throw new WalletCheckError('部署配置过大。'); const raw=JSON.parse(await file.text()); if(raw.version!==1) throw new WalletCheckError('此入口只读取旧版 ERC-20 v1 部署。'); const parsed=parseDeployment(raw,true); session.current+=1; setConnection(null); setBalance(null); setBundle(null); setQuote(null); setTransaction(null); setConfig(parsed); setConfigError(''); setMessage('已显式载入旧版 ERC-20 部署。请独立确认文件来源与合约身份。'); }); }
  async function connectWallet() {
    await run('连接钱包', async () => {
      const injected = window.ethereum;
      if (!injected) throw new WalletCheckError('未发现兼容 EIP-1193 的钱包扩展。请使用安装了钱包的系统浏览器。');
      session.current += 1;
      if (!config) throw new WalletCheckError('部署配置尚未就绪。');
      const current = session.current;
      const connected = await connect(injected, config);
      if(current!==session.current) { connected.provider.destroy(); throw new WalletCheckError('钱包会话已变化。'); }
      setConnection(connected); setQuote(null);
      setMessage('钱包已连接。连接操作没有签名或发送交易。');
      setBalance(null);
      if(isNative(config)) { const amount=await readVerifiedBalance(connected,config); if(current===session.current) setBalance(amount); }
    });
  }
  async function loadFile(file?: File) {
    if (!file || !config) return;
    setBundle(null); setFilename(''); setQuote(null);
    await run('读取清单', async () => {
      if (file.size > MAX_FILE_BYTES) throw new WalletCheckError('分配清单不能超过 5 MiB。');
      const parsed = parseBundle(await file.text(), config);
      setBundle(parsed); setFilename(file.name); setQuote(null); setClaimIndex('');
      setMessage('文件摘要与 Merkle 证明已在本地校验。还需要核对链上状态。');
    });
  }
  async function preview() {
    if (!connection || !config || !bundle || !claim) return;
    if (transaction && transaction.state !== 'confirmed' && transaction.quote.claim.epoch === claim.epoch && transaction.quote.claim.index === claim.index) {
      setMessage('这条奖励已有待核对的交易，请先查询其回执，避免重复发送。');
      return;
    }
    const current = session.current;
    setQuote(null);
    await run('核验与估算', async () => {
      const prepared = await prepareClaim(connection, config, bundle, claim);
      if (current !== session.current) throw new WalletCheckError('钱包会话发生变化，请重新核验。');
      setQuote(prepared); setMessage('合约身份、分配清单和链上状态已核验。请检查下方交易预览。');
    });
  }
  async function checkReceipt(tx: Transaction, activeConnection = connection) {
    if (!activeConnection || !config) throw new WalletCheckError('请重新连接此网络的钱包，再查询回执。');
    try {
      const receipt = await waitForConfirmation(activeConnection, config, tx.quote, tx.hash);
      setTransaction({ ...tx, state: 'confirmed', detail: `区块 ${receipt.blockNumber} · 已达到 ${config.confirmations} 次确认，事件与领取状态一致。` });
      setQuote(null);
    } catch (error) {
      setTransaction({ ...tx, state: 'uncertain', detail: displayError(error) });
      throw error;
    }
  }
  async function submit() {
    if (!connection || !config || !bundle || !quote) return;
    await run('等待钱包确认', async () => {
      const activeConnection = connection;
      const txHash = await sendClaim(activeConnection, config, bundle, quote);
      const tx: Transaction = { hash: txHash, quote, state: 'pending', detail: '交易已提交，正在等待链上确认。' };
      setTransaction(tx); setQuote(null); setBusy('等待链上确认');
      await checkReceipt(tx, activeConnection);
    });
  }

  return <div className="shell">
    <header className="topbar"><a className="brand" href="./" aria-label="合芽钱包首页"><SproutMark/><strong>Heyuna <span>合芽</span></strong></a><span className="portal-title">奖励领取</span><div className="header-tools"><span className="network"><i/>{networkName(config)}</span><button className="icon-button" onClick={()=>setDark(!dark)} aria-label={dark?'使用浅色外观':'使用深色外观'}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button></div></header>
    <main><div className="page-heading"><div><h1>核验贡献，领取奖励</h1><p>公开清单、链上状态和签名确认，每一步由你掌握。</p></div><span className="testnet-label">研究测试用途</span></div>
      {!config&&<div className="deployment-notice" role="status"><ShieldCheck size={20}/><div><strong>奖励网络尚未就绪</strong><p>{configError} 公开部署通过核验后才能领取。</p></div></div>}
      {config&&isNative(config)&&config.profile==='accelerated-local'&&<div className="deployment-notice accelerated" role="status"><ShieldCheck size={20}/><div><strong>本地加速测试域 · 297012</strong><p>此域的挑战期为 3 秒，仅用于本机实验，不代表公开研究网的 72 小时安全参数。</p></div></div>}
      <div className="layout"><div className="steps">
        <section className="step"><div className="step-title"><span className={`step-number ${connection?'done':''}`}>{connection?<Check size={17}/>:'01'}</span><div><h2>连接钱包</h2><p>只请求账户授权，私钥留在你的钱包中。</p></div></div>
          {connection?<div className="connected"><Wallet size={21}/><div><span>已连接账户</span><code>{connection.account}</code></div><button className="quiet" disabled={!!busy} onClick={()=>{session.current+=1;setConnection(null);setQuote(null);setBalance(null);}}>断开页面连接</button></div>:<div className="connect-controls"><div className="hint">使用浏览器中已启用的兼容钱包</div><button className="primary" onClick={connectWallet} disabled={!config||!!busy}><Wallet size={17}/>连接钱包</button></div>}
          <p className="hint">请手动选择 {networkName(config)}{config?`（${config.chain_id}）`:''}。连接不会发送交易。</p>
        </section>
        <section className="step"><div className="step-title"><span className={`step-number ${bundle?'done':''}`}>{bundle?<Check size={17}/>:'02'}</span><div><h2>核对公开分配</h2><p>清单在此页面本地处理，不会上传到训练服务。</p></div></div>
          <label className={`file-control ${!config||busy?'disabled':''}`}><FileCheck2 size={26}/><span><strong>{filename||'选择奖励清单'}</strong><span>{bundle?`周期 ${bundle.manifest.epoch} · ${bundle.claims.length} 条分配 · 本地证明有效`:'JSON 文件 · 最大 5 MiB'}</span></span><ArrowUpRight size={17}/><input type="file" accept="application/json,.json" aria-label="选择奖励清单 JSON 文件" disabled={!config||!!busy} onChange={event=>void loadFile(event.target.files?.[0])}/></label>
          {bundle&&connection&&!claims.length&&<p className="hint">这份清单没有当前钱包的奖励，请核对账户和周期。</p>}
          {claims.length>0&&<label className="claim-select">选择领取项<select value={claim?.index??''} disabled={!!busy} onChange={event=>{setClaimIndex(event.target.value);setQuote(null);}}>{claims.map(row=><option key={row.index} value={row.index}>#{row.index} · {category(row)===0?'训练贡献':'独立验证'} · {formatUnits(row.amount,18)} tHEYUNA</option>)}</select></label>}
          <button className="secondary full" onClick={preview} disabled={!connection||!claim||!!busy}><ShieldCheck size={17}/>核验网络并预览费用</button>
        </section>
        <section className="step"><div className="step-title"><span className={`step-number ${transaction?.state==='confirmed'?'done':''}`}>{transaction?.state==='confirmed'?<Check size={17}/>:'03'}</span><div><h2>确认领取交易</h2><p>检查网络、收款账户和费用，再决定是否签名。</p></div></div>
          {quote&&config?<div className="quote"><div className="reward-amount"><span>本次领取</span><strong>{formatUnits(quote.claim.amount,18)} <small>tHEYUNA</small></strong></div><dl><div><dt>网络</dt><dd>{networkName(config)} · {config.chain_id}</dd></div>{isNative(config)&&<div><dt>创世哈希</dt><dd><code>{config.genesis_hash}</code></dd></div>}<div><dt>收款账户</dt><dd><code>{quote.account}</code></dd></div><div><dt>奖励库</dt><dd><code>{config.reward_vault_address}</code></dd></div><div><dt>最高网络费用</dt><dd>{formatEther(quote.maximumFee)} {feeSymbol(config)}</dd></div><div><dt>交易转出金额</dt><dd>0 {feeSymbol(config)}（另计费用）</dd></div>{'contribution_id' in quote.claim&&<div><dt>贡献 ID</dt><dd><code>{quote.claim.contribution_id}</code></dd></div>}</dl>{isNative(config)&&quote.maximumFee===0n&&<p className="hint">当前研究网络的 RPC 明确返回零费用；这是测试启动参数，不代表后续网络持续免费。</p>}<p className="hint">费用含 20% gas 预留，实际按链上消耗结算。预览 2 分钟有效；本次调用无需代币授权。</p><button className="primary full" disabled={!!busy} onClick={submit}>确认信息，在钱包中签名领取<ArrowUpRight size={17}/></button></div>:<div className="empty-preview"><ShieldCheck size={25}/><p>核验完成后显示交易预览</p><span>没有你的确认，不会发送交易。</span></div>}
          {transaction&&<div className={`transaction ${transaction.state}`} role="status"><div className="transaction-title">{transaction.state==='confirmed'?<CheckCircle2 size={20}/>:<span className="status-dot"/>}<strong>{transaction.state==='confirmed'?'链上已确认':transaction.state==='pending'?'已发送，待确认':'回执仍需核对'}</strong></div><p>{transaction.detail}</p><div className="transaction-hash"><span>交易 hash</span><code>{transaction.hash}</code></div>{config&&!isNative(config)&&<a href={`https://sepolia.etherscan.io/tx/${transaction.hash}`} target="_blank" rel="noopener noreferrer">在区块浏览器查看<ArrowUpRight size={15}/></a>}{transaction.state!=='confirmed'&&<button className="secondary" disabled={!!busy||!connection} onClick={()=>void run('查询交易回执',()=>checkReceipt(transaction))}>重新查询回执</button>}</div>}
        </section>
      </div><aside><section className="asset-card"><div className="asset-heading"><SproutMark/><div><h2>tHEYUNA</h2><p>{config&&!isNative(config)?'旧版 ERC-20 测试资产':'Heyuna 原生测试币'}</p></div></div><div className="asset-balance"><span>已核验钱包余额</span><strong>{balance===null?'—':formatUnits(balance,18)}</strong><small>{balance===null?'未核验':'当前钱包的链上原生余额'}</small></div><span className={`deployment-state ${config?'ready':''}`}>{config?'配置已载入 · 需独立链上核验':'未部署 / 未配置'}</span><dl className="identity"><div><dt>网络</dt><dd>{networkName(config)}</dd></div><div><dt>链 ID</dt><dd>{config?.chain_id??297011}</dd></div>{config&&isNative(config)?<><div><dt>创世哈希</dt><dd><code>{config.genesis_hash}</code></dd></div><div><dt>钱包链锚 · 区块 1</dt><dd><code>{config.evm_anchor.block_hash}</code></dd></div><div><dt>奖励库</dt><dd><code>{config.reward_vault_address}</code></dd></div></>:config?<div><dt>旧版代币合约</dt><dd><code>{config.token_address}</code></dd></div>:<div><dt>创世哈希 / 奖励库</dt><dd>尚未配置</dd></div>}<div><dt>确认要求</dt><dd>{config?`${config.confirmations} 个区块`:'待核验'}</dd></div></dl><p className="testnet-note">仅用于研究测试，不承诺兑换主网币。完成训练不等于链上奖励已到账。</p></section><div className="privacy"><ShieldCheck size={18}/><p>不要在任何页面输入助记词。训练进程和这个钱包页面不共享设备凭据。</p></div><details className="legacy-import"><summary>旧版 ERC-20 兼容</summary><p>仅供核对链 ID 11155111 的历史部署，网络费用使用 ETH。文件来源由你独立确认。</p><label className="legacy-file">导入旧版部署 JSON<input type="file" accept="application/json,.json" disabled={!!busy} onChange={event=>void importLegacy(event.target.files?.[0])}/></label></details></aside></div>
      <div className={`feedback ${message||busy?'visible':''}`} role="status" aria-live="polite">{busy?`${busy}…`:message}</div>
    </main><footer><span>Heyuna 合芽 · 研究测试网络</span><span>连接 / 核验 / 签名 / 确认</span></footer>
  </div>;
}
