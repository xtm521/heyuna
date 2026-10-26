package evmd

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	sdkmath "cosmossdk.io/math"
	abci "github.com/cometbft/cometbft/abci/types"
	cmtproto "github.com/cometbft/cometbft/proto/tendermint/types"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/grpc-ecosystem/grpc-gateway/runtime"
	"github.com/heyuna/chain/config"
	"github.com/spf13/cobra"
)

const securityBudget = "security_budget"

type SecurityValidator struct {
	ConsensusAddress string `json:"consensus_address"`
	Recipient        string `json:"recipient"`
}

type ResearchGenesis struct {
	ChainID      string              `json:"chain_id"`
	StartTime    int64               `json:"start_time"`
	EpochSeconds int64               `json:"epoch_seconds"`
	Epochs       int64               `json:"epochs"`
	SubsidyTotal string              `json:"subsidy_total"`
	Validators   []SecurityValidator `json:"validators"`
	State        *SecurityState      `json:"state,omitempty"`
	LastSupply   string              `json:"last_supply,omitempty"`
}

type SecurityState struct {
	Epoch           int64             `json:"epoch"`
	LastBlockTime   int64             `json:"last_block_time"`
	SignedPower     map[string]uint64 `json:"signed_power"`
	Paid            string            `json:"paid"`
	CompletedEpochs uint64            `json:"completed_epochs"`
}

func (g ResearchGenesis) Validate() error {
	if !allowedResearchChain(g.ChainID) {
		return fmt.Errorf("unsupported research chain")
	}
	if g.StartTime <= 0 || g.Epochs != 1040 || (g.EpochSeconds != 604800 && !(g.ChainID == "heyuna_297012-1" && g.EpochSeconds == 3)) {
		return fmt.Errorf("invalid security subsidy schedule")
	}
	expected := sdkmath.NewInt(3_960_000).Mul(sdkmath.NewIntWithDecimal(1, 18)).String()
	if g.SubsidyTotal != expected || len(g.Validators) != 4 {
		return fmt.Errorf("research security allocation requires 3,960,000 HEYUNA and four validators")
	}
	seen := map[string]bool{}
	recipients := map[string]bool{}
	for _, validator := range g.Validators {
		raw, err := hex.DecodeString(validator.ConsensusAddress)
		if err != nil || len(raw) != 20 || validator.ConsensusAddress != strings.ToUpper(validator.ConsensusAddress) {
			return fmt.Errorf("invalid canonical consensus address")
		}
		if _, err = sdk.AccAddressFromBech32(validator.Recipient); err != nil {
			return err
		}
		if seen[validator.ConsensusAddress] || recipients[validator.Recipient] {
			return fmt.Errorf("duplicate security validator")
		}
		seen[validator.ConsensusAddress], recipients[validator.Recipient] = true, true
	}
	return nil
}

type securityBank interface {
	SendCoinsFromModuleToAccount(context.Context, string, sdk.AccAddress, sdk.Coins) error
}

type researchModule struct {
	app  *EVMD
	key  *storetypes.KVStoreKey
	bank securityBank
}

func newResearchModule(app *EVMD, key *storetypes.KVStoreKey) module.AppModule {
	return researchModule{app: app, key: key, bank: app.BankKeeper}
}
func (researchModule) Name() string                                                { return "researchnet" }
func (researchModule) IsAppModule()                                                {}
func (researchModule) IsOnePerModuleType()                                         {}
func (researchModule) ConsensusVersion() uint64                                    { return 1 }
func (researchModule) RegisterLegacyAminoCodec(*codec.LegacyAmino)                 {}
func (researchModule) RegisterInterfaces(codectypes.InterfaceRegistry)             {}
func (researchModule) RegisterGRPCGatewayRoutes(client.Context, *runtime.ServeMux) {}
func (researchModule) RegisterServices(module.Configurator)                        {}
func (researchModule) GetTxCmd() *cobra.Command                                    { return nil }
func (researchModule) DefaultGenesis(codec.JSONCodec) json.RawMessage {
	value, _ := json.Marshal(ResearchGenesis{ChainID: config.ChainID, EpochSeconds: 604800, Epochs: 1040, SubsidyTotal: sdkmath.NewInt(3_960_000).Mul(sdkmath.NewIntWithDecimal(1, 18)).String(), Validators: []SecurityValidator{}})
	return value
}
func (researchModule) ValidateGenesis(_ codec.JSONCodec, _ client.TxEncodingConfig, raw json.RawMessage) error {
	var g ResearchGenesis
	if err := json.Unmarshal(raw, &g); err != nil {
		return err
	}
	return g.Validate()
}
func (m researchModule) InitGenesis(ctx sdk.Context, _ codec.JSONCodec, raw json.RawMessage) []abci.ValidatorUpdate {
	var g ResearchGenesis
	if err := json.Unmarshal(raw, &g); err != nil {
		panic(err)
	}
	if err := g.Validate(); err != nil {
		panic(err)
	}
	if ctx.ChainID() != g.ChainID {
		panic("security schedule chain mismatch")
	}
	state := g.State
	if state == nil {
		state = &SecurityState{Epoch: 0, SignedPower: map[string]uint64{}, Paid: "0"}
	}
	if state.SignedPower == nil {
		state.SignedPower = map[string]uint64{}
	}
	store := ctx.KVStore(m.key)
	stateRaw, _ := json.Marshal(state)
	store.Set([]byte("state"), stateRaw)
	if g.LastSupply != "" {
		if amount, ok := sdkmath.NewIntFromString(g.LastSupply); !ok || amount.IsNegative() || amount.GT(genesisSupply()) {
			panic("invalid exported supply")
		}
		store.Set([]byte("last_supply"), []byte(g.LastSupply))
	}
	g.State = nil
	g.LastSupply = ""
	configRaw, _ := json.Marshal(g)
	store.Set([]byte("config"), configRaw)
	m.app.AccountKeeper.GetModuleAccount(ctx, securityBudget)
	return nil
}
func (m researchModule) ExportGenesis(ctx sdk.Context, _ codec.JSONCodec) json.RawMessage {
	store := ctx.KVStore(m.key)
	var g ResearchGenesis
	var state SecurityState
	if err := json.Unmarshal(store.Get([]byte("config")), &g); err != nil {
		panic(err)
	}
	if err := json.Unmarshal(store.Get([]byte("state")), &state); err != nil {
		panic(err)
	}
	g.State = &state
	g.LastSupply = string(store.Get([]byte("last_supply")))
	raw, _ := json.Marshal(g)
	return raw
}
func (researchModule) BeginBlock(context.Context) error { return nil }

