import { WalletCheckError } from './presentation';
// SPDX-License-Identifier: Apache-2.0
import { AbiCoder, concat, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { address, hash, uint, MAX_FILE_BYTES, TOTAL_SUPPLY } from './protocol';
export const NATIVE_CHAINS = [297011,297012] as const;
export const PRECOMPILE = '0x0000000000000000000000000000000000000900';
export type NativeDeployment = { version:2; profile:'research'|'accelerated-local'; chain_id:297011|297012; cosmos_chain_id:string; network_name:string; network_domain:string; genesis_hash:string; genesis_hash_kind:'sha256-canonical-genesis-json'; cosmos_rpc_url:string; evm_anchor:{block_number:1;block_hash:string}; rpc_url:string; asset_kind:'native'; symbol:'tHEYUNA'; base_denom:'aheyuna'; decimals:18; total_supply:string; reward_vault_address:string; public_fund_address:string; factory_address:string; contribution_precompile_address:string; genesis:number; challenge_seconds:number; confirmations:number; code_hashes:{reward_vault:string;public_fund:string;factory:string} };
export type NativeAllocation = {index:string;recipient:string;category:0|1;amount:string;contribution_id:string};
export type NativeClaim = NativeAllocation & {epoch:string;proof:string[]};
export type NativeManifest = {version:2;asset_kind:'native';chain_id:number;genesis_hash:string;reward_vault:string;epoch:string;allocations:NativeAllocation[]};
export type NativeBundle = {manifest:NativeManifest;manifestHash:string;root:string;claims:NativeClaim[];trainingAmount:bigint;validationAmount:bigint};
const object = (value:unknown):Record<string,unknown> => {if(!value||typeof value!=='object'||Array.isArray(value))throw new WalletCheckError('JSON 对象格式无效。');return value as Record<string,unknown>;};
const nonzeroHash=(value:unknown)=>{const parsed=hash(value);if(/^0x0{64}$/.test(parsed))throw new WalletCheckError('摘要尚未配置。');return parsed;};
export function parseNativeDeployment(input:unknown):NativeDeployment{
  const raw=object(input);
  if(raw.version!==2||raw.asset_kind!=='native'||raw.symbol!=='tHEYUNA'||raw.base_denom!=='aheyuna'||raw.decimals!==18||raw.total_supply!==TOTAL_SUPPLY.toString())throw new WalletCheckError('原生资产版本、单位或总量不匹配。');
  if(raw.chain_id!==297011&&raw.chain_id!==297012)throw new WalletCheckError('不是受支持的 Heyuna 研究链。');
  const accelerated=raw.chain_id===297012;
  if(raw.profile!==(accelerated?'accelerated-local':'research')||raw.cosmos_chain_id!==`heyuna_${raw.chain_id}-1`||raw.challenge_seconds!==(accelerated?3:259200))throw new WalletCheckError('网络 profile、链 ID 或挑战期不匹配。');
  if(typeof raw.network_name!=='string'||!raw.network_name.trim()||raw.network_name.length>120)throw new WalletCheckError('网络名称无效。');
  if(typeof raw.rpc_url!=='string')throw new WalletCheckError('RPC 尚未配置。');
  const url=new URL(raw.rpc_url);const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.protocol!=='http:'||!loopback)throw new WalletCheckError('RPC 地址不满足研究网络限制。');
  if(raw.genesis_hash_kind!=='sha256-canonical-genesis-json'||typeof raw.cosmos_rpc_url!=='string') throw new WalletCheckError('缺少可核验的创世身份。');
  const cosmosURL=new URL(raw.cosmos_rpc_url), cosmosLocal=['127.0.0.1','localhost','[::1]'].includes(cosmosURL.hostname);
  if(cosmosURL.username||cosmosURL.password||cosmosURL.search||cosmosURL.hash||cosmosURL.pathname!=='/'||cosmosURL.protocol!=='http:'||!cosmosLocal) throw new WalletCheckError('共识节点 RPC 地址不满足网络限制。');
  const anchor=object(raw.evm_anchor); if(anchor.block_number!==1) throw new WalletCheckError('缺少可信 EVM 首块锚。');
  const reward_vault_address=address(raw.reward_vault_address),public_fund_address=address(raw.public_fund_address),factory_address=address(raw.factory_address);
  if(new Set([reward_vault_address,public_fund_address,factory_address,PRECOMPILE]).size!==4||factory_address.toLowerCase()!=='0x0000000000000000000000000000000000000f01'||address(raw.contribution_precompile_address)!==PRECOMPILE)throw new WalletCheckError('合约或预编译地址不匹配。');
  if(!Number.isSafeInteger(raw.genesis)||Number(raw.genesis)<=0||!Number.isSafeInteger(raw.confirmations)||Number(raw.confirmations)<1||Number(raw.confirmations)>64)throw new WalletCheckError('创世时间或确认数无效。');
  const codes=object(raw.code_hashes);
  return {version:2,profile:accelerated?'accelerated-local':'research',chain_id:raw.chain_id,cosmos_chain_id:raw.cosmos_chain_id as string,network_name:raw.network_name,network_domain:nonzeroHash(raw.network_domain),genesis_hash:nonzeroHash(raw.genesis_hash),genesis_hash_kind:'sha256-canonical-genesis-json',cosmos_rpc_url:cosmosURL.href,evm_anchor:{block_number:1,block_hash:nonzeroHash(anchor.block_hash)},rpc_url:url.href,asset_kind:'native',symbol:'tHEYUNA',base_denom:'aheyuna',decimals:18,total_supply:TOTAL_SUPPLY.toString(),reward_vault_address,public_fund_address,factory_address,contribution_precompile_address:PRECOMPILE,genesis:Number(raw.genesis),challenge_seconds:Number(raw.challenge_seconds),confirmations:Number(raw.confirmations),code_hashes:{reward_vault:nonzeroHash(codes.reward_vault),public_fund:nonzeroHash(codes.public_fund),factory:nonzeroHash(codes.factory)}};
}
function allocation(input:unknown,vault:string):NativeAllocation{
  const raw=object(input);const recipient=address(raw.recipient).toLowerCase();
  if(recipient===vault.toLowerCase()||(raw.category!==0&&raw.category!==1))throw new WalletCheckError('无效收款人或贡献类别。');
  return {index:uint(raw.index,'领取索引'),recipient,category:raw.category,amount:uint(raw.amount,'奖励金额',true),contribution_id:nonzeroHash(raw.contribution_id)};
}
export function nativeLeaf(chainId:number,vault:string,claim:NativeClaim):string{
  return keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','uint256','uint8','uint256','address','uint256','bytes32'],[chainId,vault,claim.epoch,claim.category,claim.index,claim.recipient,claim.amount,claim.contribution_id])));
}
export function verifyNativeProof(chainId:number,vault:string,claim:NativeClaim,root:string):boolean{
  let node=nativeLeaf(chainId,vault,claim);for(const sibling of claim.proof)node=keccak256(BigInt(node)<BigInt(sibling)?concat([node,sibling]):concat([sibling,node]));return node===root;
}
export function nativeEpochBudget(epoch:string):bigint{const n=BigInt(epoch),pool=14_000_000n*10n**18n;return n<520n?pool*(n+1n)/520n-pool*n/520n:(pool+519n)/520n;}
export function canonicalJSON(value:unknown):string { if(Array.isArray(value)) return '['+value.map(canonicalJSON).join(',')+']'; if(value&&typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJSON((value as Record<string,unknown>)[key])).join(',')+'}'; return JSON.stringify(value); }
export function parseNativeBundle(text:string,deployment:NativeDeployment):NativeBundle{
  if(new TextEncoder().encode(text).length>MAX_FILE_BYTES)throw new WalletCheckError('分配清单不能超过 5 MiB。');
  const raw=object(JSON.parse(text)),data=object(raw.manifest);
  if(data.version!==2||data.asset_kind!=='native'||data.chain_id!==deployment.chain_id||hash(data.genesis_hash)!==deployment.genesis_hash||address(data.reward_vault)!==deployment.reward_vault_address)throw new WalletCheckError('清单的网络、创世哈希、协议或奖励库不匹配。');
  if(!Array.isArray(data.allocations)||!data.allocations.length||data.allocations.length>10000)throw new WalletCheckError('清单需包含 1 至 10,000 条分配。');
  const allocations=data.allocations.map(row=>allocation(row,deployment.reward_vault_address)).sort((a,b)=>BigInt(a.index)<BigInt(b.index)?-1:1);
  if(new Set(allocations.map(row=>row.index)).size!==allocations.length)throw new WalletCheckError('存在跨类别重复的领取索引。');
  const manifest:NativeManifest={version:2,asset_kind:'native',chain_id:deployment.chain_id,genesis_hash:deployment.genesis_hash,reward_vault:deployment.reward_vault_address.toLowerCase(),epoch:uint(data.epoch,'周期编号'),allocations};
  if(typeof raw.manifest_hash!=='string'||! /^[0-9a-f]{64}$/.test(raw.manifest_hash))throw new WalletCheckError('清单摘要必须为 SHA256 小写十六进制。'); const manifestHash=raw.manifest_hash;if(sha256(toUtf8Bytes(canonicalJSON(manifest))).slice(2)!==manifestHash)throw new WalletCheckError('分配清单摘要不匹配。');
  const root=nonzeroHash(raw.root);if(!Array.isArray(raw.claims)||raw.claims.length!==allocations.length)throw new WalletCheckError('证明与分配条目数量不符。');
  const rows=new Map(allocations.map(row=>[row.index,row]));const claims=raw.claims.map(input=>{const entry=object(input),row=allocation(entry,deployment.reward_vault_address),original=rows.get(row.index);if(!original||JSON.stringify(row)!==JSON.stringify(original)||entry.epoch!==manifest.epoch)throw new WalletCheckError('证明的贡献、类别或分配身份不匹配。');rows.delete(row.index);if(!Array.isArray(entry.proof)||entry.proof.length>64)throw new WalletCheckError('Merkle 证明无效。');const claim={...row,epoch:manifest.epoch,proof:entry.proof.map(hash)};if(!verifyNativeProof(deployment.chain_id,deployment.reward_vault_address,claim,root))throw new WalletCheckError('Merkle 证明校验失败。');return claim;});
  const trainingAmount=allocations.filter(row=>row.category===0).reduce((sum,row)=>sum+BigInt(row.amount),0n),validationAmount=allocations.filter(row=>row.category===1).reduce((sum,row)=>sum+BigInt(row.amount),0n),cap=nativeEpochBudget(manifest.epoch);
  if(uint(raw.training_budget,'训练预算')!==trainingAmount.toString()||uint(raw.verification_budget,'验证预算')!==validationAmount.toString())throw new WalletCheckError('清单预算与类别分配不一致。');
  if(trainingAmount>cap*9n/10n||validationAmount>cap-cap*9n/10n)throw new WalletCheckError('分配超过此周期的类别预算。');
  return {manifest,manifestHash,root,claims,trainingAmount,validationAmount};
}
