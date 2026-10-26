package evmd

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"cosmossdk.io/log/v2"
	sdkmath "cosmossdk.io/math"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	dbm "github.com/cosmos/cosmos-db"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	"github.com/cosmos/cosmos-sdk/testutil"
	simtestutil "github.com/cosmos/cosmos-sdk/testutil/sims"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/cosmos/cosmos-sdk/x/authz"
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	"github.com/stretchr/testify/require"
	protov2 "google.golang.org/protobuf/proto"
)

type securityTestBank struct{ sent map[string]sdkmath.Int }

func (b *securityTestBank) SendCoinsFromModuleToAccount(_ context.Context, module string, to sdk.AccAddress, coins sdk.Coins) error {
	if module != securityBudget {
		panic("wrong source")
	}
	if b.sent[to.String()].IsNil() {
		b.sent[to.String()] = sdkmath.ZeroInt()
	}
	b.sent[to.String()] = b.sent[to.String()].Add(coins.AmountOf("aheyuna"))
	return nil
}
func securityFixture(t *testing.T) (researchModule, sdk.Context, ResearchGenesis, *securityTestBank) {
	key := storetypes.NewKVStoreKey("researchnet")
	ctx := testutil.DefaultContext(key, storetypes.NewTransientStoreKey("test-transient")).WithChainID("heyuna_297012-1").WithBlockTime(time.Unix(1800000000, 0))
	g := ResearchGenesis{ChainID: ctx.ChainID(), StartTime: ctx.BlockTime().Unix(), EpochSeconds: 3, Epochs: 1040, SubsidyTotal: sdkmath.NewInt(3960000).Mul(sdkmath.NewIntWithDecimal(1, 18)).String()}
	for i := byte(1); i <= 4; i++ {
		raw := bytes.Repeat([]byte{i}, 20)
		g.Validators = append(g.Validators, SecurityValidator{strings.ToUpper(hex.EncodeToString(raw)), sdk.AccAddress(raw).String()})
	}
	require.NoError(t, g.Validate())
	bank := &securityTestBank{sent: map[string]sdkmath.Int{}}
	m := researchModule{key: key, bank: bank}
	raw, _ := json.Marshal(g)
	ctx.KVStore(key).Set([]byte("config"), raw)
	raw, _ = json.Marshal(SecurityState{Epoch: 0, SignedPower: map[string]uint64{}, Paid: "0"})
	ctx.KVStore(key).Set([]byte("state"), raw)
	return m, ctx, g, bank
}
func TestSecuritySubsidyOnlyFinalizedCommitVotes(t *testing.T) {
	m, ctx, g, bank := securityFixture(t)
	require.NoError(t, m.EndBlock(ctx))
	votes := []abci.VoteInfo{}
	for i, v := range g.Validators {
		raw, _ := hex.DecodeString(v.ConsensusAddress)
		flag := cmtproto.BlockIDFlagCommit
		if i == 3 {
			flag = cmtproto.BlockIDFlagAbsent
		}
		votes = append(votes, abci.VoteInfo{Validator: abci.Validator{Address: raw, Power: 10000}, BlockIdFlag: flag})
	}
	ctx = ctx.WithVoteInfos(votes).WithBlockTime(time.Unix(g.StartTime+3, 0))
	require.NoError(t, m.EndBlock(ctx))
	total, _ := sdkmath.NewIntFromString(g.SubsidyTotal)
	budget := subsidyBudget(total, 0, g.Epochs)
	for _, v := range g.Validators[:3] {
		require.True(t, bank.sent[v.Recipient].Equal(budget.QuoRaw(3)))
	}
	_, present := bank.sent[g.Validators[3].Recipient]
	require.False(t, present, "absent validators must not earn subsidy")
	var state SecurityState
	require.NoError(t, json.Unmarshal(ctx.KVStore(m.key).Get([]byte("state")), &state))
	require.Equal(t, budget.QuoRaw(3).MulRaw(3).String(), state.Paid)
	// Restart/load is driven only by persisted SDK state. Empty commits and skipped
	// intervals cannot retroactively claim earlier weekly budgets.
	m2 := researchModule{key: m.key, bank: bank}
	ctx = ctx.WithVoteInfos(nil).WithBlockTime(time.Unix(g.StartTime+30, 0))
	require.NoError(t, m2.EndBlock(ctx))
	var next SecurityState
	require.NoError(t, json.Unmarshal(ctx.KVStore(m.key).Get([]byte("state")), &next))
	require.Equal(t, state.Paid, next.Paid)
}
func TestSecurityBudgetIsBoundedAcross1040Epochs(t *testing.T) {
	total := sdkmath.NewInt(3960000).Mul(sdkmath.NewIntWithDecimal(1, 18))
	sum := sdkmath.ZeroInt()
	for e := int64(0); e < 1040; e++ {
		sum = sum.Add(subsidyBudget(total, e, 1040))
	}
	require.True(t, total.Equal(sum))
	require.True(t, subsidyBudget(total, 1040, 1040).IsZero())
	require.True(t, subsidyBudget(total, -1, 1040).IsZero())
	_, _, g, _ := securityFixture(t)
	g.ChainID = "heyuna_297011-1"
	require.Error(t, g.Validate(), "accelerated subsidy must not leak to research profile")
}
func TestResearchPolicyRejectsStakingAfterGenesis(t *testing.T) {
	called := false
	ante := researchAnteHandler(func(ctx sdk.Context, _ sdk.Tx, _ bool) (sdk.Context, error) { called = true; return ctx, nil })
	tx := policyTx{Msgs: []sdk.Msg{&stakingtypes.MsgCreateValidator{}}}
	_, err := ante(sdk.Context{}.WithBlockHeight(1), tx, false)
	require.ErrorContains(t, err, "forbids")
	require.False(t, called)
	_, err = ante(sdk.Context{}.WithBlockHeight(0), tx, false)
	require.NoError(t, err)
	require.True(t, called)
	_, err = ante(sdk.Context{}.WithBlockHeight(1), policyTx{Msgs: []sdk.Msg{&banktypes.MsgSend{}}}, false)
	require.NoError(t, err)
}

