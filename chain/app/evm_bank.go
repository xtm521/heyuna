package evmd

import (
	"context"
	"fmt"
	"math/big"

	sdkmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/heyuna/chain/config"
)

// Cosmos EVM v0.7.3 writes StateDB balances through UncheckedSetBalance,
// which deliberately does not maintain the SDK supply counter. Ordinary
// transfers cancel out, but destruction of a balance must reduce supply.
// This adapter maintains that counter at the actual balance-write boundary,
// without guessing from opcodes, receipts, traces, or transaction status.
type evmSupplyBank struct{ bankkeeper.BaseKeeper }

var _ evmtypes.BankKeeper = evmSupplyBank{}

func newEVMSupplyBank(bank bankkeeper.Keeper) evmSupplyBank {
	base, ok := bank.(bankkeeper.BaseKeeper)
	if !ok {
		panic("research EVM supply accounting requires the configured SDK BaseKeeper")
	}
	return evmSupplyBank{BaseKeeper: base}
}

func (bank evmSupplyBank) UncheckedSetBalance(goctx context.Context, addr sdk.AccAddress, balance sdk.Coin) error {
	if balance.Amount.IsNil() || !balance.IsValid() || balance.Denom != config.BaseDenom || len(addr) != 20 {
		return fmt.Errorf("invalid native EVM balance write")
	}
	ctx, write := sdk.UnwrapSDKContext(goctx).CacheContext()
	previous := bank.GetBalance(ctx, addr, balance.Denom).Amount
	delta := new(big.Int).Sub(balance.Amount.BigInt(), previous.BigInt())
	supply := new(big.Int).Add(bank.GetSupply(ctx, balance.Denom).Amount.BigInt(), delta)
	if supply.Sign() < 0 || supply.BitLen() > 256 {
		return fmt.Errorf("native EVM supply underflow or overflow")
	}
	if err := bank.BaseKeeper.UncheckedSetBalance(ctx, addr, balance); err != nil {
		return err
	}
	if delta.Sign() != 0 {
		var err error
		if supply.Sign() == 0 {
			err = bank.Supply.Remove(ctx, balance.Denom)
		} else {
			err = bank.Supply.Set(ctx, balance.Denom, sdkmath.NewIntFromBigInt(supply))
		}
		if err != nil {
			return err
		}
	}
	write()
	return nil
}

// MintCoins, BurnCoins, regular SDK transfers, and virtual fee escrow methods
// remain the embedded SDK implementations. Their existing supply accounting is
// not counted again. EVM writes can temporarily raise/decrease supply while a
// transfer is reconciled; the final EndBlock cap rejects any net increase.
