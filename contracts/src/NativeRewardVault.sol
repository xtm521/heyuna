// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.38;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IContributionOracle {
    function getEpoch(uint256 epoch) external view returns (
        bytes32 root, uint256 trainingBudget, uint256 verificationBudget, bool finalized
    );
}

/// @notice Immutable native-coin claims against the chain's finalized contribution records.
/// @dev The oracle authenticates authorized allocations, not the truth or usefulness of training.
contract NativeRewardVault is ReentrancyGuard {
    uint256 public constant REWARD_POOL = 14_000_000 ether;
    uint256 public constant TRAINING_POOL = 12_600_000 ether;
    uint256 public constant VERIFICATION_POOL = 1_400_000 ether;
    uint256 public constant PLANNED_EPOCHS = 520;
    address public constant CONTRIBUTION_ORACLE = address(0x0900);
    uint256 public totalClaimed;
    uint256 public trainingClaimed;
    uint256 public verificationClaimed;
    mapping(uint256 => mapping(uint256 => uint256)) private claimedBitmap;
    mapping(uint256 => uint256) public epochTrainingClaimed;
    mapping(uint256 => uint256) public epochVerificationClaimed;

    error UnsupportedChain();
    error NotFinalized();
    error InvalidAllocation();
    error AlreadyClaimed();
    error InvalidProof();
    error BudgetExceeded();
    error TransferFailed();
    event RewardClaimed(uint256 indexed epoch, uint256 indexed index, address indexed recipient,
        uint8 category, uint256 amount, bytes32 contributionId);

    constructor() {
        if (block.chainid != 297011 && block.chainid != 297012) revert UnsupportedChain();
    }

    receive() external payable {}

    function epochBudget(uint256 epoch) public pure returns (uint256) {
        if (epoch < PLANNED_EPOCHS) {
            return REWARD_POOL * (epoch + 1) / PLANNED_EPOCHS - REWARD_POOL * epoch / PLANNED_EPOCHS;
        }
        return (REWARD_POOL + PLANNED_EPOCHS - 1) / PLANNED_EPOCHS;
    }

    function isClaimed(uint256 epoch, uint256 index) public view returns (bool) {
        return claimedBitmap[epoch][index >> 8] & (uint256(1) << (index & 255)) != 0;
    }

    function claim(uint256 epoch, uint256 index, address recipient, uint8 category,
        uint256 amount, bytes32 contributionId, bytes32[] calldata proof) external nonReentrant
    {
        if (isClaimed(epoch, index)) revert AlreadyClaimed();
        if (category > 1 || amount == 0 || recipient == address(0) || recipient == address(this)
            || contributionId == bytes32(0) || proof.length > 64) revert InvalidAllocation();
        (bytes32 root, uint256 trainingBudget, uint256 verificationBudget, bool finalized) =
            IContributionOracle(CONTRIBUTION_ORACLE).getEpoch(epoch);
        if (!finalized || root == bytes32(0)) revert NotFinalized();
        uint256 cap = epochBudget(epoch);
        if (trainingBudget > cap * 9 / 10 || verificationBudget > cap - cap * 9 / 10) {
            revert BudgetExceeded();
        }
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(
            block.chainid, address(this), epoch, category, index, recipient, amount, contributionId
        ))));
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert InvalidProof();
        if (category == 0) {
            if (epochTrainingClaimed[epoch] + amount > trainingBudget
                || trainingClaimed + amount > TRAINING_POOL) revert BudgetExceeded();
            epochTrainingClaimed[epoch] += amount;
            trainingClaimed += amount;
        } else {
            if (epochVerificationClaimed[epoch] + amount > verificationBudget
                || verificationClaimed + amount > VERIFICATION_POOL) revert BudgetExceeded();
            epochVerificationClaimed[epoch] += amount;
            verificationClaimed += amount;
        }
        if (totalClaimed + amount > REWARD_POOL) revert BudgetExceeded();
        claimedBitmap[epoch][index >> 8] |= uint256(1) << (index & 255);
        totalClaimed += amount;
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
        emit RewardClaimed(epoch, index, recipient, category, amount, contributionId);
    }
}
