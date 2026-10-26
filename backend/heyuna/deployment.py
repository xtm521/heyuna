"""Public deployment metadata: configuration is not chain verification."""
import json
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator

Address = Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]{40}$")]
Hash = Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]{64}$")]


class CodeHashes(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: Hash
    reward_vault: Hash
    public_fund: Hash
    factory: Hash


class Deployment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    chain_id: Literal[11155111]
    token_address: Address
    reward_vault_address: Address
    public_fund_address: Address
    factory_address: Address
    genesis: int = Field(gt=0)
    decimals: Literal[18]
    total_supply: Literal["20000000000000000000000000"]
    confirmations: int = Field(ge=3, le=64)
    code_hashes: CodeHashes

    @model_validator(mode="after")
    def unique_nonzero_addresses(self):
        addresses = [self.token_address, self.reward_vault_address, self.public_fund_address, self.factory_address]
        if any(int(a, 16) == 0 for a in addresses) or len({a.lower() for a in addresses}) != 4:
            raise ValueError("deployed addresses must be distinct and nonzero")
        if any(int(h, 16) == 0 for h in self.code_hashes.model_dump().values()):
            raise ValueError("deployed runtime hashes must be nonzero")
        return self


class NativeCodeHashes(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reward_vault: Hash
    public_fund: Hash
    factory: Hash


class EVMAnchor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    block_number: Literal[1]
    block_hash: Hash


class NetworkManifest(BaseModel):
    """Trusted network identity, not proof that the referenced node is honest."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[2]
    profile: Literal["research", "accelerated-local"]
    chain_id: Literal[297011, 297012]
    cosmos_chain_id: Literal["heyuna_297011-1", "heyuna_297012-1"]
    network_name: str = Field(min_length=1, max_length=120)
    network_domain: Hash
    genesis_hash: Hash
    genesis_hash_kind: Literal["sha256-canonical-genesis-json"]
    evm_anchor: EVMAnchor
    rpc_url: str = Field(max_length=512)
    cosmos_rpc_url: str = Field(max_length=512)
    asset_kind: Literal["native"]
    symbol: Literal["tHEYUNA"]
    base_denom: Literal["aheyuna"]
    decimals: Literal[18]
    total_supply: Literal["20000000000000000000000000"]
    reward_vault_address: Address
    public_fund_address: Address
    factory_address: Literal["0x0000000000000000000000000000000000000F01"]
    contribution_precompile_address: Literal["0x0000000000000000000000000000000000000900"]
    genesis: int = Field(gt=0)
    challenge_seconds: Literal[259200, 3]
    confirmations: int = Field(ge=1, le=64)
    code_hashes: NativeCodeHashes

    @model_validator(mode="after")
    def consistent_identity(self):
        expected = (297012, "heyuna_297012-1", 3) if self.profile == "accelerated-local" else (297011, "heyuna_297011-1", 259200)
        if (self.chain_id, self.cosmos_chain_id, self.challenge_seconds) != expected:
            raise ValueError("profile, chain identity and challenge period disagree")
        contracts = [self.reward_vault_address, self.public_fund_address, self.factory_address, self.contribution_precompile_address]
        if len({a.lower() for a in contracts}) != 4 or any(int(a, 16) == 0 for a in contracts):
            raise ValueError("contract identities must be distinct and nonzero")
        hashes = [self.network_domain, self.genesis_hash, self.evm_anchor.block_hash, *self.code_hashes.model_dump().values()]
        if any(int(h, 16) == 0 for h in hashes):
            raise ValueError("network hashes must be nonzero")
        for endpoint in [self.rpc_url, self.cosmos_rpc_url]:
            parsed = urlsplit(endpoint)
            if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
                raise ValueError("RPC must be an origin without credentials or query")
            # This release only implements a loopback research chain. Public
            # transport, fees and independent operators have separate gates.
            if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
                raise ValueError("this research release requires loopback RPC")
        return self


def load_manifest(path: Path) -> NetworkManifest | Deployment:
    if path.stat().st_size > 32768:
        raise ValueError("deployment manifest is too large")
    data = json.loads(path.read_text())
    return NetworkManifest.model_validate(data) if data.get("version") == 2 else Deployment.model_validate(data)


def rewards_config(state: Path):
    output = {"chain_id": 297011, "network": "Heyuna Researchnet", "token_address": None,
              "rewards_address": None, "wallet_url": None, "symbol": "tHEYUNA", "testnet": True,
              "total_supply": "20000000", "state": "not_deployed", "asset_kind": "native",
              "profile": "research", "decimals": 18}
    path = state / "deployment.json"
    if not path.exists():
        return output
    deployment = load_manifest(path)
    if isinstance(deployment, NetworkManifest):
        return {**output, "chain_id": deployment.chain_id, "network": deployment.network_name,
                "rewards_address": deployment.reward_vault_address, "wallet_url": "http://127.0.0.1:1421/",
                "state": "configured_unverified", "profile": deployment.profile,
                "genesis_hash": deployment.genesis_hash, "rpc_url": deployment.rpc_url,
                "deployment": deployment.model_dump()}
    return {**output, "token_address": deployment.token_address,
            "chain_id": 11155111, "network": "Ethereum Sepolia (legacy alpha)", "asset_kind": "legacy-erc20",
            "profile": "legacy-alpha",
            "rewards_address": deployment.reward_vault_address,
            "wallet_url": "http://127.0.0.1:1421/", "state": "configured_unverified",
            "deployment": deployment.model_dump()}
