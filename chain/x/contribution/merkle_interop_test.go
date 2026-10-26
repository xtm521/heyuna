// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

func TestOpenZeppelinNativeBundleInteroperability(t *testing.T) {
	var fixtures struct {
		Source  string `json:"source"`
		Vectors []struct {
			Size    int     `json:"size"`
			ChainID uint64  `json:"chain_id"`
			Epoch   uint64  `json:"epoch"`
			Vault   string  `json:"vault"`
			Root    string  `json:"root"`
			Entries []Entry `json:"entries"`
			Claims  []struct {
				Index string   `json:"index"`
				Proof []string `json:"proof"`
			} `json:"claims"`
		} `json:"vectors"`
	}
	b, err := os.ReadFile("testdata/native-merkle-vectors.json")
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(b, &fixtures))
	for _, v := range fixtures.Vectors {
		t.Run(strconv.Itoa(v.Size)+"-leaves", func(t *testing.T) {
			c := Config{EVMChainID: v.ChainID, VaultAddress: v.Vault}
			root, err := RewardRoot(c, v.Epoch, v.Entries)
			require.NoError(t, err)
			require.Equal(t, v.Root, root.Hex())
			require.Len(t, v.Claims, v.Size)
			for _, claim := range v.Claims {
				index, err := strconv.Atoi(claim.Index)
				require.NoError(t, err)
				leaf, err := RewardLeaf(c, v.Epoch, v.Entries[index])
				require.NoError(t, err)
				computed := leaf
				for _, sibling := range claim.Proof {
					a, b := computed, common.HexToHash(sibling)
					if bytes.Compare(a[:], b[:]) > 0 {
						a, b = b, a
					}
					computed = crypto.Keccak256Hash(a[:], b[:])
				}
				require.Equal(t, root, computed, "OpenZeppelin-generated proof must verify Go-generated leaf")
			}
		})
	}
}
