import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { api, receiptLabel } from '../src/api';
import { registerEffect } from '../src/components/effects';

vi.mock('../src/api', async importOriginal => ({ ...(await importOriginal<typeof import('../src/api')>()), api: vi.fn(), isDesktop: () => false }));
vi.mock('@monaco-editor/react', () => ({ default: ({ value }: { value: string }) => <pre aria-label="代码查看器">{value}</pre>, DiffEditor: ({ original, modified }: { original: string; modified: string }) => <div aria-label="变更对比"><pre>{original}</pre><pre>{modified}</pre></div> }));
const status = { version: '0.1.0', mode: 'alpha', model: { id: 'Qwen/Qwen3-4B-Instruct-2507', backend: 'mlx', ready: true, state: 'ready', detail: 'Ready' }, sandbox: { available: true, detail: 'Docker' }, device: { platform: 'darwin', memory_gb: 32 }, contribution: { enabled: false, state: 'disabled' }, network: { configured: false }, rewards: { chain_id: 11155111, confirmed: '0', pending: '0', state: 'unconfigured' } };
const project = { id: 'project_1', name: 'demo', path: '/tmp/demo', files: ['main.py'] };
const task = { id: 'task_1', status: 'completed', events: [{ time: '', kind: 'test', message: '1 test passed' }], changes: [{ path: 'main.py', before: 'old', after: 'new' }], summary: 'A real test task' };
beforeEach(() => { vi.mocked(api).mockImplementation(async path => {
  if (path === '/status') return status;
  if (path === '/projects/open') return project;
  if (path.startsWith('/projects/')) return { path: 'main.py', content: 'old' };
  if (path === '/agent/tasks' || path === '/agent/tasks/task_1') return task;
  if (path === '/rewards/config') return { chain_id: 11155111, token_address: null, rewards_address: null, wallet_url: null };
  if (path === '/network/receipts') return [];
  return {};
}); });
async function selectProject() {
  await screen.findByText('本地服务已连接');
  fireEvent.click(screen.getAllByRole('button', { name: '打开项目' })[0]);
  fireEvent.change(screen.getByLabelText('项目文件夹'), { target: { value: '/tmp/demo' } });
  const dialog = screen.getByRole('dialog');
  fireEvent.submit(dialog.querySelector('form')!);
  await screen.findByText('demo');
}

describe('honest desktop states', () => {
  it('does not fabricate a connection or let an offline device run tasks', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Backend offline'));
    render(<App />);
    await screen.findByText('Backend offline');
    expect(screen.getByText('本地服务未连接')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交编程任务' })).toBeDisabled();
    expect(screen.queryByText('本地服务已连接')).not.toBeInTheDocument();
  });
  it('disables wallet actions when deployment is missing', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '奖励钱包' }));
    await screen.findByText('奖励合约尚未部署或未配置');
    expect(screen.getByRole('button', { name: '前往外部钱包' })).toBeDisabled();
    expect(screen.queryByText('钱包已连接')).not.toBeInTheDocument();
  });
  it('requires diff review before applying a completed task', async () => {
    render(<App />); await selectProject();
    fireEvent.change(screen.getByLabelText('编程任务'), { target: { value: 'Fix the project' } });
    fireEvent.click(screen.getByRole('button', { name: '提交编程任务' }));
    await screen.findByText('1 test passed');
    expect(screen.getByRole('button', { name: '应用已审查变更' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '审查 1 个文件' }));
    expect(screen.getByRole('button', { name: '应用已审查变更' })).toBeEnabled();
    expect(screen.getByLabelText('变更对比')).toHaveTextContent('oldnew');
    fireEvent.click(screen.getByRole('button', { name: '应用已审查变更' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/agent/tasks/task_1/apply', 'POST'));
  });
  it('keeps contribution opt-in disabled until model and network are ready', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '训练中心' }));
    await screen.findByText('设备由你掌控');
    expect(screen.getByRole('button', { name: '开启算力贡献' })).toBeDisabled();
    expect(api).not.toHaveBeenCalledWith('/network/contribution', 'POST', expect.anything());
  });
  it('always permits stopping an enabled contribution after prerequisites become unavailable', async () => {
    vi.mocked(api).mockImplementation(async path => path === '/status' ? { ...status, model: { ...status.model, ready: false }, contribution: { enabled: true, state: 'error' } } : []);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '训练中心' }));
    const stop = await screen.findByRole('button', { name: '暂停贡献' });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/network/contribution', 'POST', { enabled: false }));
  });
  it('returns keyboard focus to the opener after closing the project dialog', async () => {
    render(<App />); await screen.findByText('本地服务已连接');
    const opener = screen.getAllByRole('button', { name: '打开项目' })[0];
    opener.focus(); fireEvent.click(opener);
    expect(screen.getByLabelText('项目文件夹')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
  it('submits only writable settings and marks unsupported CPU limits disabled', async () => {
    const stored = { start_time: '22:00', end_time: '07:00', max_cpu_percent: 50, max_memory_gb: 24, max_upload_mb_day: 1024, supported_limits: ['start_time', 'end_time', 'max_memory_gb', 'max_upload_mb_day'], detail: 'CPU is sampled' };
    vi.mocked(api).mockImplementation(async path => path === '/status' ? status : stored);
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '网络与设置' }));
    await screen.findByLabelText('开始时间');
    expect(screen.getByLabelText('CPU 上限（% · 未支持时禁用）')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存资源限制' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/settings', 'PUT', { start_time: '22:00', end_time: '07:00', max_cpu_percent: 50, max_memory_gb: 24, max_upload_mb_day: 1024 }));
  });
  it('keeps receipt phases distinct and preserves unknown states', () => {
    expect(receiptLabel('computed')).toBe('计算完成');
    expect(receiptLabel('pending_verification')).toBe('待验证');
    expect(receiptLabel('verified')).toBe('验证通过');
    expect(receiptLabel('pending_settlement')).toBe('待结算');
    expect(receiptLabel('confirmed')).toBe('链上已确认');
    expect(receiptLabel('unsupported')).toBe('unsupported');
  });
  it('renders protocol receipt IDs and real pending states returned by the service', async () => {
    vi.mocked(api).mockImplementation(async path => path === '/status' ? status : [
      { receipt_id: 'r_1', task_id: 'train_123', status: 'pending_verification', work_units: 0, reason: 'Awaiting the independent verifier' },
      { receipt_id: 'r_2', task_id: 'train_456', status: 'pending_settlement', work_units: 128, reason: 'Awaiting the reward epoch' },
    ]);
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '贡献记录' }));
    await screen.findByText('2 条回执');
    expect(screen.getByText('待验证')).toBeInTheDocument();
    expect(screen.getByText('待结算')).toBeInTheDocument();
    expect(screen.getByText('train_123')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
  });
  it('persists text-size preference without storing service credentials', async () => {
    render(<App />); fireEvent.click(screen.getByRole('button', { name: '网络与设置' }));
    fireEvent.change(screen.getByLabelText('文字大小'), { target: { value: '2' } });
    expect(document.documentElement.style.getPropertyValue('--text-scale')).toBe('2');
    expect(localStorage.getItem('heyuna-text-scale')).toBe('2');
    expect(Object.keys(localStorage).sort()).toEqual(['heyuna-text-scale', 'heyuna-theme']);
  });
});

