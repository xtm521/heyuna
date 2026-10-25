// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ValidatorQuorum} from "./ValidatorQuorum.sol";

/// @notice Narrow, immutable testnet treasury: 2-of-3 signed HEYUNA payments and a fixed seven-day delay.
/// @dev No arbitrary contract calls, delegatecall, approvals, owner drain, or delay changes.
contract PublicFund is ValidatorQuorum, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant EXECUTION_DELAY = 7 days;
    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "FundPayment(address recipient,uint256 amount,bytes32 descriptionHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256(
        "CancelPayment(bytes32 paymentId,bytes32 reasonHash,uint256 deadline)"
    );
    enum PaymentState { Empty, Queued, Executed, Cancelled }
    struct Payment {
        address recipient;
        uint256 amount;
        bytes32 descriptionHash;
        uint256 executeAfter;
        PaymentState state;
    }
    IERC20 public immutable token;
    uint256 public nextNonce;
    uint256 public reserved;
    mapping(bytes32 => Payment) public payments;

    error InvalidPayment();
    error InsufficientUnreservedFunds();
    error WrongState();
    error TimelockActive();
    event PaymentQueued(bytes32 indexed paymentId, address indexed recipient, uint256 amount,
        bytes32 descriptionHash, uint256 executeAfter, uint256 nonce);
    event PaymentExecuted(bytes32 indexed paymentId);
    event PaymentCancelled(bytes32 indexed paymentId, bytes32 reasonHash);

    constructor(address expectedToken, address[3] memory members) ValidatorQuorum("HeyunaPublicFund", members) {
        if (expectedToken == address(0)) revert InvalidPayment();
        token = IERC20(expectedToken);
    }

    function queuePayment(address recipient, uint256 amount, bytes32 descriptionHash, uint256 deadline, bytes[] calldata signatures)
        external returns (bytes32 paymentId)
    {
        if (recipient == address(0) || recipient == address(this) || amount == 0 || descriptionHash == bytes32(0)) {
            revert InvalidPayment();
        }
        if (amount > token.balanceOf(address(this)) - reserved) revert InsufficientUnreservedFunds();
        uint256 nonce = nextNonce;
        bytes32 structHash = keccak256(abi.encode(PAYMENT_TYPEHASH, recipient, amount, descriptionHash, nonce, deadline));
        _requireQuorum(structHash, deadline, signatures);
        paymentId = _hashTypedDataV4(structHash);
        nextNonce += 1;
        reserved += amount;
        uint256 executeAfter = block.timestamp + EXECUTION_DELAY;
        payments[paymentId] = Payment(recipient, amount, descriptionHash, executeAfter, PaymentState.Queued);
        emit PaymentQueued(paymentId, recipient, amount, descriptionHash, executeAfter, nonce);
    }

    function executePayment(bytes32 paymentId) external nonReentrant {
        Payment storage entry = payments[paymentId];
        if (entry.state != PaymentState.Queued) revert WrongState();
        if (block.timestamp < entry.executeAfter) revert TimelockActive();
        entry.state = PaymentState.Executed;
        reserved -= entry.amount;
        token.safeTransfer(entry.recipient, entry.amount);
        emit PaymentExecuted(paymentId);
    }

    function cancelPayment(bytes32 paymentId, bytes32 reasonHash, uint256 deadline, bytes[] calldata signatures) external {
        Payment storage entry = payments[paymentId];
        if (entry.state != PaymentState.Queued || reasonHash == bytes32(0)) revert WrongState();
        _requireQuorum(keccak256(abi.encode(CANCEL_TYPEHASH, paymentId, reasonHash, deadline)), deadline, signatures);
        entry.state = PaymentState.Cancelled;
        reserved -= entry.amount;
        emit PaymentCancelled(paymentId, reasonHash);
    }
}
