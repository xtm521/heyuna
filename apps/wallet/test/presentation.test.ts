import { describe, expect, it } from 'vitest';
import { displayWalletError, WalletCheckError } from '../src/presentation';

describe('wallet error presentation', () => {
  it('keeps declined permission separate from a broken connection', () => {
    expect(displayWalletError({ code: 4001, message: 'Provider branded request rejected' })).toBe('你已取消钱包请求。');
    expect(displayWalletError({ code: 'NETWORK_ERROR', message: 'Provider branded connection failure' })).toContain('诊断代码：NETWORK_ERROR');
  });
  it('preserves local identity failures and hides unknown provider marketing text', () => {
    expect(displayWalletError(new WalletCheckError('共识节点创世哈希与可信网络清单不一致。'))).toContain('创世哈希');
    expect(displayWalletError(new Error('ProviderBrand connection error'))).toBe('钱包或节点请求失败，请检查连接后重试。');
  });
  it('accepts only finite integer or allowlisted diagnostic codes', () => {
    expect(displayWalletError({ code: 'GenericVendorCode_CONNECTION' })).not.toContain('GenericVendorCode');
    expect(displayWalletError({ code: -32603 })).toContain('诊断代码：-32603');
    for (const code of [Infinity, NaN, 1.5, '4001']) expect(displayWalletError({ code })).not.toContain('诊断代码');
  });
});