// The next block's decided last commit is the consensus evidence of the previous
// block. Only COMMIT votes earn weight; self-reported uptime never earns subsidy.
func (m researchModule) EndBlock(goctx context.Context) error {
	ctx := sdk.UnwrapSDKContext(goctx)
	store := ctx.KVStore(m.key)
	var g ResearchGenesis
	var s SecurityState
	if err := json.Unmarshal(store.Get([]byte("config")), &g); err != nil {
		return err
	}
	if err := json.Unmarshal(store.Get([]byte("state")), &s); err != nil {
		return err
	}
	now := ctx.BlockTime().Unix()
	if now < g.StartTime {
		return nil
	}
	current := (now - g.StartTime) / g.EpochSeconds
	if s.LastBlockTime >= g.StartTime && s.Epoch < g.Epochs {
		known := map[string]bool{}
		for _, v := range g.Validators {
			known[v.ConsensusAddress] = true
		}
		for _, vote := range ctx.VoteInfos() {
			address := strings.ToUpper(hex.EncodeToString(vote.Validator.Address))
			if vote.BlockIdFlag == cmtproto.BlockIDFlagCommit && vote.Validator.Power > 0 && known[address] {
				power := uint64(vote.Validator.Power)
				if ^uint64(0)-s.SignedPower[address] < power {
					return fmt.Errorf("security vote weight overflow")
				}
				s.SignedPower[address] += power
			}
		}
	}
	if current > s.Epoch {
		if s.Epoch < g.Epochs {
			if err := m.settle(ctx, g, &s); err != nil {
				return err
			}
		}
		s.Epoch = current
		s.SignedPower = map[string]uint64{}
	}
	s.LastBlockTime = now
	encoded, err := json.Marshal(s)
	if err != nil {
		return err
	}
	store.Set([]byte("state"), encoded)
	return nil
}

func subsidyBudget(total sdkmath.Int, epoch, epochs int64) sdkmath.Int {
	if epoch < 0 || epoch >= epochs {
		return sdkmath.ZeroInt()
	}
	return total.MulRaw(epoch + 1).QuoRaw(epochs).Sub(total.MulRaw(epoch).QuoRaw(epochs))
}

func (m researchModule) settle(ctx sdk.Context, g ResearchGenesis, s *SecurityState) error {
	total, _ := sdkmath.NewIntFromString(g.SubsidyTotal)
	budget := subsidyBudget(total, s.Epoch, g.Epochs)
	sum := sdkmath.ZeroInt()
	for _, power := range s.SignedPower {
		sum = sum.Add(sdkmath.NewIntFromUint64(power))
	}
	if sum.IsZero() {
		return nil
	}
	validators := append([]SecurityValidator(nil), g.Validators...)
	sort.Slice(validators, func(i, j int) bool { return validators[i].ConsensusAddress < validators[j].ConsensusAddress })
	paid, ok := sdkmath.NewIntFromString(s.Paid)
	if !ok {
		return fmt.Errorf("invalid subsidy accounting")
	}
	epochPaid := sdkmath.ZeroInt()
	for _, validator := range validators {
		amount := budget.Mul(sdkmath.NewIntFromUint64(s.SignedPower[validator.ConsensusAddress])).Quo(sum)
		if amount.IsZero() {
			continue
		}
		recipient, err := sdk.AccAddressFromBech32(validator.Recipient)
		if err != nil {
			return err
		}
		if paid.Add(epochPaid).Add(amount).GT(total) {
			return fmt.Errorf("security subsidy cap exceeded")
		}
		if err = m.bank.SendCoinsFromModuleToAccount(ctx, securityBudget, recipient, sdk.NewCoins(sdk.NewCoin(config.BaseDenom, amount))); err != nil {
			return err
		}
		epochPaid = epochPaid.Add(amount)
		ctx.EventManager().EmitEvent(sdk.NewEvent("security_subsidy", sdk.NewAttribute("epoch", fmt.Sprint(s.Epoch)), sdk.NewAttribute("recipient", validator.Recipient), sdk.NewAttribute("amount", amount.String()), sdk.NewAttribute("source", securityBudget)))
	}
	s.Paid = paid.Add(epochPaid).String()
	s.CompletedEpochs++
	return nil
}

func (researchModule) GetQueryCmd() *cobra.Command {
	command := &cobra.Command{Use: "researchnet [config|state|last_supply]", Short: "Query security subsidy and native supply accounting", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if args[0] != "config" && args[0] != "state" && args[0] != "last_supply" {
			return fmt.Errorf("unsupported accounting key")
		}
		clientContext, err := client.GetClientQueryContext(cmd)
		if err != nil {
			return err
		}
		result, _, err := clientContext.QueryWithData("store/researchnet/key", []byte(args[0]))
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(cmd.OutOrStdout(), string(result))
		return err
	}}
	flags.AddQueryFlagsToCmd(command)
	return command
}
