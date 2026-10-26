import { invoke } from '@tauri-apps/api/core';

export const isDesktop = () => '__TAURI_INTERNALS__' in window;
export class ApiError extends Error { constructor(message: string, public status?: number) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (isDesktop()) {
    try { return await invoke<T>('api_request', { path, method, body: body ?? null }); }
    catch (error) { throw new ApiError(String(error)); }
  }
  let response: Response;
  try { response = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit' }); }
  catch { throw new ApiError('无法连接本地服务。请检查服务是否正在运行。'); }
  const data = await response.json().catch(() => ({ detail: `本地服务返回 ${response.status}` }));
  if (!response.ok) throw new ApiError(typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail ?? data), response.status);
  return data as T;
}
export async function chooseProject(): Promise<string | null> { return invoke('choose_project'); }
export async function openWallet(url: string): Promise<void> {
  if (isDesktop()) return invoke('open_wallet', { url });
  const parsed = new URL(url);
  if (url !== 'http://127.0.0.1:1421/') throw new Error('钱包链接不在允许列表中。');
  window.open(parsed.href, '_blank', 'noopener,noreferrer');
}

export interface Status {
  version: string; mode: string;
  model: { id: string; backend: string; ready: boolean; state: string; detail: string };
  sandbox: { available: boolean; detail: string };
  device: { platform: string; memory_gb: number };
  contribution: { enabled: boolean; state: string; detail?: string };
  network: { configured: boolean; connected?: boolean; endpoint?: string };
  current_task?: { task_id: string; round_id: string; data_source: string; data_license: string; data_hash: string; steps: number } | null;
  resources?: { rss_bytes: number; cpu_percent: number; elapsed_seconds: number };
  upload_bytes_today?: number;
  rewards: { chain_id: number; confirmed: string | number; pending: string | number; state: string; token_address?: string };
}
export interface Project { id: string; name: string; path: string; files: string[] }
export interface Task {
  id: string; status: string; events: { time: string; kind: string; message: string }[];
  changes: { path: string; before: string; after: string }[]; summary?: string; error?: string;
}
export interface Settings { start_time: string; end_time: string; max_cpu_percent: number; max_memory_gb: number; max_upload_mb_day: number; supported_limits?: string[] }
export interface Receipt { receipt_id: string; id?: string; task_id: string; status?: string; state?: string; detail?: string; created_at?: string; result_hash?: string; work_units?: number; reason?: string }
export interface RewardConfig { chain_id: number; profile?: 'research' | 'accelerated-local'; asset_kind?: 'native' | 'legacy-erc20'; symbol?: 'tHEYUNA'; decimals?: 18; network_name?: string; network?: string; network_domain?: string; deployment?: Record<string,unknown>; genesis_hash?: string | null; genesis_hash_kind?: 'sha256-canonical-genesis-json'; cosmos_rpc_url?: string | null; evm_anchor?: {block_number:1;block_hash:string}|null; rpc_url?: string | null; token_address?: string | null; rewards_address?: string | null; wallet_url?: string | null }
export const terminalTask = (state?: string) => ['completed', 'complete', 'failed', 'cancelled', 'canceled', 'applied', 'reverted', 'ready', 'review'].includes(state ?? '');
export const taskLabel = (state?: string) => ({ pending: '等待开始', queued: '等待开始', running: '正在执行', completed: '等待审查', complete: '等待审查', failed: '任务失败', cancelled: '已取消', canceled: '已取消', applied: '已应用', reverted: '已撤回', ready: '等待审查', review: '等待审查' }[state ?? ''] ?? state ?? '等待任务');
export const receiptLabel = (state?: string) => ({ computed: '计算完成', submitted: '待验证', pending: '待验证', pending_verification: '待验证', verified: '验证通过', accepted: '验证通过', settling: '待结算', pending_settlement: '待结算', claimable: '可领取', confirmed: '链上已确认', rejected: '未通过', failed: '失败' }[state ?? ''] ?? state ?? '未知状态');
export const formatAmount = (amount?: string | number) => amount === undefined ? '—' : String(amount);

export const contributionLabel = (state?: string) => ({ disabled: '已关闭', configured: '已配置', idle: '等待任务', connecting: '正在验证网络连接', training: '正在本机训练', submitting: '正在提交计算结果', pending_verification: '等待独立验证', verified: '验证通过', pending_settlement: '等待结算', paused_limits: '已按资源限制暂停', paused_assistant: '编程助手正在使用模型', stopping: '正在停止', error: '任务执行失败' }[state ?? ''] ?? state ?? '未连接');
export const formatBytes = (bytes?: number) => bytes === undefined ? '—' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
