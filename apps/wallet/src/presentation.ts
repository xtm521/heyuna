export class WalletCheckError extends Error {}

export function displayWalletError(error: unknown): string {
  if (error instanceof WalletCheckError) return error.message;
  if (!error || typeof error !== 'object') return '操作失败，请检查钱包状态后重试。';
  const value = error as { code?: unknown };
  if (value.code === 4001 || value.code === 'ACTION_REJECTED') return '你已取消钱包请求。';
  if (typeof value.code === 'number' || typeof value.code === 'string') {
    const code = String(value.code);
    return `钱包或节点请求失败，请检查连接后重试。${/^[A-Za-z0-9_-]{1,40}$/.test(code) ? ` 诊断代码：${code}` : ''}`;
  }
  return '钱包或节点请求失败，请检查连接后重试。';
}
