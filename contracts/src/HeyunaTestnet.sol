// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {HeyunaToken} from "./HeyunaToken.sol";
import {RewardVault} from "./RewardVault.sol";
import {PublicFund} from "./PublicFund.sol";

/// @notice Atomically initializes the entire testnet system. No post-deployment control methods.
contract HeyunaTestnet {
    HeyunaToken public immutable token;
    RewardVault public immutable rewards;
    PublicFund public immutable publicFund;
    error UnsupportedChain();
    error AddressPredictionMismatch();
    event Deployed(address indexed token, address indexed rewards, address indexed publicFund, uint256 genesis);

    constructor(address[3] memory rewardValidators, address[3] memory fundValidators, uint256 genesis) {
        if (block.chainid != 11155111 && block.chainid != 31337) revert UnsupportedChain();
        // EIP-161: newly created contract nonce starts at 1. The third CREATE is the token.
        // RLP([this, 3]) = 0xd6 || 0x94 || address(this) || 0x03.
        // Vault constructors MUST NOT CREATE contracts; no call is made between these CREATEs.
        address expectedToken = address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"03")))));
        rewards = new RewardVault(expectedToken, rewardValidators, genesis);
        publicFund = new PublicFund(expectedToken, fundValidators);
        token = new HeyunaToken(address(rewards), address(publicFund));
        if (address(token) != expectedToken) revert AddressPredictionMismatch();
        emit Deployed(address(token), address(rewards), address(publicFund), genesis);
    }
}
