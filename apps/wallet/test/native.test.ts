import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbiCoder, BrowserProvider, FeeData, Interface, keccak256, sha256, toUtf8Bytes } from 'ethers';
import { canonicalJSON, nativeLeaf, parseNativeBundle, parseNativeDeployment, PRECOMPILE, verifyNativeProof, type NativeBundle, type NativeClaim } from '../src/nativeProtocol';
import { assertNativeChain, connectNative, nativeRewardsInterface, NATIVE_REWARDS_ABI, ORACLE_ABI, prepareNativeClaim, sendNativeClaim, validateNativeClaimIdentity, verifyNativeReceipt } from '../src/nativeWallet';
import { parseDeployment } from '../src/adapter';
import type { Connection, InjectedProvider } from '../src/wallet';
const account='0x1000000000000000000000000000000000000001',vault='0x2000000000000000000000000000000000000002';
const code='0x60006000',codeHash=keccak256(code),anchorHash=`0x${'12'.repeat(32)}`,contributionId=`0x${'ab'.repeat(32)}`;
const genesis={chain_id:'heyuna_297012-1',genesis_time:'2026-10-26T00:00:00Z',app_state:{example:'fixture-only'}};
const deployment={version:2,profile:'accelerated-local',chain_id:297012,cosmos_chain_id:genesis.chain_id,network_name:'本地测试夹具',network_domain:contributionId,genesis_hash:sha256(toUtf8Bytes(canonicalJSON(genesis))),genesis_hash_kind:'sha256-canonical-genesis-json',cosmos_rpc_url:'http://127.0.0.1:26657/',evm_anchor:{block_number:1,block_hash:anchorHash},rpc_url:'http://127.0.0.1:8545/',asset_kind:'native',symbol:'tHEYUNA',base_denom:'aheyuna',decimals:18,total_supply:'20000000000000000000000000',reward_vault_address:vault,public_fund_address:'0x3000000000000000000000000000000000000003',factory_address:'0x0000000000000000000000000000000000000F01',contribution_precompile_address:PRECOMPILE,genesis:1792972800,challenge_seconds:3,confirmations:1,code_hashes:{reward_vault:codeHash,public_fund:codeHash,factory:codeHash}};
const config=parseNativeDeployment(deployment);
const allocation={index:'0',recipient:account,category:0 as const,amount:'1000000000000000000',contribution_id:contributionId};
const claim:NativeClaim={...allocation,epoch:'0',proof:[]};
const manifest={version:2,asset_kind:'native',chain_id:config.chain_id,genesis_hash:config.genesis_hash,reward_vault:vault,epoch:'0',allocations:[allocation]};
const rawBundle={manifest,manifest_hash:sha256(toUtf8Bytes(canonicalJSON(manifest))).slice(2),training_budget:allocation.amount,verification_budget:'0',root:nativeLeaf(config.chain_id,vault,claim),claims:[claim]};
const bundle=parseNativeBundle(JSON.stringify(rawBundle),config);
beforeEach(()=>vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({result:{genesis}}),{status:200}))));
afterEach(()=>vi.unstubAllGlobals());
function wallet(options:{chain?:string;anchor?:string;account?:string;code?:string;claimed?:boolean;finalized?:boolean;root?:string}={}){
  const calls:{method:string;params?:unknown}[]=[];const iface=new Interface([...NATIVE_REWARDS_ABI,...ORACLE_ABI]);
  const injected:InjectedProvider={request:async request=>{calls.push(request);switch(request.method){
    case 'eth_chainId':return options.chain??'0x48834';
    case 'eth_getBlockByNumber':return {hash:options.anchor??anchorHash};
    case 'eth_requestAccounts':case 'eth_accounts':return [options.account??account];
    case 'eth_getCode':return options.code??code;
    case 'eth_call':{const tx=(request.params as {data:string}[])[0];const call=iface.parseTransaction({data:tx.data})!;const values:Record<string,unknown[]>={CONTRIBUTION_ORACLE:[PRECOMPILE],isClaimed:[options.claimed??false],getEpoch:[options.root??bundle.root,bundle.trainingAmount,bundle.validationAmount,options.finalized??true]};return iface.encodeFunctionResult(call.name,values[call.name]);}
    case 'eth_sendTransaction':return `0x${'fe'.repeat(32)}`;
    default:throw new Error(`Unhandled fixture method ${request.method}`);
  }}};
  return {connection:{injected,provider:new BrowserProvider(injected,'any'),account} as Connection,calls};
}
function quote(){return {account,claim,data:nativeRewardsInterface.encodeFunctionData('claim',[claim.epoch,claim.index,claim.recipient,claim.category,claim.amount,claim.contribution_id,claim.proof]),gasEstimate:80000n,gasLimit:96000n,maxFeePerGas:20n,maxPriorityFeePerGas:2n,maximumFee:1920000n,preparedAt:Date.now(),manifestHash:bundle.manifestHash,root:bundle.root};}
describe('native configuration and canonical proofs',()=>{
  it('requires distinct research/accelerated domains and actual genesis anchors',()=>{
    expect(config.chain_id).toBe(297012);
    expect(()=>parseNativeDeployment({...deployment,challenge_seconds:259200})).toThrow(/profile/);
    expect(()=>parseNativeDeployment({...deployment,rpc_url:'http://remote.example'})).toThrow(/RPC/);
    expect(()=>parseNativeDeployment({...deployment,cosmos_rpc_url:'https://remote.example'})).toThrow(/共识节点/);
    expect(()=>parseNativeDeployment({...deployment,evm_anchor:null})).toThrow();
    expect(()=>parseNativeDeployment({...deployment,genesis_hash_kind:'block-hash'})).toThrow(/创世/);
    expect(()=>parseDeployment({version:1})).toThrow(/显式/);
  });
  it('binds the Solidity leaf domain, category, index and contribution ID',()=>{
    const encoded=AbiCoder.defaultAbiCoder().encode(['uint256','address','uint256','uint8','uint256','address','uint256','bytes32'],[297012,vault,0,0,0,account,allocation.amount,contributionId]);
    expect(bundle.root).toBe(keccak256(keccak256(encoded)));
    expect(verifyNativeProof(297011,vault,claim,bundle.root)).toBe(false);
    expect(verifyNativeProof(297012,vault,{...claim,category:1},bundle.root)).toBe(false);
    expect(verifyNativeProof(297012,vault,{...claim,contribution_id:`0x${'cd'.repeat(32)}`},bundle.root)).toBe(false);
    expect(()=>validateNativeClaimIdentity(bundle,config,{...claim,index:'1'},account)).toThrow();
  });
  it('uses SHA256 canonical manifests and rejects mutation and cross-category duplicate indices',()=>{
    expect(bundle.manifestHash).toBe(rawBundle.manifest_hash);
    expect(canonicalJSON({z:1,a:{b:2,a:1}})).toBe('{"a":{"a":1,"b":2},"z":1}');
    expect(()=>parseNativeBundle(JSON.stringify({...rawBundle,manifest:{...manifest,genesis_hash:anchorHash}}),config)).toThrow(/创世/);
    expect(()=>parseNativeBundle(JSON.stringify({...rawBundle,manifest_hash:anchorHash}),config)).toThrow(/摘要/);
    expect(()=>parseNativeBundle(JSON.stringify({...rawBundle,manifest:{...manifest,allocations:[allocation,{...allocation,category:1}]}}),config)).toThrow(/跨类别重复/);
  });
});
describe('native wallet signature boundary',()=>{
  it('checks chain, canonical Cosmos genesis and wallet anchor before asking accounts; never signs on connect',async()=>{
    const mock=wallet();const connection=await connectNative(mock.connection.injected,config);
    expect(connection.account).toBe(account);
    expect(mock.calls.findIndex(row=>row.method==='eth_getBlockByNumber')).toBeLessThan(mock.calls.findIndex(row=>row.method==='eth_requestAccounts'));
    expect(mock.calls.some(row=>/sign|send/.test(row.method))).toBe(false);connection.provider.destroy();mock.connection.provider.destroy();
  });
  it('rejects wrong network or wrong wallet anchor without account permission',async()=>{
    for(const options of [{chain:'0x1'},{anchor:`0x${'55'.repeat(32)}`}]){const mock=wallet(options);await expect(connectNative(mock.connection.injected,config)).rejects.toThrow();expect(mock.calls.some(row=>row.method==='eth_requestAccounts')).toBe(false);mock.connection.provider.destroy();}
  });
  it('fails closed if Cosmos genesis identity is wrong even when wallet chain ID matches',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({result:{genesis:{...genesis,chain_id:'other'}}}))));
    const mock=wallet();await expect(assertNativeChain(mock.connection.injected,{...config,cosmos_rpc_url:'http://127.0.0.1:26658/'})).rejects.toThrow(/共识节点创世/);mock.connection.provider.destroy();
  });
  it('does not reuse genesis validation for a different expected Cosmos chain identity',async()=>{
    const mock=wallet();await assertNativeChain(mock.connection.injected,config);
    await expect(assertNativeChain(mock.connection.injected,{...config,cosmos_chain_id:'heyuna_297011-1'})).rejects.toThrow(/共识节点创世/);mock.connection.provider.destroy();
  });
  it('previews native gas and sends exactly one zero-value claim only on the explicit send path',async()=>{
    const mock=wallet();vi.spyOn(mock.connection.provider,'estimateGas').mockResolvedValue(80000n);vi.spyOn(mock.connection.provider,'getFeeData').mockResolvedValue(new FeeData(10n,20n,2n));
    const q=await prepareNativeClaim(mock.connection,config,bundle,claim);expect(q.gasLimit).toBe(96000n);expect(mock.calls.some(row=>row.method==='eth_sendTransaction')).toBe(false);
    await sendNativeClaim(mock.connection,config,bundle,q);const sends=mock.calls.filter(row=>row.method==='eth_sendTransaction');expect(sends).toHaveLength(1);expect((sends[0].params as Record<string,string>[])[0]).toMatchObject({to:vault,chainId:'0x48834',value:'0x0',data:q.data,maxFeePerGas:'0x14'});mock.connection.provider.destroy();
  });
  it('accepts explicit zero-fee research estimates but rejects missing fee data',async()=>{
    const mock=wallet();vi.spyOn(mock.connection.provider,'estimateGas').mockResolvedValue(80000n);const fee=vi.spyOn(mock.connection.provider,'getFeeData').mockResolvedValue(new FeeData(0n,0n,0n));
    const q=await prepareNativeClaim(mock.connection,config,bundle,claim);expect(q.maximumFee).toBe(0n);expect(q.maxPriorityFeePerGas).toBe(0n);
    expect(mock.calls.some(row=>row.method==='eth_sendTransaction')).toBe(false);
    fee.mockResolvedValue(new FeeData(null,null,null));await expect(prepareNativeClaim(mock.connection,config,bundle,claim)).rejects.toThrow(/完整/);mock.connection.provider.destroy();
  });
  it('rejects stale, modified, already-claimed, unfinalized, wrong-code and wrong-account claims',async()=>{
    for(const [options,q] of [[{}, {...quote(),preparedAt:Date.now()-120001}],[{}, {...quote(),data:'0x'}],[{claimed:true},quote()],[{finalized:false},quote()],[{code:'0x6001'},quote()],[{account:vault},quote()]] as const){const mock=wallet(options);await expect(sendNativeClaim(mock.connection,config,bundle,q)).rejects.toThrow();expect(mock.calls.some(row=>row.method==='eth_sendTransaction')).toBe(false);mock.connection.provider.destroy();}
  });
});
it('requires a successful receipt with matching native contribution identity',()=>{
  const event=nativeRewardsInterface.encodeEventLog(nativeRewardsInterface.getEvent('RewardClaimed')!,[0,0,account,0,allocation.amount,contributionId]);const receipt={status:1,to:vault,from:account,logs:[{address:vault,topics:event.topics,data:event.data}]};
  expect(()=>verifyNativeReceipt(receipt,config,quote())).not.toThrow();expect(()=>verifyNativeReceipt({...receipt,status:0},config,quote())).toThrow();
  const wrong=nativeRewardsInterface.encodeEventLog(nativeRewardsInterface.getEvent('RewardClaimed')!,[0,0,account,0,allocation.amount,anchorHash]);expect(()=>verifyNativeReceipt({...receipt,logs:[{address:vault,topics:wrong.topics,data:wrong.data}]},config,quote())).toThrow(/贡献身份/);
});