type policyTx struct{ Msgs []sdk.Msg }

func (t policyTx) GetMsgs() []sdk.Msg                    { return t.Msgs }
func (t policyTx) GetMsgsV2() ([]protov2.Message, error) { return nil, nil }

func TestBankSupplyCannotIncreaseAfterBurn(t *testing.T) {
	app := NewExampleApp(log.NewNopLogger(), dbm.NewMemDB(), true, simtestutil.EmptyAppOptions{})
	ctx := sdk.NewContext(app.CommitMultiStore(), cmtproto.Header{ChainID: "heyuna_297012-1"}, false, log.NewNopLogger())
	app.AccountKeeper.GetModuleAccount(ctx, "evm")
	require.NoError(t, app.BankKeeper.MintCoins(ctx, "evm", sdk.NewCoins(sdk.NewCoin("aheyuna", genesisSupply()))))
	require.NoError(t, app.enforceSupplyCap(ctx))
	require.NoError(t, app.BankKeeper.BurnCoins(ctx, "evm", sdk.NewCoins(sdk.NewInt64Coin("aheyuna", 1))))
	require.NoError(t, app.enforceSupplyCap(ctx))
	require.NoError(t, app.BankKeeper.MintCoins(ctx, "evm", sdk.NewCoins(sdk.NewInt64Coin("aheyuna", 1))))
	require.ErrorContains(t, app.enforceSupplyCap(ctx), "exceeds previous committed")
	require.Equal(t, genesisSupply().SubRaw(1).String(), string(ctx.KVStore(app.keys["researchnet"]).Get([]byte("last_supply"))))
	perms := app.AccountKeeper.GetModulePermissions()[securityBudget]
	require.False(t, perms.HasPermission(authtypes.Minter), "security payouts must never mint")
}
func TestResearchPolicyRejectsAuthzTunnel(t *testing.T) {
	ante := researchAnteHandler(func(ctx sdk.Context, _ sdk.Tx, _ bool) (sdk.Context, error) {
		t.Fatal("forbidden tunnel reached inner ante")
		return ctx, nil
	})
	_, err := ante(sdk.Context{}.WithBlockHeight(1), policyTx{Msgs: []sdk.Msg{&authz.MsgExec{}}}, false)
	require.ErrorContains(t, err, "forbids")
}
