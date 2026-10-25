import pytest
from heyuna.deployment import Deployment
from pydantic import ValidationError


def example():
    return {"version": 1, "chain_id": 11155111, "token_address": "0x" + "1" * 40,
                "reward_vault_address": "0x" + "2" * 40, "public_fund_address": "0x" + "3" * 40,
                "factory_address": "0x" + "4" * 40, "genesis": 1792886400, "decimals": 18,
                "total_supply": "20000000000000000000000000", "confirmations": 3,
                "code_hashes": {key: "0x" + "a" * 64 for key in ["token", "reward_vault", "public_fund", "factory"]}}


@pytest.mark.parametrize("field,value", [("chain_id", 1), ("decimals", 6), ("confirmations", 0), ("genesis", 0),
                                      ("total_supply", "20000000"), ("token_address", "0x" + "0" * 40)])
def test_manifest_rejects_wrong_asset_parameters(field, value):
    data = example(); data[field] = value
    with pytest.raises(ValidationError):
        Deployment.model_validate(data)


def test_manifest_rejects_aliasing_contracts():
    data = example()
    assert Deployment.model_validate(data).chain_id == 11155111
    data["reward_vault_address"] = data["token_address"]
    with pytest.raises(ValidationError):
        Deployment.model_validate(data)
