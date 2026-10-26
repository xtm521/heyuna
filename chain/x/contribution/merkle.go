// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"bytes"
	"math/big"
	"sort"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

var leafArguments = func() abi.Arguments {
	uintType, _ := abi.NewType("uint256", "", nil)
	categoryType, _ := abi.NewType("uint8", "", nil)
	addressType, _ := abi.NewType("address", "", nil)
	hashType, _ := abi.NewType("bytes32", "", nil)
	return abi.Arguments{{Type: uintType}, {Type: addressType}, {Type: uintType}, {Type: categoryType}, {Type: uintType}, {Type: addressType}, {Type: uintType}, {Type: hashType}}
}()

// RewardLeaf matches Solidity keccak256(bytes.concat(keccak256(abi.encode(
// chainId, vault, epoch, category, index, recipient, amount, contributionId)))).
// The extra hash avoids interpreting an encoded leaf as a sorted internal node.
func RewardLeaf(c Config, epoch uint64, entry Entry) (common.Hash, error) {
	if err := validateEntry(entry); err != nil {
		return common.Hash{}, err
	}
	a, _ := amount(entry.Amount)
	encoded, err := leafArguments.Pack(new(big.Int).SetUint64(c.EVMChainID), common.HexToAddress(c.VaultAddress), new(big.Int).SetUint64(epoch), entry.Category, new(big.Int).SetUint64(uint64(entry.Index)), common.HexToAddress(entry.Recipient), a, common.HexToHash(entry.ReceiptID))
	if err != nil {
		return common.Hash{}, err
	}
	return crypto.Keccak256Hash(crypto.Keccak256(encoded)), nil
}

// RewardRoot exactly follows OpenZeppelin StandardMerkleTree 1.0.8: sort the
// double-hashed leaves, place them in reverse order at the bottom of a complete
// binary heap, then hash lexicographically sorted child pairs up to the root.
// This is deliberately not the odd-node-carry construction.
func RewardRoot(c Config, epoch uint64, entries []Entry) (common.Hash, error) {
	leaves := make([]common.Hash, len(entries))
	for i, e := range entries {
		h, err := RewardLeaf(c, epoch, e)
		if err != nil {
			return common.Hash{}, err
		}
		leaves[i] = h
	}
	if len(leaves) == 0 {
		return common.Hash{}, nil
	}
	sort.Slice(leaves, func(i, j int) bool { return bytes.Compare(leaves[i][:], leaves[j][:]) < 0 })
	tree := make([]common.Hash, 2*len(leaves)-1)
	for i, leaf := range leaves {
		tree[len(tree)-1-i] = leaf
	}
	for i := len(leaves) - 2; i >= 0; i-- {
		a, b := tree[2*i+1], tree[2*i+2]
		if bytes.Compare(a[:], b[:]) > 0 {
			a, b = b, a
		}
		tree[i] = crypto.Keccak256Hash(a[:], b[:])
	}
	return tree[0], nil
}
