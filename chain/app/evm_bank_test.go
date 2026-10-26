package evmd

import (
	"bytes"
	"math/big"
	"testing"

	"cosmossdk.io/log/v2"
	sdkmath "cosmossdk.io/math"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/ethereum/go-ethereum/common"
	"github.com/holiman/uint256"
	"github.com/stretchr/testify/require"
)

func TestEVMBalanceDecreaseUpdatesSupplyAndPreventsRemint(t *testing.T) {
	require.NoError(t, evmtypes.NewEVMConfigurator().WithEVMCoinInfo(evmtypes.EvmCoinInfo{Denom: "aheyuna", ExtendedDenom: "aheyuna", DisplayDenom: "tHEYUNA", Decimals: 18}).Configure())
	app := NewExampleApp(log.NewNopLogger(), dbm.NewMemDB(), true, simtestutil.EmptyAppOptions{})
	ctx := sdk.NewContext(app.CommitMultiStore(), cmtproto.Header{ChainID: "heyuna_297012-1"}, false, log.NewNopLogger())
	app.AccountKeeper.GetModuleAccount(ctx, "evm")
	sender := sdk.AccAddress(bytes.Repeat([]byte{3}, 20))
	require.NoError(t, app.BankKeeper.MintCoins(ctx, "evm", sdk.NewCoins(sdk.NewCoin("aheyuna", genesisSupply()))))
	require.NoError(t, app.BankKeeper.SendCoinsFromModuleToAccount(ctx, "evm", sender, sdk.NewCoins(sdk.NewCoin("aheyuna", genesisSupply()))))
	require.NoError(t, app.enforceSupplyCap(ctx))
	require.NoError(t, app.EVMKeeper.SetBalance(ctx, common.BytesToAddress(sender), uint256.MustFromBig(genesisSupply().SubRaw(1).BigInt())))
	require.Equal(t, genesisSupply().SubRaw(1).String(), app.BankKeeper.GetSupply(ctx, "aheyuna").Amount.String())
	require.NoError(t, app.enforceSupplyCap(ctx))
	require.NoError(t, app.BankKeeper.MintCoins(ctx, "evm", sdk.NewCoins(sdk.NewInt64Coin("aheyuna", 1))))
	require.ErrorContains(t, app.enforceSupplyCap(ctx), "exceeds previous committed")
}

func TestEVMSupplyAdapterTransferCacheAndNativeMintBurn(t *testing.T) {
	app := NewExampleApp(log.NewNopLogger(), dbm.NewMemDB(), true, simtestutil.EmptyAppOptions{})
	ctx := sdk.NewContext(app.CommitMultiStore(), cmtproto.Header{ChainID: "heyuna_297012-1"}, false, log.NewNopLogger())
	app.AccountKeeper.GetModuleAccount(ctx, "evm")
	bank := newEVMSupplyBank(app.BankKeeper)
	sender, receiver := sdk.AccAddress(bytes.Repeat([]byte{3}, 20)), sdk.AccAddress(bytes.Repeat([]byte{4}, 20))
	coin := func(n int64) sdk.Coins { return sdk.NewCoins(sdk.NewInt64Coin("aheyuna", n)) }
	require.NoError(t, bank.MintCoins(ctx, "evm", coin(100)))
	require.Equal(t, "100", bank.GetSupply(ctx, "aheyuna").Amount.String(), "SDK mint counted exactly once")
	require.NoError(t, bank.SendCoinsFromModuleToAccount(ctx, "evm", sender, coin(100)))
	// Recipient-first iteration temporarily increases the counter. Only the
	// complete transfer must conserve supply; imposing the cap here is invalid.
	require.NoError(t, bank.UncheckedSetBalance(ctx, receiver, sdk.NewInt64Coin("aheyuna", 20)))
	require.Equal(t, "120", bank.GetSupply(ctx, "aheyuna").Amount.String())
	require.NoError(t, bank.UncheckedSetBalance(ctx, sender, sdk.NewInt64Coin("aheyuna", 80)))
	require.NoError(t, bank.UncheckedSetBalance(ctx, sender, sdk.NewInt64Coin("aheyuna", 80)))
	require.Equal(t, "100", bank.GetSupply(ctx, "aheyuna").Amount.String(), "repeat precompile flush has zero delta")
	// A discarded outer transaction discards both balance and supply writes,
	// even though the nested adapter cache has completed.
	discarded, _ := ctx.CacheContext()
	require.NoError(t, bank.UncheckedSetBalance(discarded, sender, sdk.NewInt64Coin("aheyuna", 79)))
	require.Equal(t, "99", bank.GetSupply(discarded, "aheyuna").Amount.String())
	require.Equal(t, "100", bank.GetSupply(ctx, "aheyuna").Amount.String())
	require.Equal(t, "80", bank.GetBalance(ctx, sender, "aheyuna").Amount.String())
	require.NoError(t, bank.SendCoinsFromAccountToModule(ctx, sender, "evm", coin(2)))
	require.NoError(t, bank.BurnCoins(ctx, "evm", coin(2)))
	require.Equal(t, "98", bank.GetSupply(ctx, "aheyuna").Amount.String(), "SDK burn counted exactly once")
	require.NoError(t, bank.UncheckedSetBalance(ctx, sender, sdk.NewInt64Coin("aheyuna", 0)))
	require.NoError(t, bank.UncheckedSetBalance(ctx, receiver, sdk.NewInt64Coin("aheyuna", 0)))
	require.False(t, bank.HasSupply(ctx, "aheyuna"), "zero supply is removed like the SDK native burn path")
}

func TestEVMSupplyAdapterRejectsInvalidAndOverflowWithoutBalanceWrites(t *testing.T) {
	app := NewExampleApp(log.NewNopLogger(), dbm.NewMemDB(), true, simtestutil.EmptyAppOptions{})
	ctx := sdk.NewContext(app.CommitMultiStore(), cmtproto.Header{ChainID: "heyuna_297012-1"}, false, log.NewNopLogger())
	bank := newEVMSupplyBank(app.BankKeeper)
	addr := sdk.AccAddress(bytes.Repeat([]byte{3}, 20))
	for _, invalid := range []sdk.Coin{{Denom: "aheyuna"}, {Denom: "aheyuna", Amount: sdkmath.NewInt(-1)}, sdk.NewInt64Coin("other", 1)} {
		require.Error(t, bank.UncheckedSetBalance(ctx, addr, invalid))
	}
	maximum := sdkmath.NewIntFromBigInt(new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1)))
	require.NoError(t, bank.Supply.Set(ctx, "aheyuna", maximum))
	require.ErrorContains(t, bank.UncheckedSetBalance(ctx, addr, sdk.NewInt64Coin("aheyuna", 1)), "overflow")
	require.True(t, bank.GetBalance(ctx, addr, "aheyuna").IsZero())
	require.Equal(t, maximum.String(), bank.GetSupply(ctx, "aheyuna").Amount.String())
	// Deliberately corrupt only the test fixture to verify defensive underflow
	// handling never partially mutates the account when counters disagree.
	require.NoError(t, bank.BaseKeeper.UncheckedSetBalance(ctx, addr, sdk.NewInt64Coin("aheyuna", 1)))
	require.NoError(t, bank.Supply.Set(ctx, "aheyuna", sdkmath.ZeroInt()))
	require.ErrorContains(t, bank.UncheckedSetBalance(ctx, addr, sdk.NewInt64Coin("aheyuna", 0)), "underflow")
	require.Equal(t, "1", bank.GetBalance(ctx, addr, "aheyuna").Amount.String())
	require.True(t, bank.GetSupply(ctx, "aheyuna").IsZero())
}
