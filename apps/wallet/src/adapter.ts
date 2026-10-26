import { WalletCheckError } from './presentation';
// Versioned adapters: native is the default; v1 is only accepted by explicit import.
import * as legacy from './protocol';
import * as legacyWallet from './wallet';
import * as native from './nativeProtocol';
import * as nativeWallet from './nativeWallet';
export type Deployment=legacy.Deployment|native.NativeDeployment;
export type Bundle=legacy.Bundle|native.NativeBundle;
export type Quote=legacyWallet.Quote|nativeWallet.NativeQuote;
export type Claim=legacy.Claim|native.NativeClaim;
export const isNative=(value:Deployment):value is native.NativeDeployment=>value.version===2;
export function parseDeployment(input:unknown,allowLegacy=false):Deployment{
  if(input&&typeof input==='object'&&'version' in input&&input.version===1){if(!allowLegacy)throw new WalletCheckError('旧版 ERC-20 配置只能通过“导入旧版部署”显式读取。');return legacy.parseDeployment(input);}return native.parseNativeDeployment(input);
}
export const parseBundle=(text:string,config:Deployment):Bundle=>isNative(config)?native.parseNativeBundle(text,config):legacy.parseBundle(text,config);
export const connect=(injected:legacyWallet.InjectedProvider,config:Deployment)=>isNative(config)?nativeWallet.connectNative(injected,config):legacyWallet.connect(injected);
export const prepareClaim=(connection:legacyWallet.Connection,config:Deployment,bundle:Bundle,claim:Claim):Promise<Quote>=>isNative(config)?nativeWallet.prepareNativeClaim(connection,config,bundle as native.NativeBundle,claim as native.NativeClaim):legacyWallet.prepareClaim(connection,config,bundle as legacy.Bundle,claim as legacy.Claim);
export const sendClaim=(connection:legacyWallet.Connection,config:Deployment,bundle:Bundle,quote:Quote)=>isNative(config)?nativeWallet.sendNativeClaim(connection,config,bundle as native.NativeBundle,quote as nativeWallet.NativeQuote):legacyWallet.sendClaim(connection,config,bundle as legacy.Bundle,quote as legacyWallet.Quote);
export const waitForConfirmation=(connection:legacyWallet.Connection,config:Deployment,quote:Quote,hash:string)=>isNative(config)?nativeWallet.waitForNativeConfirmation(connection,config,quote as nativeWallet.NativeQuote,hash):legacyWallet.waitForConfirmation(connection,config,quote as legacyWallet.Quote,hash);
export const category=(claim:Claim)=>'category' in claim?claim.category:claim.kind;
export const networkName=(config:Deployment|null)=>config&&isNative(config)?config.profile==='accelerated-local'?'Heyuna 本地加速测试域':'Heyuna 研究测试网':config?'历史 ERC-20 测试网络 · 11155111':'Heyuna 研究测试网';
export const feeSymbol=(config:Deployment)=>isNative(config)?'tHEYUNA':'ETH（历史测试网络）';
export async function readVerifiedBalance(connection:legacyWallet.Connection,config:Deployment):Promise<bigint>{
  if(!isNative(config))throw new WalletCheckError('旧版代币余额请在钱包内查看。');
  await nativeWallet.verifyNativeDeployment(connection,config);const balance=await connection.provider.getBalance(connection.account); await nativeWallet.assertNativeAccount(connection,config); return balance;
}