it('defaults to dark but preserves an explicitly selected light theme', async () => {
  localStorage.setItem('heyuna-theme', 'light');
  render(<App />); await screen.findByText('本地服务已连接');
  expect(document.documentElement.dataset.theme).toBe('light');
  fireEvent.click(screen.getByRole('button', { name: '切换深色主题' }));
  expect(localStorage.getItem('heyuna-theme')).toBe('dark');
});
it('never presents backend placeholder zero as a verified native wallet balance', async () => {
  vi.mocked(api).mockImplementation(async path => path === '/status' ? { ...status, rewards: { chain_id: 297011, state: 'configured_unverified', confirmed: '0', pending: '0' } } : { chain_id: 297011, asset_kind: 'native', profile: 'research', genesis_hash: `0x${'a'.repeat(64)}`, rewards_address: '0x1234', wallet_url: 'http://127.0.0.1:1421/' });
  render(<App />); fireEvent.click(screen.getByRole('button', { name: '奖励钱包' }));
  await screen.findByText('297011');
  expect(screen.getByLabelText('余额未核验')).toHaveTextContent('—');
  expect(screen.getByText('未核验 · 请在外部钱包读取链上余额')).toBeInTheDocument();
});
it('separates configured network from connection and actual training', async () => {
  vi.mocked(api).mockImplementation(async path => path === '/status' ? { ...status, network: { configured: true, connected: false }, resources: { rss_bytes: 0, cpu_percent: 0, elapsed_seconds: 0 } } : []);
  render(<App />); fireEvent.click(screen.getByRole('button', { name: '训练中心' }));
  await screen.findByText('已配置');
  expect(screen.getByText('未连接')).toBeInTheDocument();
  expect(screen.getByText('未在训练')).toBeInTheDocument();
  expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
});

it('disposes visual resources before the task request reaches the service', async () => {
  render(<App />); await selectProject();
  const order: string[] = []; const unregister=registerEffect(()=>order.push('disposed'));
  const base=vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (...args)=>{if(args[0]==='/agent/tasks')order.push('request');return base(...args);});
  fireEvent.change(screen.getByLabelText('编程任务'),{target:{value:'Check the project'}});
  fireEvent.click(screen.getByRole('button',{name:'提交编程任务'}));
  await screen.findByText('1 test passed');
  expect(order).toEqual(['disposed','request']);unregister();
});
it('disposes visual resources before opting into contribution', async () => {
  const base=vi.mocked(api).getMockImplementation()!;const order: string[]=[];
  vi.mocked(api).mockImplementation(async (...args)=>{if(args[0]==='/status')return {...status,network:{configured:true,connected:false}};if(args[0]==='/network/contribution')order.push('request');return base(...args);});
  render(<App />);fireEvent.click(screen.getByRole('button',{name:'训练中心'}));await screen.findByText('已配置');
  const unregister=registerEffect(()=>order.push('disposed'));
  fireEvent.click(screen.getByRole('button',{name:'开启算力贡献'}));
  await waitFor(()=>expect(order).toEqual(['disposed','request']));unregister();
});
