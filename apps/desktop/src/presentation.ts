import type { Status } from './api';

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
