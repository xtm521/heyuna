export class WalletCheckError extends Error {}
const standardDiagnosticCodes = new Set([
  'NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'BAD_DATA', 'CALL_EXCEPTION',
  'INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED',
  'TRANSACTION_REPLACED', 'UNSUPPORTED_OPERATION', 'INVALID_ARGUMENT',
  'UNCONFIGURED_NAME', 'OFFCHAIN_FAULT', 'CANCELLED', 'UNKNOWN_ERROR',
]);

export function displayWalletError(error: unknown): string {
  if (error instanceof WalletCheckError) return error.message;
  if (!error || typeof error !== 'object') return '操作失败，请检查钱包状态后重试。';
  const value = error as { code?: unknown };
  if (value.code === 4001 || value.code === 'ACTION_REJECTED') return '你已取消钱包请求。';
  if ((typeof value.code === 'number' && Number.isFinite(value.code) && Number.isInteger(value.code))
    || (typeof value.code === 'string' && standardDiagnosticCodes.has(value.code))) {
    const code = String(value.code);
    return `钱包或节点请求失败，请检查连接后重试。 诊断代码：${code}`;
  }
  return '钱包或节点请求失败，请检查连接后重试。';
}
