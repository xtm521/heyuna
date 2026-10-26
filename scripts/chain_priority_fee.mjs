// Local research-only fee settlement probe. Never prints signing material.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { publicRPC } from '../contracts/scripts/research-deploy.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'contracts/package.json'));
const {HDNodeWallet,JsonRpcProvider}=require('ethers');
const profile=process.argv[2]??'accelerated';
if(!['accelerated','research'].includes(profile))throw new Error('only predefined local profiles');
const directory=path.join(root,'.state',`chain-${profile}`);
const manifest=JSON.parse(fs.readFileSync(path.join(directory,'network-manifest.json')));
const accounts=JSON.parse(fs.readFileSync(path.join(directory,'public-accounts.json')));
const keyPath=path.join(directory,'node0/private/faucet.json');
if((fs.statSync(keyPath).mode&0o077)!==0)throw new Error('private signing file permissions');
const record=JSON.parse(fs.readFileSync(keyPath));
const provider=new JsonRpcProvider(manifest.rpc_url,manifest.evm_chain_id,{staticNetwork:true});
const wallet=HDNodeWallet.fromPhrase(record.mnemonic,'',"m/44'/118'/0'/0/0").connect(provider);
if(wallet.address.toLowerCase()!==accounts.faucet.evm_address.toLowerCase())throw new Error('signer identity mismatch');
const rpc=(method,params=[])=>publicRPC(manifest.rpc_url,method,params);
const comet=(method,params={})=>publicRPC(manifest.cosmos_rpc_url,method,params);
const collector=`0x${createHash('sha256').update('fee_collector').digest('hex').slice(0,40)}`;
const balance=async(address,height)=>BigInt(await rpc('eth_getBalance',[address,`0x${height.toString(16)}`]));
async function send(request){
 const nonce=Number(await rpc('eth_getTransactionCount',[wallet.address,'pending']));
 const raw=await wallet.signTransaction({...request,nonce,chainId:manifest.evm_chain_id});
 const hash=await rpc('eth_sendRawTransaction',[raw]);
 console.log(JSON.stringify({stage:'broadcast',hash,nonce}));
 const deadline=Date.now()+60_000;
 while(Date.now()<deadline){
  const receipt=await rpc('eth_getTransactionReceipt',[hash]);
  if(receipt)return receipt;
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 throw new Error(`receipt timeout for ${hash}; broadcast is not finalization evidence`);
}
async function check(receipt,expectedStatus){
 const height=Number(receipt.blockNumber);const charged=BigInt(receipt.gasUsed);const price=BigInt(receipt.effectiveGasPrice);
 if(Number(receipt.status)!==expectedStatus||price!==3n||charged<=0n||charged>=100000n)throw new Error('status/effective tip/refund mismatch');
 const block=(await comet('block',{height:String(height)})).block;
 const proposer=accounts.validators.find(v=>v.consensus_address===block.header.proposer_address);
 if(!proposer)throw new Error('consensus proposer not in genesis');
 const results=await comet('block_results',{height:String(height)});
 const attributes=event=>Object.fromEntries(event.attributes.map(a=>[a.key,a.value]));
 const subsidies=(results.finalize_block_events??[]).filter(e=>e.type==='security_subsidy').map(attributes).filter(a=>a.recipient===proposer.address).reduce((sum,a)=>sum+BigInt(a.amount),0n);
 const events=(results.txs_results??[]).flatMap(t=>t.events??[]).filter(e=>e.type==='evm_priority_fee').map(attributes);
 const expected=charged*price;
 const senderLoss=await balance(wallet.address,height-1)-await balance(wallet.address,height);
 const proposerGain=await balance(proposer.evm_address,height)-await balance(proposer.evm_address,height-1)-subsidies;
 if(senderLoss!==expected||proposerGain!==expected)throw new Error(`fee settlement mismatch: sender=${senderLoss} proposer=${proposerGain} expected=${expected}`);
 if(events.length!==1||BigInt(events[0].amount)!==expected||events[0].recipient.toLowerCase()!==proposer.evm_address.toLowerCase())throw new Error('priority event identity/amount mismatch');
 const collectorBalance=await balance(collector,height);
 if(collectorBalance!==0n)throw new Error('zero-base-fee EVM fee unexpectedly remained in collector');
 return {tx_hash:receipt.transactionHash,height,status:expectedStatus,requested_gas:'100000',charged_gas:charged.toString(),max_fee_per_gas:'7',max_priority_fee_per_gas:'3',base_fee_per_gas:'0',effective_priority_fee_per_gas:price.toString(),priority_paid_aheyuna:expected.toString(),sender_loss_aheyuna:senderLoss.toString(),actual_proposer:proposer.evm_address,proposer_gain_excluding_subsidy_aheyuna:proposerGain.toString(),security_subsidy_excluded_aheyuna:subsidies.toString(),collector_balance:collectorBalance.toString()};
}
const transfer=await send({to:wallet.address,value:0n,type:2,maxFeePerGas:7n,maxPriorityFeePerGas:3n,gasLimit:100000n});
const transferEvidence=await check(transfer,1);
// Constructor installs a five-byte runtime that always REVERTs. Zero-fee setup
// separates the accepted failed EVM call's tip from deployment cost.
const deployment=await send({data:'0x6005600c60003960056000f360006000fd',type:0,gasPrice:0n,gasLimit:200000n});
if(Number(deployment.status)!==1||!deployment.contractAddress)throw new Error('revert fixture deployment failed');
const reverted=await send({to:deployment.contractAddress,type:2,maxFeePerGas:7n,maxPriorityFeePerGas:3n,gasLimit:100000n});
const revertEvidence=await check(reverted,0);
const evidence={profile,kind:'actual-EIP1559-priority-proposer-settlement',successful_transfer:transferEvidence,reverted_evm_call:revertEvidence,charged_after_refunds_and_min_gas_floor:true,nonzero_dynamic_base_fee_verified:false,total_supply_should_not_increase:true};
fs.writeFileSync(path.join(directory,'priority-fee-evidence.json'),`${JSON.stringify(evidence,null,2)}\n`,{mode:0o644});
console.log(JSON.stringify(evidence,null,2));
await provider.destroy();
