// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

// TEST ONLY: injectable oracle, never part of the chain or a deployed manifest.
contract MockNativeOracle {
    struct Epoch { bytes32 root; uint256 training; uint256 verification; bool finalized; }
    mapping(uint256 => Epoch) public epochs;
    function setEpoch(uint256 epoch, bytes32 root, uint256 training, uint256 verification, bool finalized) external {
        epochs[epoch] = Epoch(root, training, verification, finalized);
    }
    function getEpoch(uint256 epoch) external view returns (bytes32, uint256, uint256, bool) {
        Epoch storage e = epochs[epoch];
        return (e.root, e.training, e.verification, e.finalized);
    }
}

contract NativeReentrantReceiver {
    address public vault;
    bytes public payload;
    bool public reentrySucceeded;
    bool public rejectTransfers;
    function configure(address target, bytes calldata data, bool reject) external {
        vault = target; payload = data; rejectTransfers = reject;
    }
    receive() external payable {
        require(!rejectTransfers, "fixture rejects transfer");
        (reentrySucceeded,) = vault.call(payload);
    }
}
