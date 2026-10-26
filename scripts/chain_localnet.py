#!/usr/bin/env python3
"""Four-node loopback-only HEYUNA network. All live keys and state stay in .state."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / ".state/bin/heyunad"
UNIT = 10**18
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def bech32(raw, prefix="heyuna"):
    data, accumulator, bits = [], 0, 0
    for value in raw:
        accumulator = (accumulator << 8) | value; bits += 8
        while bits >= 5:
            bits -= 5; data.append((accumulator >> bits) & 31)
    if bits: data.append((accumulator << (5-bits)) & 31)
    expanded = [ord(c) >> 5 for c in prefix] + [0] + [ord(c) & 31 for c in prefix]
    checksum = 1
    for value in expanded + data + [0]*6:
        top = checksum >> 25; checksum = ((checksum & 0x1ffffff) << 5) ^ value
        for bit, generator in enumerate([0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]):
            if (top >> bit) & 1: checksum ^= generator
    checksum ^= 1
    return prefix + "1" + "".join(CHARSET[v] for v in data + [(checksum >> (5*(5-i))) & 31 for i in range(6)])


def raw_address(address):
    if address.startswith("0x"): return bytes.fromhex(address[2:])
    data = [CHARSET.index(c) for c in address.rsplit("1",1)[1][:-6]]
    output, accumulator, bits = [], 0, 0
    for value in data:
        accumulator = (accumulator << 5) | value; bits += 5
        if bits >= 8:
            bits -= 8; output.append((accumulator >> bits) & 255)
    return bytes(output)


def save(path, value, mode=0o600):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value,indent=2,sort_keys=True)+"\n")
    temporary.chmod(mode);os.replace(temporary,path)


def command(arguments, home=None):
    argv = [str(BINARY)] + list(arguments)
    if home: argv += ["--home",str(home)]
    result = subprocess.run(argv,cwd=ROOT,capture_output=True,text=True)
    if result.returncode:
        # Never display key-generation output, which can include a mnemonic.
        detail = "key operation failed; private output withheld" if "keys" in arguments else result.stderr[-4000:]
        raise RuntimeError(f"heyunad exited {result.returncode}: {detail}")
    return result.stdout.strip()


def profile(name):
    accelerated = name == "accelerated"
    number = 297012 if accelerated else 297011
    root = ROOT / ".state" / ("chain-accelerated" if accelerated else "chain-research")
    offset = 1000 if accelerated else 0
    return {"name":name,"root":root,"chain_id":f"heyuna_{number}-1","evm_chain_id":number,"unsafe_test_profile":accelerated,
            "rpc_base":27657+offset,"p2p_base":27656+offset,"evm_base":9545+offset,"grpc_base":10090+offset,"api_base":2417 if accelerated else 1817}


def keys(p):
    root = p["root"]
    public_path = root / "public-accounts.json"
    if public_path.exists():
        print(public_path);return
    root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
    public = {"chain_id":p["chain_id"],"evm_chain_id":p["evm_chain_id"],"validators":[],"verifiers":[],"fund_managers":[]}
    for i in range(4):
        home=root/f"node{i}"
        if not (home/"config/genesis.json").exists():
            command(["init",f"heyuna-{i}","--chain-id",p["chain_id"]],home)
        name=f"validator{i}"
        record=new_key(name,home)
        validator=json.loads((home/"config/priv_validator_key.json").read_text())
        record.update({"consensus_address":validator["address"],"consensus_public_key":validator["pub_key"],"node_id":command(["comet","show-node-id"],home)})
        public["validators"].append(record)
    for group,prefix,count in [("verifiers","verifier",3),("fund_managers","fund-manager",5)]:
        for i in range(count): public[group].append(new_key(f"{prefix}{i}",root/"node0"))
    public["faucet"]=new_key("faucet",root/"node0")
    save(public_path,public,0o644)
    print(public_path)


def new_key(name,home):
    existing=subprocess.run([str(BINARY),"keys","show",name,"--keyring-backend","test","--output","json","--home",str(home)],capture_output=True,text=True,cwd=ROOT)
    if existing.returncode==0: record=json.loads(existing.stdout)
    else:
        raw=command(["keys","add",name,"--algo","eth_secp256k1","--keyring-backend","test","--output","json"],home)
        record=json.loads(raw)
        save(home/"private"/(name+".json"),record)
    address=record["address"]
    return {"name":name,"address":address,"evm_address":"0x"+raw_address(address).hex()}


def update_toml(path,updates):
    section="";found=set();out=[]
    for line in path.read_text().splitlines():
        match=re.match(r"\s*\[([^\]]+)\]\s*$",line)
        if match: section=match.group(1)
        match=re.match(r"\s*([A-Za-z0-9_-]+)\s*=",line)
        key=(section,match.group(1)) if match else None
        if key in updates:
            line=f"{key[1]} = {json.dumps(updates[key])}";found.add(key)
        out.append(line)
    missing=set(updates)-found
    if missing: raise RuntimeError(f"unknown TOML options in {path.name}: {sorted(missing)}")
    path.write_text("\n".join(out)+"\n")


def init(p,contracts_path):
    root=p["root"]
    if (root/"network-manifest.json").exists(): raise RuntimeError("Network already initialized; reset requires a different explicit state directory, never overwrite a live genesis")
    build_path=BINARY.with_name("build-evidence.json");build=None
    if build_path.exists():
        build=json.loads(build_path.read_text())
        if build["binary_sha256"]!=hashlib.sha256(BINARY.read_bytes()).hexdigest():raise RuntimeError("build evidence does not match current binary")
    accounts=json.loads((root/"public-accounts.json").read_text())
    contracts=json.loads(contracts_path.read_text())
    if contracts["chain_id"]!=p["chain_id"] or contracts["evm_chain_id"]!=p["evm_chain_id"]:raise RuntimeError("contract manifest belongs to another chain")
    if contracts["faucet"].lower()!=accounts["faucet"]["evm_address"].lower():raise RuntimeError("faucet binding mismatch")
    verifiers=[v["evm_address"] for v in accounts["verifiers"]]
    if [x.lower() for x in contracts["verifiers"]]!=[x.lower() for x in verifiers]:raise RuntimeError("verifier binding mismatch")
    for contract in [contracts["reward_vault"],contracts["public_fund"]]:
        if not re.fullmatch(r"0x[0-9a-fA-F]{40}",contract["address"]):raise RuntimeError("invalid contract address")
        if len(contract.get("creation_bytecode",""))<10:raise RuntimeError("missing deployment bytecode")
    home=root/"node0";genesis_path=home/"config/genesis.json"
    genesis=json.loads(genesis_path.read_text());state=genesis["app_state"]
    if "mint" in state:raise RuntimeError("periodic mint module unexpectedly present")
    state["staking"]["params"]["bond_denom"]="aheyuna"
    state["staking"]["params"]["max_validators"]=4
    state["slashing"]["params"]["signed_blocks_window"]="10000"
    for field in ["min_deposit","expedited_min_deposit"]:
        for coin in state["gov"]["params"].get(field,[]):coin["denom"]="aheyuna"
    state["bank"]["denom_metadata"]=[{"description":"HEYUNA researchnet native currency; no monetary value or mainnet conversion promise.","denom_units":[{"denom":"aheyuna","exponent":0,"aliases":[]},{"denom":"tHEYUNA","exponent":18,"aliases":[]}],"base":"aheyuna","display":"tHEYUNA","name":"Heyuna Researchnet","symbol":"tHEYUNA","uri":"","uri_hash":""}]
    state["evm"]["params"]["evm_denom"]="aheyuna"
    state["evm"]["params"]["extended_denom_options"]={"extended_denom":"aheyuna"}
    state["evm"]["params"]["active_static_precompiles"]=["0x0000000000000000000000000000000000000900"]
    state["evm"]["params"]["evm_channels"]=[]
    state["evm"]["preinstalls"]=[{"name":"HeyunaCreate2Factory","address":contracts["factory"]["address"],"code":contracts["factory"]["runtime_bytecode"]}]
    state["erc20"]["token_pairs"]=[];state["erc20"]["native_precompiles"]=[]
    state["feemarket"]["params"].update({"no_base_fee":True,"min_gas_price":"0.000000000000000000"})
    state["transfer"]["params"].update({"send_enabled":False,"receive_enabled":False})
    # Consensus never executes remote IBC/bridge/authz/governance messages: the
    # application AnteHandler enforces this independently of these settings.
    state["contribution"]={"config":{"version":1,"chain_id":p["chain_id"],"evm_chain_id":p["evm_chain_id"],"network_domain":contracts["network_domain"],"vault_address":contracts["reward_vault"]["address"],"verifiers":verifiers,"start_time":contracts["start_time"],"challenge_period_seconds":3 if p["unsafe_test_profile"] else 259200,"unsafe_test_profile":p["unsafe_test_profile"]}}
    state["researchnet"]={"chain_id":p["chain_id"],"start_time":contracts["start_time"],"epoch_seconds":3 if p["unsafe_test_profile"] else 604800,"epochs":1040,"subsidy_total":str(3_960_000*UNIT),"validators":[{"consensus_address":v["consensus_address"],"recipient":v["address"]} for v in accounts["validators"]]}
    genesis["genesis_time"]=datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")
    genesis["consensus"]["params"]["block"]["max_gas"]="30000000"
    save(genesis_path,genesis)
    allocations=[(v["address"],10_000*UNIT) for v in accounts["validators"]]
    allocations += [(bech32(raw_address(contracts["reward_vault"]["address"])),14_000_000*UNIT),(bech32(raw_address(contracts["public_fund"]["address"])),2_000_000*UNIT)]
    security_address=bech32(hashlib.sha256(b"security_budget").digest()[:20])
    allocations.append((security_address,3_960_000*UNIT))
    for address,amount in allocations:
        command(["genesis","add-genesis-account",address,str(amount)+"aheyuna","--keyring-backend","test"],home)
    genesis=json.loads(genesis_path.read_text());auth=genesis["app_state"]["auth"]["accounts"]
    for index,account in enumerate(auth):
        if account.get("address")==security_address:
            auth[index]={"@type":"/cosmos.auth.v1beta1.ModuleAccount","base_account":account,"name":"security_budget","permissions":[]}
            del auth[index]["base_account"]["@type"]
    save(genesis_path,genesis)
    for i in range(4):
        node=root/f"node{i}"
        if i:shutil.copy2(genesis_path,node/"config/genesis.json")
        command(["genesis","gentx",f"validator{i}",str(10_000*UNIT)+"aheyuna","--chain-id",p["chain_id"],"--keyring-backend","test","--gas-prices","0aheyuna"],node)
        if i:
            for gentx in (node/"config/gentx").glob("*.json"):shutil.copy2(gentx,home/"config/gentx"/gentx.name)
    command(["genesis","collect-gentxs"],home)
    command(["genesis","validate-genesis"],home)
    genesis=json.loads(genesis_path.read_text())
    if sum(int(c["amount"]) for b in genesis["app_state"]["bank"]["balances"] for c in b["coins"] if c["denom"]=="aheyuna")!=20_000_000*UNIT:raise RuntimeError("genesis supply mismatch")
    for i in range(4):
        node=root/f"node{i}"
        if i:shutil.copy2(genesis_path,node/"config/genesis.json")
        peers=",".join(f"{v['node_id']}@127.0.0.1:{p['p2p_base']+10*j}" for j,v in enumerate(accounts["validators"]) if i!=j)
        update_toml(node/"config/config.toml",{("rpc","laddr"):f"tcp://127.0.0.1:{p['rpc_base']+10*i}",("p2p","laddr"):f"tcp://127.0.0.1:{p['p2p_base']+10*i}",("p2p","persistent_peers"):peers,("p2p","pex"):False,("p2p","addr_book_strict"):False,("p2p","allow_duplicate_ip"):True,("mempool","type"):"app",("consensus","timeout_commit"):"1s",("rpc","cors_allowed_origins"):["http://127.0.0.1:1420","http://127.0.0.1:1421","http://localhost:1420","http://localhost:1421","tauri://localhost","http://tauri.localhost","https://tauri.localhost"],("rpc","pprof_laddr"):""})
        update_toml(node/"config/app.toml",{("","minimum-gas-prices"):"0aheyuna",("api","enable"):True,("api","address"):f"tcp://127.0.0.1:{p['api_base']+i}",("grpc","address"):f"127.0.0.1:{p['grpc_base']+i}",("grpc-web","enable"):False,("evm","evm-chain-id"):p["evm_chain_id"],("json-rpc","enable"):True,("json-rpc","address"):f"127.0.0.1:{p['evm_base']+10*i}",("json-rpc","ws-address"):f"127.0.0.1:{p['evm_base']+10*i+1}",("json-rpc","api"):"eth,net,web3"})
    comet_genesis=json.loads(command(["genesis-document",str(genesis_path)],home))
    save(root/"comet-genesis.json",comet_genesis,0o644)
    manifest={k:v for k,v in p.items() if k!="root"}
    manifest.update({"genesis_hash":"0x"+hashlib.sha256(json.dumps(comet_genesis,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest(),"genesis_hash_kind":"sha256-canonical-genesis-json","genesis_file_sha256":hashlib.sha256(genesis_path.read_bytes()).hexdigest(),"network_domain":contracts["network_domain"],"contracts_manifest_sha256":hashlib.sha256(contracts_path.read_bytes()).hexdigest(),"rpc_url":f"http://127.0.0.1:{p['evm_base']}","cosmos_rpc_url":f"http://127.0.0.1:{p['rpc_base']}","security_budget_address":security_address,"initial_supply":str(20_000_000*UNIT),"network_name":"HEYUNA Local "+("Accelerated " if p["unsafe_test_profile"] else "")+"Research Network","native_currency":{"name":"HEYUNA Test Token","symbol":"tHEYUNA","decimals":18},"zero_fee_bootstrap":True,"independent_operators_verified":False})
    save(root/"network-manifest.json",manifest,0o644)
    save(root/"genesis-contracts.json",contracts,0o644)
    if build is not None:
        save(root/"initial-build-evidence.json",build,0o644)
    print(json.dumps(manifest,indent=2))


def alive(pid):
    try:os.kill(pid,0)
    except ProcessLookupError:return False
    status=subprocess.run(["ps","-p",str(pid),"-o","stat="],capture_output=True,text=True).stdout.strip()
    return bool(status) and not status.startswith("Z")


def start(p,nodes):
    root=p["root"]
    if not (root/"network-manifest.json").exists():raise RuntimeError("Run init before start")
    pending_nodes=[]
    for i in nodes:
        node=root/f"node{i}";pidfile=node/"heyunad.pid"
        if pidfile.exists() and alive(int(pidfile.read_text())):
            details=subprocess.run(["ps","-p",pidfile.read_text(),"-o","args="],capture_output=True,text=True).stdout
            if str(BINARY) not in details or str(node) not in details:raise RuntimeError("PID ownership mismatch; refusing start")
            continue
        pending_nodes.append(i)
        for port in [p["p2p_base"]+10*i,p["rpc_base"]+10*i,p["evm_base"]+10*i,p["evm_base"]+10*i+1,p["grpc_base"]+i,p["api_base"]+i]:
            with socket.socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                try:sock.bind(("127.0.0.1",port))
                except OSError:raise RuntimeError(f"Port {port} already in use; refusing to touch another service")
    for i in pending_nodes:
        node=root/f"node{i}";pidfile=node/"heyunad.pid"
        environment=dict(os.environ,GOMAXPROCS="2")
        with (node/"heyunad.log").open("ab") as log:
            process=subprocess.Popen([str(BINARY),"start","--home",str(node),"--chain-id",p["chain_id"],"--evm.evm-chain-id",str(p["evm_chain_id"]),"--log_level",os.environ.get("HEYUNA_CHAIN_LOG_LEVEL","warn")],cwd=ROOT,stdout=log,stderr=log,stdin=subprocess.DEVNULL,start_new_session=True,env=environment)
        pidfile.write_text(str(process.pid));pidfile.chmod(0o600)
    wait_height(p,2,nodes=nodes)
    wait_rpc_ready(p)
    verify_identity(p)
    print(json.dumps({"started_nodes":nodes,"profile":p["name"]}))


def stop(p,nodes):
    pending=[]
    for i in nodes:
        pidfile=p["root"]/f"node{i}"/"heyunad.pid"
        if not pidfile.exists():continue
        pid=int(pidfile.read_text())
        if alive(pid):
            details=subprocess.run(["ps","-p",str(pid),"-o","args="],capture_output=True,text=True).stdout
            if str(BINARY) not in details or str(p["root"]/f"node{i}") not in details:raise RuntimeError("PID ownership mismatch; refusing stop")
            os.kill(pid,signal.SIGTERM);pending.append((pid,pidfile))
        else:pidfile.unlink()
    deadline=time.monotonic()+20
    while any(alive(pid) for pid,_ in pending) and time.monotonic()<deadline:time.sleep(0.2)
    for pid,path in pending:
        if alive(pid):raise RuntimeError(f"Node {pid} did not stop cleanly; no automatic SIGKILL")
        path.unlink(missing_ok=True)
    print(json.dumps({"stopped_nodes":nodes,"profile":p["name"]}))


def rpc(url,method,params=None):
    payload=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or []}).encode()
    request=urllib.request.Request(url,data=payload,headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(request,timeout=5) as response:result=json.load(response)
    if "error" in result:raise RuntimeError(str(result["error"]))
    return result["result"]


def wait_rpc_ready(p):
    accounts=json.loads((p["root"]/"public-accounts.json").read_text())
    deadline=time.monotonic()+45;last_error=None
    while time.monotonic()<deadline:
        try:
            rpc(f"http://127.0.0.1:{p['evm_base']}","eth_getTransactionCount",[accounts["faucet"]["evm_address"],"pending"])
            return
        except Exception as error:last_error=error
        time.sleep(.5)
    raise RuntimeError(f"EVM current context did not become ready: {last_error}")


def verify_identity(p):
    path=p["root"]/"network-manifest.json"
    manifest=json.loads(path.read_text())
    observed=rpc(manifest["cosmos_rpc_url"],"genesis")["genesis"]
    digest="0x"+hashlib.sha256(json.dumps(observed,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest()
    if digest!=manifest["genesis_hash"]:raise RuntimeError("RPC genesis identity differs from initialized document")
    block=rpc(manifest["rpc_url"],"eth_getBlockByNumber",["0x1",False])
    if not block or not re.fullmatch(r"0x[0-9a-fA-F]{64}",block.get("hash","")):raise RuntimeError("EVM anchor unavailable")
    anchor={"block_number":1,"block_hash":block["hash"]}
    if manifest.get("evm_anchor",anchor)!=anchor:raise RuntimeError("EVM anchor changed")
    manifest["evm_anchor"]=anchor
    save(path,manifest,0o644)


def heights(p):
    results=[]
    for i in range(4):
        try:
            result=rpc(f"http://127.0.0.1:{p['rpc_base']+10*i}","status")
            results.append({"node":i,"height":int(result["sync_info"]["latest_block_height"]),"app_hash":result["sync_info"]["latest_app_hash"],"catching_up":result["sync_info"]["catching_up"]})
        except Exception as error:results.append({"node":i,"error":str(error)})
    return results


def wait_height(p,minimum,nodes=(0,1,2,3),seconds=45):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        current=heights(p)
        if all(current[i].get("height",-1)>=minimum for i in nodes):return current
        time.sleep(0.5)
    raise RuntimeError("Height target failed: "+json.dumps(heights(p)))


def faults(p):
    before=wait_height(p,3);base=min(x["height"] for x in before)
    try:
        stop(p,[3]);one_down=wait_height(p,base+3,nodes=(0,1,2))
        stop(p,[2]);time.sleep(3);halt1=heights(p);time.sleep(4);halt2=heights(p)
        for node in [0,1]:
            if "height" not in halt1[node] or "height" not in halt2[node]:raise RuntimeError("cannot prove quorum halt from an unavailable surviving node")
            if halt1[node]["height"]!=halt2[node]["height"]:raise RuntimeError("two remaining validators unexpectedly made progress")
    finally:
        start(p,[2,3])
    recovered=wait_height(p,max(x.get("height",0) for x in halt2)+3)
    common=min(x["height"] for x in recovered)
    hashes=[rpc(f"http://127.0.0.1:{p['rpc_base']+10*i}","block",{"height":str(common)})["block_id"]["hash"] for i in range(4)]
    if len(set(hashes))!=1:raise RuntimeError("validators disagree on committed block")
    evidence={"profile":p["name"],"one_down_progress":True,"two_down_halts":True,"restart_recovers":True,"consistent_height":common,"block_hash":hashes[0],"four_processes_one_operator":True,"before":before,"one_down":one_down,"halt":halt2,"recovered":recovered}
    save(p["root"]/"fault-evidence.json",evidence,0o644);print(json.dumps(evidence,indent=2))


def audit(p):
    verify_identity(p)
    root=p["root"];manifest=json.loads((root/"network-manifest.json").read_text())
    contracts=json.loads((root/"genesis-contracts.json").read_text());accounts=json.loads((root/"public-accounts.json").read_text())
    status=wait_height(p,3);height=min(x["height"] for x in status)-1
    options=["--node",manifest["cosmos_rpc_url"],"--height",str(height),"--output","json"]
    def query(args):return json.loads(command(["query"]+args+options,root/"node0"))
    supply=query(["bank","total-supply-of","aheyuna"])["amount"]["amount"]
    last_supply=command(["query","researchnet","last_supply"]+options,root/"node0")
    if int(supply)>20_000_000*UNIT or supply!=last_supply:raise RuntimeError("native supply invariant mismatch")
    owners=query(["bank","denom-owners","aheyuna","--page-limit","10000","--page-count-total"])
    pagination=owners.get("pagination",{})
    if pagination.get("next_key") or int(pagination.get("total",0))!=len(owners["denom_owners"]):raise RuntimeError("bounded audit requires a complete account-balance enumeration")
    balance_sum=sum(int(owner["balance"]["amount"]) for owner in owners["denom_owners"])
    ledger={}
    identities=accounts["validators"]+[accounts["faucet"]]+[{"name":name,"evm_address":contracts[name]["address"],"address":bech32(raw_address(contracts[name]["address"]))} for name in ["reward_vault","public_fund"]]
    identities.append({"name":"security_budget","address":manifest["security_budget_address"],"evm_address":"0x"+raw_address(manifest["security_budget_address"]).hex()})
    for identity in identities:
        native=query(["bank","balance",identity["address"],"aheyuna"])["balance"]["amount"]
        evm=str(int(rpc(manifest["rpc_url"],"eth_getBalance",[identity["evm_address"],hex(height)]),16))
        if native!=evm:raise RuntimeError("bank/EVM balance mismatch for "+identity["name"])
        ledger[identity["name"]]={"bank":native,"evm":evm,"same":True}
    state=query(["researchnet","state"])
    if int(state["paid"])+int(ledger["security_budget"]["bank"])!=3_960_000*UNIT:raise RuntimeError("security reserve accounting mismatch")
    evidence={"profile":p["name"],"height":height,"genesis_hash":manifest["genesis_hash"],"evm_anchor":manifest["evm_anchor"],"total_supply":supply,"last_committed_supply":last_supply,"all_account_balances_sum":str(balance_sum),"enumerated_accounts":len(owners["denom_owners"]),"supply_matches_all_account_balances":balance_sum==int(supply),"same_native_evm_ledger":True,"balances":ledger,"security_state":state,"independent_operators_verified":False}
    save(root/"ledger-evidence.json",evidence,0o644);print(json.dumps(evidence,indent=2))
    if balance_sum!=int(supply):raise RuntimeError("native supply counter does not equal sum of all account balances; evidence saved as failure")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=["keys","init","start","stop","restart","status","faults","audit"])
    parser.add_argument("--profile",choices=["research","accelerated"],default="research")
    parser.add_argument("--contracts",type=Path)
    parser.add_argument("--nodes",default="0,1,2,3")
    args=parser.parse_args();p=profile(args.profile)
    nodes=[int(x) for x in args.nodes.split(",")]
    if not nodes or any(x<0 or x>3 for x in nodes) or len(set(nodes))!=len(nodes):parser.error("nodes must be unique IDs 0..3")
    os.umask(0o077)
    if not BINARY.exists():raise RuntimeError("Build heyunad using scripts/chain_build.sh")
    if args.action=="keys":keys(p)
    elif args.action=="init":
        if not args.contracts:parser.error("--contracts required")
        init(p,args.contracts.resolve())
    elif args.action=="start":start(p,nodes)
    elif args.action=="stop":stop(p,nodes)
    elif args.action=="restart":stop(p,nodes);start(p,nodes)
    elif args.action=="status":print(json.dumps(heights(p),indent=2))
    elif args.action=="audit":audit(p)
    else:faults(p)


if __name__=="__main__":
    try:main()
    except Exception as error:
        print(str(error),file=sys.stderr);sys.exit(1)
