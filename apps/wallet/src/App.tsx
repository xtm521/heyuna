// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, CheckCircle2, FileCheck2, Leaf, Moon, ShieldCheck, Sun, Wallet } from 'lucide-react';
import { formatEther, formatUnits } from 'ethers';
import { MAX_FILE_BYTES, parseBundle, parseDeployment, type Bundle, type Deployment } from './protocol';
import { connect, prepareClaim, sendClaim, waitForConfirmation, type Connection, type InjectedProvider, type Quote } from './wallet';

declare global { interface Window { ethereum?: InjectedProvider; okxwallet?: InjectedProvider } }
type Transaction = { hash: string; quote: Quote; state: 'pending' | 'confirmed' | 'uncertain'; detail: string };
const displayError = (error: unknown) => error instanceof Error ? error.message : '操作失败，请检查钱包状态后重试。';
const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;

export function App() {
  const [config, setConfig] = useState<Deployment | null>(null);
  const [configError, setConfigError] = useState('正在读取公开部署配置…');
  const [walletKind, setWalletKind] = useState('injected');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [filename, setFilename] = useState('');
  const [claimIndex, setClaimIndex] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('heyuna-wallet-theme') === 'dark');
  const session = useRef(0);
  const claims = bundle?.claims.filter((claim) => claim.recipient === connection?.account) ?? [];
  const claim = claims.find((row) => row.index === claimIndex) ?? claims[0];

  useEffect(() => {
    let active = true;
    fetch('./deployment.json', { cache: 'no-store', credentials: 'omit' }).then(async (response) => {
      if (!response.ok) throw new Error('无法读取公开部署配置。');
      const text = await response.text();
      if (text.length > 32768) throw new Error('部署配置过大。');
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
      setConnection(null); setQuote(null);
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
  async function connectWallet() {
    await run('连接钱包', async () => {
      const injected = walletKind === 'okx' ? window.okxwallet : window.ethereum;
      if (!injected) throw new Error(walletKind === 'okx' ? '未发现 OKX 钱包扩展。请安装后刷新此页。' : '未发现兼容 EIP-1193 的钱包扩展。请使用安装了钱包的系统浏览器。');
      session.current += 1;
      const connected = await connect(injected);
      setConnection(connected); setQuote(null);
      setMessage('钱包已连接。连接操作没有签名或发送交易。');
    });
  }
  async function loadFile(file?: File) {
    if (!file || !config) return;
    setBundle(null); setFilename(''); setQuote(null);
    await run('读取清单', async () => {
      if (file.size > MAX_FILE_BYTES) throw new Error('分配清单不能超过 5 MiB。');
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
      if (current !== session.current) throw new Error('钱包会话发生变化，请重新核验。');
      setQuote(prepared); setMessage('合约身份、分配清单和链上状态已核验。请检查下方交易预览。');
    });
  }
  async function checkReceipt(tx: Transaction, activeConnection = connection) {
    if (!activeConnection || !config) throw new Error('请重新连接 Sepolia 钱包，再查询回执。');
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
    <header className="topbar"><a className="brand" href="./" aria-label="合芽钱包首页"><span className="brand-mark"><Leaf size={22} /></span><strong>合芽 <span>Heyuna</span></strong></a><div className="header-tools"><span className="network"><i />Sepolia 测试网</span><button className="icon-button" onClick={() => setDark(!dark)} aria-label={dark ? '使用浅色外观' : '使用深色外观'}>{dark ? <Sun size={20} /> : <Moon size={20} />}</button></div></header>
    <main><div className="page-heading"><span className="eyebrow">CONTRIBUTION REWARDS</span><h1>把贡献，带回你的钱包。</h1><p>独立核对每一份奖励，由你决定何时签名领取。</p></div>
      {!config && <div className="deployment-notice" role="status"><ShieldCheck size={22} /><div><strong>奖励网络尚未就绪</strong><p>{configError} 领取将在公开部署信息通过核验后开放。</p></div></div>}
      <div className="layout"><div className="steps">
        <section className="step"><div className="step-title"><span className={`step-number ${connection ? 'done' : ''}`}>{connection ? <Check size={18} /> : '01'}</span><div><h2>连接你的钱包</h2><p>使用独立浏览器钱包，私钥始终留在钱包中。</p></div></div>
          {connection ? <div className="connected"><Wallet size={22} /><div><span>已连接账户</span><code>{connection.account}</code></div><button className="quiet" disabled={!!busy} onClick={() => { session.current += 1; setConnection(null); setQuote(null); }}>断开页面连接</button></div> : <div className="connect-controls"><label>钱包<select value={walletKind} onChange={(event) => setWalletKind(event.target.value)} disabled={!!busy}><option value="injected">浏览器钱包 · 通用</option><option value="okx">OKX 钱包</option></select></label><button className="primary" onClick={connectWallet} disabled={!config || !!busy}><Wallet size={18} />连接钱包</button></div>}
          <p className="hint">请先在钱包中选择 Ethereum Sepolia。连接账户不会发送交易。</p>
        </section>
        <section className="step"><div className="step-title"><span className={`step-number ${bundle ? 'done' : ''}`}>{bundle ? <Check size={18} /> : '02'}</span><div><h2>核对公开分配清单</h2><p>文件仅在此页面处理，不会上传到训练服务。</p></div></div>
          <label className={`file-control ${!config || busy ? 'disabled' : ''}`}><FileCheck2 size={28} /><span><strong>{filename || '选择奖励清单 JSON 文件'}</strong><span>{bundle ? `第 ${bundle.manifest.epoch} 周期 · ${bundle.claims.length} 条分配 · 本地证明有效` : '包含 manifest、root、manifestHash 与 claims · 最大 5 MiB'}</span></span><input type="file" accept="application/json,.json" aria-label="选择奖励清单 JSON 文件" disabled={!config || !!busy} onChange={(event) => void loadFile(event.target.files?.[0])} /></label>
          {bundle && connection && !claims.length && <p className="hint">这份清单中没有当前钱包的奖励。请检查账户与清单周期。</p>}
          {claims.length > 0 && <label className="claim-select">选择领取项<select value={claim?.index ?? ''} disabled={!!busy} onChange={(event) => { setClaimIndex(event.target.value); setQuote(null); }}>{claims.map((row) => <option key={row.index} value={row.index}>#{row.index} · {row.kind === 0 ? '训练贡献' : '独立验证'} · {formatUnits(row.amount, 18)} tHEYUNA</option>)}</select></label>}
          <button className="secondary full" onClick={preview} disabled={!connection || !claim || !!busy}><ShieldCheck size={18} />核验合约并预览费用</button>
        </section>
        <section className="step"><div className="step-title"><span className={`step-number ${transaction?.state === 'confirmed' ? 'done' : ''}`}>{transaction?.state === 'confirmed' ? <Check size={18} /> : '03'}</span><div><h2>确认后，再领取</h2><p>签名前检查收款账户、合约和最高网络费用。</p></div></div>
          {quote && config ? <div className="quote"><div className="reward-amount"><span>本次领取</span><strong>{formatUnits(quote.claim.amount, 18)} <small>tHEYUNA</small></strong></div><dl><div><dt>网络</dt><dd>Ethereum Sepolia · 11155111</dd></div><div><dt>收款账户</dt><dd><code>{quote.account}</code></dd></div><div><dt>奖励库合约</dt><dd><code>{config.reward_vault_address}</code></dd></div><div><dt>最高网络费用</dt><dd>{formatEther(quote.maximumFee)} Sepolia ETH</dd></div><div><dt>交易转出 ETH</dt><dd>0 ETH（另计网络费用）</dd></div></dl><p className="hint">费用包含 20% gas 预留，实际按链上消耗结算。预览 2 分钟有效。不会请求代币授权。</p><button className="primary full" disabled={!!busy} onClick={submit}>确认信息，在钱包中签名领取<ArrowUpRight size={18} /></button></div> : <div className="empty-preview"><ShieldCheck size={28} /><p>完成前两步后，在这里查看交易预览。</p><span>没有你的确认，不会发送交易。</span></div>}
          {transaction && <div className={`transaction ${transaction.state}`} role="status"><div className="transaction-title">{transaction.state === 'confirmed' ? <CheckCircle2 size={20} /> : <span className="status-dot" />}<strong>{transaction.state === 'confirmed' ? '链上已确认' : transaction.state === 'pending' ? '已发送，待确认' : '回执仍需核对'}</strong></div><p>{transaction.detail}</p><a href={`https://sepolia.etherscan.io/tx/${transaction.hash}`} target="_blank" rel="noopener noreferrer">在区块浏览器查看 <code>{short(transaction.hash)}</code><ArrowUpRight size={15} /></a>{transaction.state !== 'confirmed' && <button className="secondary" disabled={!!busy || !connection} onClick={() => void run('查询交易回执', () => checkReceipt(transaction))}>重新查询回执</button>}</div>}
        </section>
      </div><aside><section className="asset-card"><div className="asset-symbol"><Leaf size={28} /></div><span className="eyebrow">HEYUNA NETWORK</span><h2>合芽测试币</h2><p className="asset-ticker">tHEYUNA</p><span className={`deployment-state ${config ? 'ready' : ''}`}>{config ? '配置已载入 · 待链上核验' : '未部署 / 未配置'}</span><div className="supply"><span>协议固定总量</span><strong>20,000,000 <small>枚</small></strong></div><dl className="identity"><div><dt>网络</dt><dd>Ethereum Sepolia</dd></div><div><dt>代币合约</dt><dd><code>{config?.token_address ?? '尚未配置'}</code></dd></div><div><dt>确认要求</dt><dd>{config ? `${config.confirmations} 个区块确认` : '部署后核对'}</dd></div></dl><p className="testnet-note">仅用于测试。没有标示币价，不承诺兑换主网币。已完成训练不等于链上奖励已到账。</p></section><div className="privacy"><ShieldCheck size={20} /><p>本页面只读取公开配置和钱包授权账户。训练进程不会接触钱包密钥。</p></div></aside></div>
      <div className={`feedback ${message ? 'visible' : ''}`} role="status" aria-live="polite">{busy ? `${busy}…` : message}</div>
    </main><footer><span>合芽网络 · 受邀测试网</span><span>连接 · 核验 · 签名 · 确认</span></footer>
  </div>;
}
