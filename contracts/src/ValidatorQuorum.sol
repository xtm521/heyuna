// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Immutable testnet 2-of-3 EOA quorum. Never represents independent people by itself.
abstract contract ValidatorQuorum is EIP712 {
    uint256 public constant THRESHOLD = 2;
    address[3] public validators;
    mapping(address => bool) public isValidator;

    error InvalidValidators();
    error InvalidQuorum();
    error SignatureExpired();
    error Unauthorized();

    constructor(string memory domainName, address[3] memory members) EIP712(domainName, "1") {
        for (uint256 i; i < members.length; ++i) {
            address member = members[i];
            if (member == address(0) || isValidator[member]) revert InvalidValidators();
            validators[i] = member;
            isValidator[member] = true;
        }
    }

    /// @dev Sorted, distinct recovered addresses prevent counting a signer twice.
    function _requireQuorum(bytes32 structHash, uint256 deadline, bytes[] calldata signatures)
        internal
        view
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (signatures.length < THRESHOLD || signatures.length > 3) revert InvalidQuorum();
        bytes32 digest = _hashTypedDataV4(structHash);
        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!isValidator[signer] || signer <= previous) revert InvalidQuorum();
            previous = signer;
        }
    }
}
