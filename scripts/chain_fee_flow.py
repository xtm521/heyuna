#!/usr/bin/env python3
"""Actual local SDK fee collection/distribution/withdrawal probe, without minting."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('localnet',ROOT/'scripts/chain_localnet.py')
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--profile',choices=['research'],default='research');args=parser.parse_args()
    p=n.profile(args.profile);home=p['root']/'node0';accounts=json.loads((p['root']/'public-accounts.json').read_text());url=f"http://127.0.0.1:{p['rpc_base']}"
    validator=accounts['validators'][0];operator=n.bech32(n.raw_address(validator['address']),'heyunavaloper')
    def balance(address,height=None):
        options=['--height',str(height)] if height else []
        return int(json.loads(n.command(['query','bank','balance',address,'aheyuna','--node',url,'--output','json',*options],home))['balance']['amount'])
    def send(arguments,fee='0'):
        response=json.loads(n.command(['tx',*arguments,'--chain-id',p['chain_id'],'--node',url,'--keyring-backend','test','--gas','500000','--fees',fee+'aheyuna','--yes','--output','json'],home))
        if response.get('code',0)!=0:raise RuntimeError(str(response))
        transaction=response['txhash'];deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            try:result=json.loads(n.command(['query','tx',transaction,'--node',url,'--output','json'],home))
            except RuntimeError:time.sleep(.5);continue
            if result.get('code',0)!=0:raise RuntimeError(str(result))
            return result
        raise RuntimeError('transaction confirmation timeout')
    before=balance(validator['address']);fee=1_000_000_000
    payment=send(['bank','send','faucet',validator['address'],'1aheyuna','--from','faucet'],str(fee));height=int(payment['height'])
    n.wait_height(p,height+2)
    collector=n.bech32(hashlib.sha256(b'fee_collector').digest()[:20]);distribution=n.bech32(hashlib.sha256(b'distribution').digest()[:20])
    collected=balance(collector,height)
    if collected!=fee:raise RuntimeError('fee collector does not equal the probe fee')
    withdrawal=send(['distribution','withdraw-rewards',operator,'--from','validator0','--commission'])
    after=balance(validator['address']);received=after-before-1
    if received!=245_000_000:raise RuntimeError('expected 98% / four equal validators paid to self-delegator including commission')
    evidence={'profile':args.profile,'kind':'actual-SDK-fee-collection-and-withdrawal','fee_payment_tx':payment['txhash'],'fee_height':height,'fee_aheyuna':str(fee),'collector_balance_at_fee_height':str(collected),'collector_balance_following_height':str(balance(collector,height+1)),'distribution_balance_following_height':str(balance(distribution,height+1)),'withdrawal_tx':withdrawal['txhash'],'withdrawal_height':int(withdrawal['height']),'validator_received_aheyuna':str(received),'community_tax':'0.02','equal_validator_share':'0.25','evm_dynamic_base_fee_verified':False}
    n.save(p['root']/'fee-flow-evidence.json',evidence,0o644);print(json.dumps(evidence,indent=2))

if __name__=='__main__':main()
