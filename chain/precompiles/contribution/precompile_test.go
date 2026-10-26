// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"math/big"
	"strings"
	"testing"
	"time"

	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	"github.com/cosmos/cosmos-sdk/testutil"
	"github.com/cosmos/evm/x/vm/statedb"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	contribution "github.com/heyuna/chain/x/contribution"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"
)

func TestReadOnlyABIStateAndBounds(t *testing.T) {
	key := storetypes.NewKVStoreKey(contribution.ModuleName)
	ctx := testutil.DefaultContext(key, storetypes.NewTransientStoreKey("test_t")).WithChainID("heyuna_297011-1").WithBlockTime(time.Unix(1_800_000_000, 0))
	k := contribution.NewKeeper(key)
	c := contribution.Config{Version: 1, ChainID: ctx.ChainID(), EVMChainID: 297011, NetworkDomain: "0x" + strings.Repeat("a", 64), VaultAddress: "0x0000000000000000000000000000000000001000", Verifiers: []string{"0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"}, StartTime: ctx.BlockTime().Unix(), ChallengeSeconds: 259200}
	require.NoError(t, k.InitGenesis(ctx, contribution.GenesisState{Config: c}))
	p := NewPrecompile(k)
	before := k.ExportGenesis(ctx)
	input, err := ABI.Pack("getEpoch", big.NewInt(0))
	require.NoError(t, err)
	out, err := p.Execute(ctx, input, false)
	require.NoError(t, err)
	require.Len(t, out, 128)
	decoded, err := ABI.Methods["getEpoch"].Outputs.Unpack(out)
	require.NoError(t, err)
	require.Equal(t, [32]byte{}, decoded[0])
	require.False(t, decoded[3].(bool))
	network, err := ABI.Pack("getNetwork")
	require.NoError(t, err)
	out, err = p.Execute(ctx, network, false)
	require.NoError(t, err)
	require.Len(t, out, 160)
	decoded, err = ABI.Methods["getNetwork"].Outputs.Unpack(out)
	require.NoError(t, err)
	require.Equal(t, big.NewInt(297011), decoded[0])
	require.Equal(t, common.HexToAddress(c.VaultAddress), decoded[2])
	require.False(t, decoded[4].(bool))
	for _, bad := range [][]byte{nil, {1}, {1, 2, 3}, {1, 2, 3, 4}, append(input, 0), input[:len(input)-1], append(network, make([]byte, 32)...)} {
		_, err := p.Execute(ctx, bad, false)
		require.Error(t, err)
	}
	_, err = p.Execute(ctx, input, true)
	require.Error(t, err)
	huge, _ := ABI.Pack("getEpoch", new(big.Int).Lsh(big.NewInt(1), 64))
	_, err = p.Execute(ctx, huge, false)
	require.Error(t, err)
	require.Equal(t, before, k.ExportGenesis(ctx), "views including malformed requests must not write native state")
	require.Equal(t, common.HexToAddress(Address), p.Address())
	require.GreaterOrEqual(t, p.RequiredGas(nil), uint64(5000))
	require.LessOrEqual(t, p.RequiredGas(make([]byte, 1_000_000)), uint64(55_000))
}

// Only KVStoreKeys is reachable in this test's genuine SDK-backed StateDB.
// Other Keeper methods intentionally remain nil: an unexpected balance/account
// write from the read-only precompile fails the test immediately.
type sdkReadStore struct {
	statedb.Keeper
	keys map[string]storetypes.StoreKey
}

func (s sdkReadStore) KVStoreKeys() map[string]storetypes.StoreKey { return s.keys }

func TestSDKNativeRunGasAndStaticCallFlag(t *testing.T) {
	key := storetypes.NewKVStoreKey(contribution.ModuleName)
	ctx := testutil.DefaultContext(key, storetypes.NewTransientStoreKey("native_t")).WithChainID("heyuna_297011-1").WithBlockTime(time.Unix(1_800_000_000, 0)).WithGasMeter(storetypes.NewInfiniteGasMeter())
	k := contribution.NewKeeper(key)
	c := contribution.Config{Version: 1, ChainID: ctx.ChainID(), EVMChainID: 297011, NetworkDomain: "0x" + strings.Repeat("b", 64), VaultAddress: "0x0000000000000000000000000000000000001000", Verifiers: []string{"0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"}, StartTime: ctx.BlockTime().Unix(), ChallengeSeconds: 259200}
	require.NoError(t, k.InitGenesis(ctx, contribution.GenesisState{Config: c}))
	// Precompile wrapper accounts for gas already consumed by the outer EVM.
	ctx = ctx.WithGasMeter(storetypes.NewInfiniteGasMeter())
	p := NewPrecompile(k)
	input, _ := ABI.Pack("getNetwork")
	before := k.ExportGenesis(ctx)
	for _, readonly := range []bool{false, true} {
		db := statedb.New(ctx, sdkReadStore{keys: map[string]storetypes.StoreKey{contribution.ModuleName: key}}, statedb.NewEmptyTxConfig())
		evm := &vm.EVM{StateDB: db}
		contract := vm.NewContract(common.Address{}, p.Address(), uint256.NewInt(0), 100_000, nil)
		contract.Input = input
		out, err := p.Run(evm, contract, readonly)
		require.NoError(t, err)
		require.Len(t, out, 160)
		require.Less(t, contract.Gas, uint64(100_000), "SDK reads must consume EVM gas")
		require.NoError(t, db.Commit())
		require.Equal(t, before, k.ExportGenesis(ctx))
	}
	ctx = ctx.WithGasMeter(storetypes.NewInfiniteGasMeter())
	db := statedb.New(ctx, sdkReadStore{keys: map[string]storetypes.StoreKey{contribution.ModuleName: key}}, statedb.NewEmptyTxConfig())
	evm := &vm.EVM{StateDB: db}
	contract := vm.NewContract(common.Address{}, p.Address(), uint256.NewInt(0), 1, nil)
	contract.Input = input
	_, err := p.Run(evm, contract, true)
	require.ErrorIs(t, err, vm.ErrOutOfGas)
	require.Equal(t, before, k.ExportGenesis(ctx))
	// Invalid ABI returns standard EVM revert data, rather than a Go panic.
	db = statedb.New(ctx, sdkReadStore{keys: map[string]storetypes.StoreKey{contribution.ModuleName: key}}, statedb.NewEmptyTxConfig())
	evm = &vm.EVM{StateDB: db}
	contract = vm.NewContract(common.Address{}, p.Address(), uint256.NewInt(0), 100_000, nil)
	contract.Input = []byte{0xff, 0xff, 0xff, 0xff}
	out, err := p.Run(evm, contract, true)
	require.ErrorIs(t, err, vm.ErrExecutionReverted)
	require.Greater(t, len(out), 4)
	require.Equal(t, before, k.ExportGenesis(ctx))
}
