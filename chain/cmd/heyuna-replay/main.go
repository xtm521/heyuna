// Offline ABCI historical re-execution. This command never opens a socket or
// loads consensus/signing keys. It is not a consensus-signature verifier.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"cosmossdk.io/log/v2"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	cmtstate "github.com/cometbft/cometbft/state"
	cmttypes "github.com/cometbft/cometbft/types"
	dbm "github.com/cosmos/cosmos-db"
	"github.com/cosmos/cosmos-sdk/baseapp"
	sdk "github.com/cosmos/cosmos-sdk/types"
	srvflags "github.com/cosmos/evm/server/flags"
	evmd "github.com/heyuna/chain/app"
	"github.com/heyuna/chain/config"
)

type options map[string]interface{}

func (o options) Get(key string) interface{} { return o[key] }

type history struct {
	Genesis       json.RawMessage     `json:"genesis"`
	EVMChainID    uint64              `json:"evm_chain_id"`
	Blocks        []json.RawMessage   `json:"blocks"`
	ValidatorSets [][]json.RawMessage `json:"validator_sets"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	input := flag.String("history", "", "read-only history bundle")
	statePath := flag.String("state", "", "isolated application DB (never a live node home)")
	crash := flag.Int64("crash-after-finalize", 0, "research failure injection: exit 75 before committing this height")
	flag.Parse()
	if *input == "" || *statePath == "" {
		return fmt.Errorf("history and isolated state path required")
	}
	if _, err := os.Stat(filepath.Join(*statePath, "config")); err == nil {
		return fmt.Errorf("refusing a node home containing config")
	}
	raw, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	var h history
	if err = json.Unmarshal(raw, &h); err != nil {
		return err
	}
	if len(h.Blocks) < 2 || len(h.ValidatorSets) != len(h.Blocks)-1 {
		return fmt.Errorf("incomplete bounded history")
	}
	var genesis cmttypes.GenesisDoc
	if err = cmtjson.Unmarshal(h.Genesis, &genesis); err != nil {
		return err
	}
	if (genesis.ChainID != "heyuna_297011-1" || h.EVMChainID != 297011) && (genesis.ChainID != "heyuna_297012-1" || h.EVMChainID != 297012) {
		return fmt.Errorf("unsupported chain identity")
	}
	cfg := sdk.GetConfig()
	config.SetBech32Prefixes(cfg)
	cfg.Seal()
	if err = os.MkdirAll(*statePath, 0700); err != nil {
		return err
	}
	database, err := dbm.NewDB("application", dbm.GoLevelDBBackend, *statePath)
	if err != nil {
		return err
	}
	defer database.Close()
	app := evmd.NewExampleApp(log.NewNopLogger(), database, true, options{srvflags.EVMChainID: h.EVMChainID, "home": *statePath}, baseapp.SetChainID(genesis.ChainID), baseapp.SetMinGasPrices("0aheyuna"))
	info, err := app.Info(&abci.RequestInfo{})
	if err != nil {
		return err
	}
	resumedAt := info.LastBlockHeight
	if info.LastBlockHeight == 0 {
		params := genesis.ConsensusParams.ToProto()
		if _, err = app.InitChain(&abci.RequestInitChain{ChainId: genesis.ChainID, Time: genesis.GenesisTime, InitialHeight: genesis.InitialHeight, ConsensusParams: &params, AppStateBytes: genesis.AppState}); err != nil {
			return err
		}
	}
	var checked int64
	for i := 0; i < len(h.Blocks)-1; i++ {
		var block, next cmttypes.Block
		if err = cmtjson.Unmarshal(h.Blocks[i], &block); err != nil {
			return err
		}
		if err = cmtjson.Unmarshal(h.Blocks[i+1], &next); err != nil {
			return err
		}
		if block.Height <= info.LastBlockHeight {
			continue
		}
		if block.Height != int64(i)+genesis.InitialHeight || next.Height != block.Height+1 {
			return fmt.Errorf("non-contiguous history")
		}
		if !bytes.Equal(next.LastBlockID.Hash, block.Hash()) {
			return fmt.Errorf("history block linkage mismatch at %d", block.Height)
		}
		vals := make([]*cmttypes.Validator, len(h.ValidatorSets[i]))
		for j, v := range h.ValidatorSets[i] {
			vals[j] = new(cmttypes.Validator)
			if err = cmtjson.Unmarshal(v, vals[j]); err != nil {
				return err
			}
		}
		commit := abci.CommitInfo{}
		if block.Height != genesis.InitialHeight {
			commit = cmtstate.BuildLastCommitInfo(&block, cmttypes.NewValidatorSet(vals), genesis.InitialHeight)
		}
		result, err := app.FinalizeBlock(&abci.RequestFinalizeBlock{Hash: block.Hash(), Height: block.Height, Time: block.Time, ProposerAddress: block.ProposerAddress, NextValidatorsHash: block.NextValidatorsHash, DecidedLastCommit: commit, Misbehavior: block.Evidence.Evidence.ToABCI(), Txs: block.Txs.ToSliceOfBytes()})
		if err != nil {
			return fmt.Errorf("finalize %d: %w", block.Height, err)
		}
		if !bytes.Equal(result.AppHash, next.AppHash) {
			return fmt.Errorf("app hash mismatch at %d: replay=%X committed=%X", block.Height, result.AppHash, next.AppHash)
		}
		if *crash == block.Height {
			fmt.Fprintf(os.Stderr, "intentional interruption after FinalizeBlock %d before Commit\n", block.Height)
			os.Exit(75)
		}
		if _, err = app.Commit(); err != nil {
			return err
		}
		checked++
	}
	final, err := app.Info(&abci.RequestInfo{})
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"mode": "same-version-offline-ABCI-replay", "chain_id": genesis.ChainID, "resumed_after_height": resumedAt, "checked_blocks": checked, "final_height": final.LastBlockHeight, "app_hash": hex.EncodeToString(final.LastBlockAppHash), "network_access": false, "signing_keys_loaded": false, "cross_version_upgrade_proven": false})
}
