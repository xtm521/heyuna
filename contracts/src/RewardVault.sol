// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ValidatorQuorum} from "./ValidatorQuorum.sol";

/// @notice Testnet reward allocation and immutable finalized Merkle claims.
/// @dev A root authenticates an allocation, NOT computation, independent operators, or model quality.
contract RewardVault is ValidatorQuorum, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant REWARD_POOL = 18_000_000 ether;
    uint256 public constant TRAINING_POOL = REWARD_POOL * 9 / 10;
    uint256 public constant VALIDATION_POOL = REWARD_POOL - TRAINING_POOL;
    uint256 public constant PLANNED_EPOCHS = 520;
    uint256 public constant WEEK = 7 days;
    uint256 public constant CHALLENGE_PERIOD = 72 hours;

    bytes32 public constant PROPOSAL_TYPEHASH = keccak256(
        "RewardProposal(uint256 epoch,bytes32 root,bytes32 manifestHash,uint256 trainingAmount,uint256 validationAmount,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CANCEL_TYPEHASH = keccak256(
        "CancelReward(uint256 epoch,bytes32 root,uint256 nonce,bytes32 reasonHash,uint256 deadline)"
    );
    bytes32 public constant UNPAUSE_TYPEHASH = keccak256("Unpause(uint256 nonce,uint256 deadline)");

    enum EpochState { Empty, Proposed, Finalized, Cancelled }
    struct Epoch {
        bytes32 root;
        bytes32 manifestHash;
        uint256 trainingAmount;
        uint256 validationAmount;
        uint256 trainingClaimed;
        uint256 validationClaimed;
        uint256 readyAt;
        uint256 nonce;
        EpochState state;
    }

    IERC20 public immutable token;
    uint256 public immutable genesis;
    uint256 public allocatedTraining;
    uint256 public allocatedValidation;
    uint256 public totalClaimed;
    uint256 public controlNonce;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(uint256 => uint256)) private claimedBitmap;

    error InvalidEpoch();
    error InvalidAllocation();
    error BudgetExceeded();
    error WrongState();
    error ChallengePeriodActive();
    error AlreadyClaimed();
    error InvalidProof();
    error InvalidEvidence();

    event EpochProposed(uint256 indexed epoch, bytes32 indexed root, bytes32 manifestHash,
        uint256 trainingAmount, uint256 validationAmount, uint256 readyAt, uint256 nonce);
    event EpochFinalized(uint256 indexed epoch, bytes32 indexed root);
    event EpochCancelled(uint256 indexed epoch, bytes32 indexed root, bytes32 reasonHash);
    event ChallengeReported(uint256 indexed epoch, bytes32 indexed root, address indexed reporter, bytes32 evidenceHash);
    event RewardClaimed(uint256 indexed epoch, uint256 indexed index, address indexed recipient, uint8 kind, uint256 amount);

    constructor(address expectedToken, address[3] memory members, uint256 start)
        ValidatorQuorum("HeyunaRewardVault", members)
    {
        if (expectedToken == address(0) || start < block.timestamp) revert InvalidAllocation();
        token = IERC20(expectedToken);
        genesis = start;
    }

    /// @notice Zero-based budget. Unused capacity is never added to a following weekly cap.
    function epochBudget(uint256 epoch) public pure returns (uint256) {
        if (epoch < PLANNED_EPOCHS) {
            return REWARD_POOL * (epoch + 1) / PLANNED_EPOCHS - REWARD_POOL * epoch / PLANNED_EPOCHS;
        }
        return (REWARD_POOL + PLANNED_EPOCHS - 1) / PLANNED_EPOCHS;
    }

    function categoryBudgets(uint256 epoch) public pure returns (uint256 training, uint256 validation) {
        uint256 budget = epochBudget(epoch);
        training = budget * 9 / 10;
        validation = budget - training;
    }

    function totalAllocated() public view returns (uint256) {
        return allocatedTraining + allocatedValidation;
    }

    /// @notice Propose only the just-completed week. Old missed weeks cannot be backfilled.
    /// @dev Anyone may relay correctly signed proposals. Finalized entries cannot be replaced.
    function proposeEpoch(
        uint256 epoch, bytes32 root, bytes32 manifestHash, uint256 trainingAmount,
        uint256 validationAmount, uint256 deadline, bytes[] calldata signatures
    ) external whenNotPaused {
        if (block.timestamp < genesis + WEEK || epoch != (block.timestamp - genesis) / WEEK - 1) {
            revert InvalidEpoch();
        }
        Epoch storage entry = epochs[epoch];
        if (entry.state != EpochState.Empty && entry.state != EpochState.Cancelled) revert WrongState();
        if (root == bytes32(0) || manifestHash == bytes32(0) || trainingAmount + validationAmount == 0) {
            revert InvalidAllocation();
        }
        (uint256 trainingCap, uint256 validationCap) = categoryBudgets(epoch);
        if (
            trainingAmount > trainingCap || validationAmount > validationCap
            || allocatedTraining + trainingAmount > TRAINING_POOL
            || allocatedValidation + validationAmount > VALIDATION_POOL
        ) revert BudgetExceeded();
        _requireQuorum(keccak256(abi.encode(PROPOSAL_TYPEHASH, epoch, root, manifestHash,
            trainingAmount, validationAmount, entry.nonce, deadline)), deadline, signatures);
        entry.root = root;
        entry.manifestHash = manifestHash;
        entry.trainingAmount = trainingAmount;
        entry.validationAmount = validationAmount;
        entry.readyAt = block.timestamp + CHALLENGE_PERIOD;
        entry.state = EpochState.Proposed;
        allocatedTraining += trainingAmount;
        allocatedValidation += validationAmount;
        emit EpochProposed(epoch, root, manifestHash, trainingAmount, validationAmount, entry.readyAt, entry.nonce);
    }

    /// @notice Public evidence log. Does not automatically freeze funds (which would permit trivial DoS).
    /// @dev Validators must investigate and pause or quorum-cancel during the challenge period.
    function reportChallenge(uint256 epoch, bytes32 evidenceHash) external {
        Epoch storage entry = epochs[epoch];
        if (entry.state != EpochState.Proposed || block.timestamp >= entry.readyAt) revert WrongState();
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        emit ChallengeReported(epoch, entry.root, msg.sender, evidenceHash);
    }

    /// @notice Quorum may cancel a pending proposal, even while paused; never a finalized root.
    function cancelEpoch(uint256 epoch, bytes32 reasonHash, uint256 deadline, bytes[] calldata signatures) external {
        Epoch storage entry = epochs[epoch];
        if (entry.state != EpochState.Proposed) revert WrongState();
        if (reasonHash == bytes32(0)) revert InvalidEvidence();
        _requireQuorum(keccak256(abi.encode(CANCEL_TYPEHASH, epoch, entry.root, entry.nonce,
            reasonHash, deadline)), deadline, signatures);
        allocatedTraining -= entry.trainingAmount;
        allocatedValidation -= entry.validationAmount;
        entry.state = EpochState.Cancelled;
        entry.nonce += 1;
        emit EpochCancelled(epoch, entry.root, reasonHash);
    }

    function finalizeEpoch(uint256 epoch) external whenNotPaused {
        Epoch storage entry = epochs[epoch];
        if (entry.state != EpochState.Proposed) revert WrongState();
        if (block.timestamp < entry.readyAt) revert ChallengePeriodActive();
        entry.state = EpochState.Finalized;
        emit EpochFinalized(epoch, entry.root);
    }

    /// @notice One validator can stop the reward subsystem. Resumption requires a fresh quorum.
    function pause() external {
        if (!isValidator[msg.sender]) revert Unauthorized();
        // Invalidate unpause signatures collected before this incident.
        controlNonce += 1;
        _pause();
    }

    function unpause(uint256 deadline, bytes[] calldata signatures) external {
        _requireQuorum(keccak256(abi.encode(UNPAUSE_TYPEHASH, controlNonce, deadline)), deadline, signatures);
        controlNonce += 1;
        _unpause();
    }

    function isClaimed(uint256 epoch, uint256 index) public view returns (bool) {
        return claimedBitmap[epoch][index >> 8] & (uint256(1) << (index & 255)) != 0;
    }

    /// @notice Claim kinds: 0 = training, 1 = independent validation. Relayers cannot redirect funds.
    function claim(uint256 epoch, uint256 index, address recipient, uint8 kind, uint256 amount, bytes32[] calldata proof)
        external whenNotPaused nonReentrant
    {
        Epoch storage entry = epochs[epoch];
        if (entry.state != EpochState.Finalized) revert WrongState();
        if (isClaimed(epoch, index)) revert AlreadyClaimed();
        if (kind > 1 || amount == 0 || recipient == address(0) || recipient == address(this)) revert InvalidAllocation();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), epoch, index, recipient, kind, amount))));
        if (!MerkleProof.verifyCalldata(proof, entry.root, leaf)) revert InvalidProof();
        if (kind == 0) {
            if (entry.trainingClaimed + amount > entry.trainingAmount) revert BudgetExceeded();
            entry.trainingClaimed += amount;
        } else {
            if (entry.validationClaimed + amount > entry.validationAmount) revert BudgetExceeded();
            entry.validationClaimed += amount;
        }
        claimedBitmap[epoch][index >> 8] |= uint256(1) << (index & 255);
        totalClaimed += amount;
        token.safeTransfer(recipient, amount);
        emit RewardClaimed(epoch, index, recipient, kind, amount);
    }
}
