package evmd

import (
	"context"
	"fmt"
	"math/big"

	sdkmath "cosmossdk.io/math"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/heyuna/chain/config"
)

type priorityFeeBank interface {
	SendCoinsFromModuleToAccountVirtual(context.Context, string, sdk.AccAddress, sdk.Coins) error
}
type priorityFeeEVM interface {
	GetBaseFee(sdk.Context) *big.Int
	GetTransientGasUsed(sdk.Context) uint64
	GetCoinbaseAddress(sdk.Context, sdk.ConsAddress) (common.Address, error)
}

// Split the final charged fee, after EVM gas refunds and its min-gas rule. Legacy
// gasPrice also contains an effective tip. A reverted EVM transaction remains a
// successfully handled SDK message and pays its tip. Ante/SDK failures never
// reach a committed post-state. This does not add a new burn or mint operation.
func priorityAmount(transaction *ethtypes.Transaction, baseFee *big.Int, chargedGas uint64) (sdkmath.Int, error) {
	if transaction == nil || chargedGas == 0 || chargedGas > transaction.Gas() {
		return sdkmath.Int{}, fmt.Errorf("invalid final charged EVM gas")
	}
	if baseFee == nil {
		baseFee = new(big.Int)
	}
	if baseFee.Sign() < 0 {
		return sdkmath.Int{}, fmt.Errorf("negative EVM base fee")
	}
	tip, err := transaction.EffectiveGasTip(baseFee)
	if err != nil || tip.Sign() < 0 {
		return sdkmath.Int{}, fmt.Errorf("invalid effective EVM priority fee")
	}
	amount := new(big.Int).Mul(tip, new(big.Int).SetUint64(chargedGas))
	if amount.BitLen() > 256 {
		return sdkmath.Int{}, fmt.Errorf("priority fee overflow")
	}
	return sdkmath.NewIntFromBigInt(amount), nil
}

func priorityFeePostHandler(bank priorityFeeBank, evm priorityFeeEVM, next sdk.PostHandler) sdk.PostHandler {
	return func(ctx sdk.Context, tx sdk.Tx, simulate, success bool) (sdk.Context, error) {
		if next != nil {
			var err error
			ctx, err = next(ctx, tx, simulate, success)
			if err != nil {
				return ctx, err
			}
		}
		if simulate || !success || ctx.ExecMode() != sdk.ExecModeFinalize {
			return ctx, nil
		}
		messages := tx.GetMsgs()
		var ethereum *evmtypes.MsgEthereumTx
		for _, message := range messages {
			if candidate, ok := message.(*evmtypes.MsgEthereumTx); ok {
				if ethereum != nil || len(messages) != 1 {
					return ctx, fmt.Errorf("priority fee requires one EVM message")
				}
				ethereum = candidate
			}
		}
		if ethereum == nil {
			return ctx, nil
		}
		// Fee settlement must not change the EVM receipt's final gas accounting.
		accountingCtx := ctx.WithGasMeter(storetypes.NewInfiniteGasMeter())
		amount, err := priorityAmount(ethereum.AsTransaction(), evm.GetBaseFee(accountingCtx), evm.GetTransientGasUsed(accountingCtx))
		if err != nil {
			return ctx, err
		}
		if amount.IsZero() {
			return ctx, nil
		}
		proposer := ctx.BlockHeader().ProposerAddress
		if len(proposer) != 20 {
			return ctx, fmt.Errorf("missing consensus proposer for priority fee")
		}
		recipient, err := evm.GetCoinbaseAddress(accountingCtx, sdk.ConsAddress(proposer))
		if err != nil {
			return ctx, err
		}
		if recipient == (common.Address{}) {
			return ctx, fmt.Errorf("zero priority fee recipient")
		}
		// The SDK virtual ledger is indexed by transaction. This cannot withdraw a
		// different transaction's escrow, unlike a global collector balance debit.
		if err = bank.SendCoinsFromModuleToAccountVirtual(accountingCtx, authtypes.FeeCollectorName, sdk.AccAddress(recipient.Bytes()), sdk.NewCoins(sdk.NewCoin(config.BaseDenom, amount))); err != nil {
			return ctx, err
		}
		ctx.EventManager().EmitEvent(sdk.NewEvent("evm_priority_fee", sdk.NewAttribute("recipient", recipient.Hex()), sdk.NewAttribute("amount", amount.String()), sdk.NewAttribute("charged_gas", fmt.Sprint(evm.GetTransientGasUsed(accountingCtx)))))
		return ctx, nil
	}
}
