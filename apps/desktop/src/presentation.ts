import { ApiError, type Status } from './api';

// Presentation labels never change the fixed model identity used by the service.
export const modelStateLabel = (state?: string) => ({
  missing: '待下载', downloading: '下载中', downloaded: '已准备', loading: '加载中',
  ready: '就绪', generating: '生成中', error: '需要处理',
}[state ?? ''] ?? '待检测');
export const modelBackendLabel = (backend?: string) => ({
  mlx: '本机加速', cuda: '显卡加速', torch: '本机张量计算', unsupported: '当前设备不支持',
}[backend ?? ''] ?? '待检测');
export function modelSummary(model?: Status['model']): string {
  if (!model) return '连接本地服务后检查模型。';
  if (model.state === 'error') return '本地模型暂不可用，请查看技术诊断。';
  if (model.state === 'missing') return '模型尚未下载；需要约 8 GB 磁盘空间。';
  if (model.state === 'downloading') return '正在下载并校验固定版本的模型文件。';
  if (model.state === 'loading') return '正在校验并加载本地模型。';
  if (model.state === 'generating') return '正在本机生成，项目内容不会发送到云端。';
  return model.ready ? '本地模型已准备，可用于编程与受邀共训任务。' : '正在检查本地模型的可用状态。';
}

export function contributionSummary(contribution?: Status['contribution']): string {
  if (!contribution?.enabled) return '贡献默认关闭。开启后仍需领取并验证真实任务。';
  return ({
    configured: '参与方式已配置，等待领取真实任务。', idle: '当前没有运行中的训练任务。',
    connecting: '正在核验协调服务与任务网络。', training: '正在本机执行已校验的训练任务。',
    submitting: '正在提交结果摘要，仍需独立验收。', pending_verification: '结果已提交，等待独立验收。',
    verified: '贡献已通过验收，等待奖励结算。', pending_settlement: '贡献正在等待奖励结算。',
    paused_limits: '已按资源或时段限制暂停新任务。', paused_assistant: '编程助手正在使用本地模型，暂停领取新任务。',
    stopping: '正在停止本机任务，请稍候。', error: '本次贡献未能完成，请检查网络与设备状态。',
  }[contribution.state] ?? '按已配置的时段与资源限制参与。');
}

export function requestErrorSummary(error: unknown): string {
  if (!(error instanceof ApiError)) return '操作未完成，请重试。技术诊断请查看本地服务日志。';
  const status = error.status;
  if (status === undefined) return '本地请求未完成，请检查连接与当前状态。技术诊断请查看本地服务日志。';
  const reason = ({
    400: '请求内容无效，请检查输入。', 401: '本地服务授权已失效，请重新打开应用。',
    403: '本地服务拒绝了此操作，请检查访问权限。', 404: '请求的项目或任务不存在，请刷新后重试。',
    409: '当前状态不允许此操作，请刷新后重试。', 413: '提交内容过大，请缩小后重试。',
    422: '提交内容未通过校验，请检查输入。', 429: '请求过于频繁，请稍后重试。',
    503: '本地服务暂不可用，请稍后重试。',
  }[status] ?? '本地服务未能完成请求，请稍后重试。');
  const diagnostic = Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}；` : '';
  return `${reason}${diagnostic}技术诊断请查看本地服务日志。`;
}
