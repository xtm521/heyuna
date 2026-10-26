// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

/// @notice Small research-chain-only CREATE2 factory. Genesis never gives it custody of funds.
contract ResearchCreate2Factory {
    error UnsupportedChain();
    error DeploymentFailed();
    event Deployed(address indexed deployed, bytes32 indexed salt, bytes32 initCodeHash);

    function deploy(bytes32 salt, bytes memory initCode) external returns (address deployed) {
        if (block.chainid != 297011 && block.chainid != 297012) revert UnsupportedChain();
        assembly { deployed := create2(0, add(initCode, 0x20), mload(initCode), salt) }
        if (deployed == address(0)) revert DeploymentFailed();
        emit Deployed(deployed, salt, keccak256(initCode));
    }
}
