"""Public deployment metadata: configuration is not chain verification."""
import json
from pathlib import Path
from typing import Annotated, Literal

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


def rewards_config(state: Path):
    output = {"chain_id": 11155111, "network": "Ethereum Sepolia", "token_address": None,
              "rewards_address": None, "wallet_url": None, "symbol": "tHEYUNA", "testnet": True,
              "total_supply": "20000000", "state": "not_deployed"}
    path = state / "deployment.json"
    if not path.exists():
        return output
    if path.stat().st_size > 16384:
        raise ValueError("deployment manifest is too large")
    deployment = Deployment.model_validate(json.loads(path.read_text()))
    return {**output, "token_address": deployment.token_address,
            "rewards_address": deployment.reward_vault_address,
            "wallet_url": "http://127.0.0.1:1421/", "state": "configured_unverified",
            "deployment": deployment.model_dump()}
