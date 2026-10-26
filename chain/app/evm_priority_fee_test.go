package evmd

import (
	"bytes"
	"context"
	"fmt"
	"math/big"
	"testing"

	"cosmossdk.io/log/v2"
	sdkmath "cosmossdk.io/math"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	evmtypes "github.com/cosmos/evm/x/vm/types"
	"github.com/ethereum/go-ethereum/common"
	ethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/stretchr/testify/require"
)

type tipEVM struct {
	gas       uint64
	base      *big.Int
	recipient common.Address
	err       error
}

func (e tipEVM) GetBaseFee(sdk.Context) *big.Int        { return e.base }
func (e tipEVM) GetTransientGasUsed(sdk.Context) uint64 { return e.gas }
func (e tipEVM) GetCoinbaseAddress(_ sdk.Context, cons sdk.ConsAddress) (common.Address, error) {
	if len(cons) != 20 {
		panic("missing consensus identity")
	}
	return e.recipient, e.err
}

type tipBank struct {
	calls     int
	recipient sdk.AccAddress
	amount    sdkmath.Int
}

func (b *tipBank) SendCoinsFromModuleToAccountVirtual(_ context.Context, module string, to sdk.AccAddress, coins sdk.Coins) error {
	if module != authtypes.FeeCollectorName {
		return fmt.Errorf("wrong escrow")
	}
	b.calls++
	b.recipient = to
	b.amount = coins.AmountOf("aheyuna")
	return nil
}
func tipMessage(gas uint64, fee, tip int64) *evmtypes.MsgEthereumTx {
	m := new(evmtypes.MsgEthereumTx)
	to := common.HexToAddress("0x0000000000000000000000000000000000007777")
	m.FromEthereumTx(ethtypes.NewTx(&ethtypes.DynamicFeeTx{ChainID: big.NewInt(297012), Gas: gas, GasFeeCap: big.NewInt(fee), GasTipCap: big.NewInt(tip), To: &to}))
	return m
}
func TestPriorityFeeUsesFinalGasAndFeeCap(t *testing.T) {
	m := tipMessage(100000, 12, 5)
	amount, err := priorityAmount(m.AsTransaction(), big.NewInt(10), 21000)
	require.NoError(t, err)
	require.Equal(t, "42000", amount.String(), "tip=min(5,12-10), final 21000 gas rather than 100000 limit")
	amount, err = priorityAmount(m.AsTransaction(), big.NewInt(10), 50000)
	require.NoError(t, err)
	require.Equal(t, "100000", amount.String(), "EVM min-gas floor is already included by source")
	_, err = priorityAmount(m.AsTransaction(), big.NewInt(13), 21000)
	require.Error(t, err)
	_, err = priorityAmount(m.AsTransaction(), big.NewInt(0), 100001)
	require.Error(t, err)
	_, err = priorityAmount(m.AsTransaction(), big.NewInt(0), 0)
	require.Error(t, err)
	legacy := ethtypes.NewTx(&ethtypes.LegacyTx{Gas: 21000, GasPrice: big.NewInt(11)})
	amount, err = priorityAmount(legacy, big.NewInt(10), 21000)
	require.NoError(t, err)
	require.Equal(t, "21000", amount.String())
}
func TestPriorityRecipientFromProposerAndFailureBoundaries(t *testing.T) {
	recipient := common.BytesToAddress(bytes.Repeat([]byte{9}, 20))
	bank := new(tipBank)
	source := tipEVM{21000, big.NewInt(10), recipient, nil}
	handler := priorityFeePostHandler(bank, source, nil)
	ctx := sdk.Context{}.WithExecMode(sdk.ExecModeFinalize).WithBlockHeader(cmtproto.Header{ProposerAddress: bytes.Repeat([]byte{1}, 20)}).WithGasMeter(storetypes.NewGasMeter(100000)).WithEventManager(sdk.NewEventManager())
	ctx.GasMeter().ConsumeGas(21000, "EVM final gas")
	tx := tipMessage(100000, 12, 5)
	_, err := handler(ctx, tx, true, true)
	require.NoError(t, err)
	require.Zero(t, bank.calls)
	_, err = handler(ctx, tx, false, false)
	require.NoError(t, err)
	require.Zero(t, bank.calls, "SDK failure cannot pay a tip from discarded post-state")
	// EVM revert receipts are SDK-successful handled messages; settlement does
	// not branch on transaction status, so the final charged gas still pays.
	_, err = handler(ctx, tx, false, true)
	require.NoError(t, err)
	require.Equal(t, 1, bank.calls)
	require.Equal(t, recipient.Bytes(), []byte(bank.recipient))
	require.Equal(t, "42000", bank.amount.String())
	require.EqualValues(t, 21000, ctx.GasMeter().GasConsumed())
	_, err = handler(ctx.WithBlockHeader(cmtproto.Header{}), tx, false, true)
	require.Error(t, err)
	_, err = handler(ctx, policyTx{Msgs: []sdk.Msg{tx, tx}}, false, true)
	require.Error(t, err)
	source.err = fmt.Errorf("unknown validator")
	_, err = priorityFeePostHandler(bank, source, nil)(ctx, tx, false, true)
	require.ErrorContains(t, err, "unknown validator")
}
func TestPriorityVirtualEscrowCannotSpendAnotherTransaction(t *testing.T) {
	app := NewExampleApp(log.NewNopLogger(), dbm.NewMemDB(), true, simtestutil.EmptyAppOptions{})
	ctx := sdk.NewContext(app.CommitMultiStore(), cmtproto.Header{ChainID: "heyuna_297012-1", ProposerAddress: bytes.Repeat([]byte{1}, 20)}, false, log.NewNopLogger()).WithExecMode(sdk.ExecModeFinalize).WithTxIndex(7)
	app.AccountKeeper.GetModuleAccount(ctx, "evm")
	app.AccountKeeper.GetModuleAccount(ctx, authtypes.FeeCollectorName)
	sender := sdk.AccAddress(bytes.Repeat([]byte{2}, 20))
	recipient := common.BytesToAddress(bytes.Repeat([]byte{9}, 20))
	require.NoError(t, app.BankKeeper.MintCoins(ctx, "evm", sdk.NewCoins(sdk.NewInt64Coin("aheyuna", 252000))))
	require.NoError(t, app.BankKeeper.SendCoinsFromModuleToAccount(ctx, "evm", sender, sdk.NewCoins(sdk.NewInt64Coin("aheyuna", 252000))))
	require.NoError(t, app.BankKeeper.SendCoinsFromAccountToModuleVirtual(ctx, sender, authtypes.FeeCollectorName, sdk.NewCoins(sdk.NewInt64Coin("aheyuna", 252000))))
	handler := priorityFeePostHandler(app.BankKeeper, tipEVM{21000, big.NewInt(10), recipient, nil}, nil)
	tx := tipMessage(100000, 12, 5)
	_, err := handler(ctx.WithTxIndex(8), tx, false, true)
	require.ErrorContains(t, err, "spendable balance 0")
	require.True(t, app.BankKeeper.GetBalance(ctx, recipient.Bytes(), "aheyuna").IsZero())
	_, err = handler(ctx, tx, false, true)
	require.NoError(t, err)
	require.Equal(t, "42000", app.BankKeeper.GetBalance(ctx, recipient.Bytes(), "aheyuna").Amount.String())
	require.NoError(t, app.BankKeeper.CreditVirtualAccounts(ctx))
	require.Equal(t, "210000", app.BankKeeper.GetBalance(ctx, app.AccountKeeper.GetModuleAddress(authtypes.FeeCollectorName), "aheyuna").Amount.String())
	require.Equal(t, "252000", app.BankKeeper.GetSupply(ctx, "aheyuna").Amount.String(), "priority/base fee settlement only transfers existing currency")
}

func TestProposalValidationDoesNotSettleUnexecutedEVMGas(t *testing.T) {
	bank := new(tipBank)
	handler := priorityFeePostHandler(bank, tipEVM{gas: 0, base: big.NewInt(0)}, nil)
	ctx := sdk.Context{}.WithExecMode(sdk.ExecModeProcessProposal).WithGasMeter(storetypes.NewInfiniteGasMeter())
	_, err := handler(ctx, tipMessage(100000, 7, 3), false, true)
	require.NoError(t, err, "SDK calls PostHandler during proposal validation before EVM execution")
	require.Zero(t, bank.calls)
}
