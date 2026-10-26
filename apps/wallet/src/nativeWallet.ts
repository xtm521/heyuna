import { WalletCheckError } from './presentation';
// SPDX-License-Identifier: Apache-2.0
import { BrowserProvider, Contract, Interface, getAddress, keccak256, sha256, toUtf8Bytes, toQuantity } from 'ethers';
import { type Connection, type InjectedProvider, type ReceiptEvidence } from './wallet';
import { canonicalJSON, PRECOMPILE, verifyNativeProof, type NativeBundle, type NativeClaim, type NativeDeployment } from './nativeProtocol';
export type NativeQuote={account:string;claim:NativeClaim;data:string;gasLimit:bigint;gasEstimate:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint|null;maximumFee:bigint;preparedAt:number;manifestHash:string;root:string};
export const NATIVE_REWARDS_ABI=[
  'function CONTRIBUTION_ORACLE() view returns (address)',
  'function isClaimed(uint256 epoch,uint256 index) view returns (bool)',
  'function claim(uint256 epoch,uint256 index,address recipient,uint8 category,uint256 amount,bytes32 contributionId,bytes32[] proof)',
  'event RewardClaimed(uint256 indexed epoch,uint256 indexed index,address indexed recipient,uint8 category,uint256 amount,bytes32 contributionId)',
];
export const ORACLE_ABI=['function getEpoch(uint256 epoch) view returns (bytes32 root,uint256 trainingBudget,uint256 verificationBudget,bool finalized)'];
export const nativeRewardsInterface=new Interface(NATIVE_REWARDS_ABI);
const genesisCache=new Map<string,number>();
export async function verifyCosmosGenesis(config:NativeDeployment):Promise<void>{
  const key=config.cosmos_rpc_url+'|'+config.cosmos_chain_id+'|'+config.genesis_hash;
  if((genesisCache.get(key)??0)>Date.now()-300000)return;
  const endpoint=new URL('genesis',config.cosmos_rpc_url.endsWith('/')?config.cosmos_rpc_url:config.cosmos_rpc_url+'/');
  const response=await fetch(endpoint,{credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
  if(!response.ok||!response.body)throw new WalletCheckError('无法读取共识节点创世数据，不能核验网络。');
  const reader=response.body.getReader();let size=0;const decoder=new TextDecoder();let text='';
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>5*1024*1024){await reader.cancel();throw new WalletCheckError('创世响应过大。');}text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
  const raw=JSON.parse(text),genesis=raw?.result?.genesis;
  if(!genesis||typeof genesis!=='object'||genesis.chain_id!==config.cosmos_chain_id||sha256(toUtf8Bytes(canonicalJSON(genesis)))!==config.genesis_hash)throw new WalletCheckError('共识节点创世哈希与可信网络清单不一致。');
  genesisCache.set(key,Date.now());
}
export async function assertNativeChain(injected:InjectedProvider,config:NativeDeployment):Promise<void>{
  const chain=await injected.request({method:'eth_chainId'});
  if(typeof chain!=='string'||!/^0x[0-9a-fA-F]+$/.test(chain)||BigInt(chain)!==BigInt(config.chain_id))throw new WalletCheckError(`钱包网络不匹配。请手动选择链 ID ${config.chain_id} 对应的网络。`);
  await verifyCosmosGenesis(config);
  const anchor=await injected.request({method:'eth_getBlockByNumber',params:['0x1',false]});
  if(!anchor||typeof anchor!=='object'||!('hash' in anchor)||typeof anchor.hash!=='string'||anchor.hash.toLowerCase()!==config.evm_anchor.block_hash)throw new WalletCheckError('钱包 RPC 的首块锚与可信网络清单不一致。');
}
export async function connectNative(injected:InjectedProvider,config:NativeDeployment):Promise<Connection>{
  await assertNativeChain(injected,config);
  const accounts=await injected.request({method:'eth_requestAccounts'});
  if(!Array.isArray(accounts)||typeof accounts[0]!=='string')throw new WalletCheckError('钱包没有返回授权账户。');
  await assertNativeChain(injected,config);
  return {injected,provider:new BrowserProvider(injected,'any'),account:getAddress(accounts[0])};
}
export async function assertNativeAccount(connection:Connection,config:NativeDeployment){
  await assertNativeChain(connection.injected,config);const accounts=await connection.injected.request({method:'eth_accounts'});
  if(!Array.isArray(accounts)||typeof accounts[0]!=='string'||getAddress(accounts[0])!==connection.account)throw new WalletCheckError('钱包账户已变化，请重新连接并核验。');
}
export async function verifyNativeDeployment(connection:Connection,config:NativeDeployment):Promise<void>{
  await assertNativeAccount(connection,config);
  for(const [target,expected] of [[config.reward_vault_address,config.code_hashes.reward_vault],[config.public_fund_address,config.code_hashes.public_fund],[config.factory_address,config.code_hashes.factory]]){
    const code=await connection.provider.getCode(target);if(code==='0x'||keccak256(code)!==expected)throw new WalletCheckError(`合约运行时代码不匹配：${target}`);
  }
  const reward=new Contract(config.reward_vault_address,NATIVE_REWARDS_ABI,connection.provider);
  if(getAddress(await reward.CONTRIBUTION_ORACLE())!==PRECOMPILE)throw new WalletCheckError('奖励库引用的贡献预编译地址不匹配。');
}
export function validateNativeClaimIdentity(bundle:NativeBundle,config:NativeDeployment,claim:NativeClaim,account:string){
  const row=bundle.claims.find(entry=>entry.index===claim.index);
  if(bundle.manifest.chain_id!==config.chain_id||bundle.manifest.genesis_hash!==config.genesis_hash||bundle.manifest.reward_vault!==config.reward_vault_address.toLowerCase()||!row||JSON.stringify(row)!==JSON.stringify(claim)||claim.epoch!==bundle.manifest.epoch||getAddress(claim.recipient)!==getAddress(account)||!verifyNativeProof(config.chain_id,config.reward_vault_address,claim,bundle.root))throw new WalletCheckError('领取证明与当前网络、账户或贡献身份不一致。');
}
export async function validateNativeOnChain(connection:Connection,config:NativeDeployment,bundle:NativeBundle,claim:NativeClaim){
  validateNativeClaimIdentity(bundle,config,claim,connection.account);await verifyNativeDeployment(connection,config);
  const oracle=new Contract(PRECOMPILE,ORACLE_ABI,connection.provider),reward=new Contract(config.reward_vault_address,NATIVE_REWARDS_ABI,connection.provider);
  const [epoch,claimed]=await Promise.all([oracle.getEpoch(claim.epoch),reward.isClaimed(claim.epoch,claim.index)]);
  if(!epoch.finalized)throw new WalletCheckError('本周期尚未完成挑战期及最终确认。');
  if(epoch.root.toLowerCase()!==bundle.root||epoch.trainingBudget!==bundle.trainingAmount||epoch.verificationBudget!==bundle.validationAmount)throw new WalletCheckError('链上根或类别分配金额与清单不一致。');
  if(claimed)throw new WalletCheckError('此条奖励已在链上领取。');
}
export async function prepareNativeClaim(connection:Connection,config:NativeDeployment,bundle:NativeBundle,claim:NativeClaim):Promise<NativeQuote>{
  await validateNativeOnChain(connection,config,bundle,claim);
  const data=nativeRewardsInterface.encodeFunctionData('claim',[claim.epoch,claim.index,claim.recipient,claim.category,claim.amount,claim.contribution_id,claim.proof]);
  const gasEstimate=await connection.provider.estimateGas({from:connection.account,to:config.reward_vault_address,data,value:0n});const gasLimit=(gasEstimate*120n+99n)/100n;
  if(gasLimit>1_000_000n)throw new WalletCheckError('费用估算异常，停止发送。');
  const fees=await connection.provider.getFeeData(),maxFeePerGas=fees.maxFeePerGas??fees.gasPrice,maxPriorityFeePerGas=fees.maxFeePerGas!==null?fees.maxPriorityFeePerGas:null;
  if(maxFeePerGas===null||maxFeePerGas<0n||(fees.maxFeePerGas!==null&&(maxPriorityFeePerGas===null||maxPriorityFeePerGas<0n||maxPriorityFeePerGas>maxFeePerGas)))throw new WalletCheckError('钱包未提供完整的网络费用估算。');
  return {account:connection.account,claim,data,gasLimit,gasEstimate,maxFeePerGas,maxPriorityFeePerGas,maximumFee:gasLimit*maxFeePerGas,preparedAt:Date.now(),manifestHash:bundle.manifestHash,root:bundle.root};
}
function fresh(quote:NativeQuote){if(Date.now()<quote.preparedAt||Date.now()-quote.preparedAt>120000)throw new WalletCheckError('费用预览已过期，请重新核验。');}
export async function sendNativeClaim(connection:Connection,config:NativeDeployment,bundle:NativeBundle,quote:NativeQuote):Promise<string>{
  fresh(quote);if(quote.account!==connection.account||quote.root!==bundle.root||quote.manifestHash!==bundle.manifestHash)throw new WalletCheckError('领取预览已失效。');
  await validateNativeOnChain(connection,config,bundle,quote.claim);await assertNativeAccount(connection,config);
  const c=quote.claim,data=nativeRewardsInterface.encodeFunctionData('claim',[c.epoch,c.index,c.recipient,c.category,c.amount,c.contribution_id,c.proof]);
  if(data!==quote.data)throw new WalletCheckError('交易内容与已预览内容不一致。');fresh(quote);
  const tx:Record<string,string>={from:connection.account,to:config.reward_vault_address,chainId:toQuantity(config.chain_id),data,value:'0x0',gas:toQuantity(quote.gasLimit)};
  if(quote.maxPriorityFeePerGas!==null){tx.maxFeePerGas=toQuantity(quote.maxFeePerGas);tx.maxPriorityFeePerGas=toQuantity(quote.maxPriorityFeePerGas);}else tx.gasPrice=toQuantity(quote.maxFeePerGas);
  const result=await connection.injected.request({method:'eth_sendTransaction',params:[tx]});if(typeof result!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(result))throw new WalletCheckError('钱包未返回有效交易 hash，请先核对钱包记录。');return result;
}
export function verifyNativeReceipt(receipt:ReceiptEvidence,config:NativeDeployment,quote:NativeQuote){
  if(receipt.status!==1||!receipt.to||getAddress(receipt.to)!==config.reward_vault_address||getAddress(receipt.from)!==quote.account)throw new WalletCheckError('交易回执失败或不属于此领取。');
  const c=quote.claim,matched=receipt.logs.some(log=>{try{if(getAddress(log.address)!==config.reward_vault_address)return false;const e=nativeRewardsInterface.parseLog({topics:[...log.topics],data:log.data});return e?.name==='RewardClaimed'&&e.args.epoch===BigInt(c.epoch)&&e.args.index===BigInt(c.index)&&getAddress(e.args.recipient)===getAddress(c.recipient)&&e.args.category===BigInt(c.category)&&e.args.amount===BigInt(c.amount)&&e.args.contributionId.toLowerCase()===c.contribution_id;}catch{return false;}});
  if(!matched)throw new WalletCheckError('回执缺少匹配贡献身份的 RewardClaimed 事件。');
}
export async function waitForNativeConfirmation(connection:Connection,config:NativeDeployment,quote:NativeQuote,txHash:string){
  await assertNativeChain(connection.injected,config);const receipt=await connection.provider.waitForTransaction(txHash,config.confirmations,180000);if(!receipt)throw new WalletCheckError('等待确认超时。请保留交易 hash，稍后查询，避免重复发送。');
  await assertNativeChain(connection.injected,config);verifyNativeReceipt(receipt,config,quote);
  const block=await connection.provider.getBlock(receipt.blockNumber);if(!block||block.hash!==receipt.blockHash)throw new WalletCheckError('区块发生变化，需要重新确认。');
  const reward=new Contract(config.reward_vault_address,NATIVE_REWARDS_ABI,connection.provider);if(!await reward.isClaimed(quote.claim.epoch,quote.claim.index))throw new WalletCheckError('领取状态与回执不一致。');return receipt;
}
