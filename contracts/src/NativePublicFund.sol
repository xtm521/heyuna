// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Research treasury: immutable 3-of-5 authorization, seven-day native-coin payments.
/// @dev A fixed genesis faucet grant counts towards the public fund's two-million allocation.
contract NativePublicFund is EIP712, ReentrancyGuard {
    uint256 public constant THRESHOLD = 3;
    uint256 public constant EXECUTION_DELAY = 7 days;
    uint256 public constant FAUCET_GRANT = 100_000 ether;
    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "FundPayment(address recipient,uint256 amount,bytes32 descriptionHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256(
        "CancelPayment(bytes32 paymentId,bytes32 reasonHash,uint256 deadline)"
    );
    address[5] public managers;
    mapping(address => bool) public isManager;
    uint256 public nextNonce;
    uint256 public reserved;
    enum PaymentState { Empty, Queued, Executed, Cancelled }
    struct Payment {
        address recipient;
        uint256 amount;
        bytes32 descriptionHash;
        uint256 executeAfter;
        PaymentState state;
    }
    mapping(bytes32 => Payment) public payments;

    error UnsupportedChain();
    error InvalidManagers();
    error InvalidQuorum();
    error SignatureExpired();
    error InvalidPayment();
    error InsufficientUnreservedFunds();
    error WrongState();
    error TimelockActive();
    error TransferFailed();
    event GenesisFaucetGrant(address indexed faucet, uint256 amount);
    event PaymentQueued(bytes32 indexed paymentId, address indexed recipient, uint256 amount,
        bytes32 descriptionHash, uint256 executeAfter, uint256 nonce);
    event PaymentExecuted(bytes32 indexed paymentId);
    event PaymentCancelled(bytes32 indexed paymentId, bytes32 reasonHash);

    constructor(address[5] memory members, address faucet) EIP712("HeyunaNativePublicFund", "2") {
        if (block.chainid != 297011 && block.chainid != 297012) revert UnsupportedChain();
        for (uint256 i; i < members.length; ++i) {
            address member = members[i];
            if (member == address(0) || isManager[member]) revert InvalidManagers();
            managers[i] = member;
            isManager[member] = true;
        }
        if (faucet == address(0) || faucet == address(this)
            || address(this).balance < 2_000_000 ether) revert InvalidPayment();
        (bool success,) = faucet.call{value: FAUCET_GRANT}("");
        if (!success) revert TransferFailed();
        emit GenesisFaucetGrant(faucet, FAUCET_GRANT);
    }

    receive() external payable {}

    function _requireQuorum(bytes32 structHash, uint256 deadline, bytes[] calldata signatures) private view {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (signatures.length < THRESHOLD || signatures.length > 5) revert InvalidQuorum();
        bytes32 digest = _hashTypedDataV4(structHash);
        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = ECDSA.recover(digest, signatures[i]);
            if (!isManager[signer] || signer <= previous) revert InvalidQuorum();
            previous = signer;
        }
    }

    function queuePayment(address recipient, uint256 amount, bytes32 descriptionHash,
        uint256 deadline, bytes[] calldata signatures) external returns (bytes32 paymentId)
    {
        if (recipient == address(0) || recipient == address(this) || amount == 0
            || descriptionHash == bytes32(0)) revert InvalidPayment();
        if (amount > address(this).balance - reserved) revert InsufficientUnreservedFunds();
        uint256 nonce = nextNonce;
        bytes32 structHash = keccak256(abi.encode(PAYMENT_TYPEHASH, recipient, amount, descriptionHash, nonce, deadline));
        _requireQuorum(structHash, deadline, signatures);
        paymentId = _hashTypedDataV4(structHash);
        nextNonce += 1;
        reserved += amount;
        payments[paymentId] = Payment(recipient, amount, descriptionHash,
            block.timestamp + EXECUTION_DELAY, PaymentState.Queued);
        emit PaymentQueued(paymentId, recipient, amount, descriptionHash,
            block.timestamp + EXECUTION_DELAY, nonce);
    }

    function executePayment(bytes32 paymentId) external nonReentrant {
        Payment storage entry = payments[paymentId];
        if (entry.state != PaymentState.Queued) revert WrongState();
        if (block.timestamp < entry.executeAfter) revert TimelockActive();
        entry.state = PaymentState.Executed;
        reserved -= entry.amount;
        (bool success,) = entry.recipient.call{value: entry.amount}("");
        if (!success) revert TransferFailed();
        emit PaymentExecuted(paymentId);
    }

    function cancelPayment(bytes32 paymentId, bytes32 reasonHash, uint256 deadline,
        bytes[] calldata signatures) external
    {
        Payment storage entry = payments[paymentId];
        if (entry.state != PaymentState.Queued || reasonHash == bytes32(0)) revert WrongState();
        _requireQuorum(keccak256(abi.encode(CANCEL_TYPEHASH, paymentId, reasonHash, deadline)), deadline, signatures);
        entry.state = PaymentState.Cancelled;
        reserved -= entry.amount;
        emit PaymentCancelled(paymentId, reasonHash);
    }
}
