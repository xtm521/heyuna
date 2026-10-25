// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only fixed-supply asset. Identity is (chainId, address), not symbol.
/// @dev No proxy, owner, external mint, burn, transfer hook, or mutable configuration.
contract HeyunaToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 20_000_000 ether;
    uint256 public constant CONTRIBUTION_ALLOCATION = 18_000_000 ether;
    uint256 public constant PUBLIC_FUND_ALLOCATION = 2_000_000 ether;

    error InvalidVaults();
    error UnsupportedChain();

    constructor(address rewardVault, address publicFund) ERC20("Heyuna Testnet", "tHEYUNA") {
        if (block.chainid != 11155111 && block.chainid != 31337) revert UnsupportedChain();
        if (
            rewardVault == publicFund || rewardVault.code.length == 0 || publicFund.code.length == 0
        ) revert InvalidVaults();
        _mint(rewardVault, CONTRIBUTION_ALLOCATION);
        _mint(publicFund, PUBLIC_FUND_ALLOCATION);
    }
}
