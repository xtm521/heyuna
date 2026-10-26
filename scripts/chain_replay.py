#!/usr/bin/env python3
"""Replay committed blocks offline using two builds of identical application source."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import time

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('localnet',ROOT/'scripts/chain_localnet.py')
localnet=importlib.util.module_from_spec(spec);spec.loader.exec_module(localnet)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',choices=['accelerated','research'],default='accelerated')
    parser.add_argument('--blocks',type=int,default=160)
    args=parser.parse_args()
    if not 2<=args.blocks<=1000:parser.error('bounded replay requires 2..1000 blocks')
    p=localnet.profile(args.profile);rpc=f"http://127.0.0.1:{p['rpc_base']}"
    localnet.verify_identity(p)
    status=localnet.rpc(rpc,'status');height=min(args.blocks,int(status['sync_info']['latest_block_height'])-2)
    if height<2:raise RuntimeError('insufficient committed history')
    directory=ROOT/'.state'/f"replay-{args.profile}-{time.time_ns()}";directory.mkdir(mode=0o700)
    genesis=localnet.rpc(rpc,'genesis')['genesis']
    blocks=[];validators=[]
    for h in range(1,height+2):
        blocks.append(localnet.rpc(rpc,'block',{'height':str(h)})['block'])
        if h<=height:validators.append(localnet.rpc(rpc,'validators',{'height':str(max(1,h-1)),'per_page':'100'})['validators'])
    history=directory/'history.json'
    localnet.save(history,{'genesis':genesis,'evm_chain_id':p['evm_chain_id'],'blocks':blocks,'validator_sets':validators},0o644)
    binaries=[]
    for name in ['a','b']:
        binary=directory/f'replay-{name}'
        subprocess.run(['sh',str(ROOT/'scripts/chain_go.sh'),'build','-trimpath','-o',str(binary),'./cmd/heyuna-replay'],cwd=ROOT,check=True)
        binaries.append(binary)
    def execute(binary,name,extra=(),expected=0):
        result=subprocess.run([str(binary),'--history',str(history),'--state',str(directory/name),*extra],cwd=ROOT,capture_output=True,text=True)
        if result.returncode!=expected:raise RuntimeError(result.stderr[-6000:]+result.stdout[-1000:])
        return json.loads(result.stdout) if expected==0 else {'exit_code':result.returncode,'stage':'after FinalizeBlock before Commit','height':height//2}
    a=execute(binaries[0],'database-a')
    interruption=execute(binaries[1],'database-b',['--crash-after-finalize',str(height//2)],75)
    b=execute(binaries[1],'database-b')
    if a['app_hash']!=b['app_hash'] or a['final_height']!=b['final_height']:raise RuntimeError('two builds/recovery produced different committed state')
    evidence={'profile':args.profile,'kind':'same-version-offline-ABCI-historical-replay','genesis_hash':'0x'+hashlib.sha256(json.dumps(genesis,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest(),'history_sha256':hashlib.sha256(history.read_bytes()).hexdigest(),'binary_sha256':[hashlib.sha256(binary.read_bytes()).hexdigest() for binary in binaries],'a':a,'injected_interruption':interruption,'b_recovered':b,'matching_committed_app_hash':True,'cross_version_upgrade_proven':False,'consensus_signature_verification':False,'signing_keys_loaded':False}
    localnet.save(directory/'evidence.json',evidence,0o644)
    print(json.dumps(evidence,indent=2));print(directory/'evidence.json')

if __name__=='__main__':main()
