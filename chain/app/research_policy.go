package evmd

import (
	"fmt"
	"strings"

	sdkmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/heyuna/chain/config"
)

func genesisSupply() sdkmath.Int {
	return sdkmath.NewInt(20_000_000).Mul(sdkmath.NewIntWithDecimal(1, 18))
}

// Researchnet validators are admitted only by the reviewed genesis. Generic
// authz/governance/IBC messages cannot tunnel additional state-changing calls.
func researchAnteHandler(next sdk.AnteHandler) sdk.AnteHandler {
	return func(ctx sdk.Context, tx sdk.Tx, simulate bool) (sdk.Context, error) {
		for _, message := range tx.GetMsgs() {
			name := sdk.MsgTypeURL(message)
			allowed := name == "/cosmos.bank.v1beta1.MsgSend" || name == "/cosmos.bank.v1beta1.MsgMultiSend" || name == "/cosmos.evm.vm.v1.MsgEthereumTx" || name == "/heyuna.contribution.v1.MsgExecute" || name == "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward" || name == "/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission"
			if ctx.BlockHeight() == 0 && name == "/cosmos.staking.v1beta1.MsgCreateValidator" {
				allowed = true
			}
			if !allowed {
				return ctx, fmt.Errorf("researchnet policy forbids message %s", name)
			}
		}
		return next(ctx, tx, simulate)
	}
}

// An immutable per-commit high-water boundary prevents net inflation, including
// after a burn. Internal EVM bank reconciliation may mint/burn transiently; only
// the fully reconciled committed supply is compared, after all EndBlock hooks.
func (app *EVMD) enforceSupplyCap(ctx sdk.Context) error {
	store := ctx.KVStore(app.keys["researchnet"])
	limit := genesisSupply()
	if previous := store.Get([]byte("last_supply")); previous != nil {
		parsed, ok := sdkmath.NewIntFromString(string(previous))
		if !ok {
			return fmt.Errorf("invalid previous supply")
		}
		limit = parsed
	}
	current := app.BankKeeper.GetSupply(ctx, config.BaseDenom).Amount
	if current.IsNegative() || current.GT(limit) {
		return fmt.Errorf("native supply invariant: %s exceeds previous committed %s", current, limit)
	}
	store.Set([]byte("last_supply"), []byte(current.String()))
	return nil
}

func allowedResearchChain(chain string) bool {
	return strings.HasPrefix(chain, "heyuna_") && (chain == "heyuna_297011-1" || chain == "heyuna_297012-1")
}
