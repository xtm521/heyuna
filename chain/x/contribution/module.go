// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"

	abci "github.com/cometbft/cometbft/abci/types"
	"github.com/grpc-ecosystem/grpc-gateway/runtime"
	"github.com/spf13/cobra"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/flags"
	"github.com/cosmos/cosmos-sdk/client/tx"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/types/msgservice"
)

type AppModule struct{ keeper Keeper }

var _ module.AppModule = AppModule{}

func NewAppModule(k Keeper) AppModule      { return AppModule{keeper: k} }
func (AppModule) Name() string             { return ModuleName }
func (AppModule) IsAppModule()             {}
func (AppModule) IsOnePerModuleType()      {}
func (AppModule) ConsensusVersion() uint64 { return 1 }
func (AppModule) RegisterLegacyAminoCodec(c *codec.LegacyAmino) {
	c.RegisterConcrete(&MsgExecute{}, "heyuna/contribution/MsgExecute", nil)
}
func (AppModule) RegisterInterfaces(r codectypes.InterfaceRegistry) {
	r.RegisterImplementations((*sdk.Msg)(nil), &MsgExecute{})
	msgservice.RegisterMsgServiceDesc(r, &Msg_serviceDesc)
}
func (AppModule) RegisterGRPCGatewayRoutes(client.Context, *runtime.ServeMux) {}
func (AppModule) DefaultGenesis(codec.JSONCodec) json.RawMessage {
	// init produces a conspicuously incomplete config. The reviewed genesis
	// builder must supply addresses, domain and start time before start succeeds.
	b, _ := json.Marshal(GenesisState{Config: Config{Version: 1, ChainID: "heyuna_297011-1", EVMChainID: 297011, ChallengeSeconds: ChallengePeriodSeconds}})
	return b
}
func (AppModule) ValidateGenesis(_ codec.JSONCodec, _ client.TxEncodingConfig, b json.RawMessage) error {
	var gs GenesisState
	if err := strictDecode(b, &gs); err != nil {
		return err
	}
	return ValidateGenesis(gs)
}
func (a AppModule) InitGenesis(ctx sdk.Context, _ codec.JSONCodec, b json.RawMessage) []abci.ValidatorUpdate {
	var gs GenesisState
	if err := strictDecode(b, &gs); err != nil {
		panic(err)
	}
	if err := a.keeper.InitGenesis(ctx, gs); err != nil {
		panic(err)
	}
	return nil
}
func (a AppModule) ExportGenesis(ctx sdk.Context, _ codec.JSONCodec) json.RawMessage {
	b, err := json.Marshal(a.keeper.ExportGenesis(ctx))
	if err != nil {
		panic(err)
	}
	return b
}
func (a AppModule) RegisterServices(c module.Configurator) {
	RegisterMsgServer(c.MsgServer(), messageServer{a.keeper})
	RegisterQueryServer(c.QueryServer(), queryServer{a.keeper})
}

type messageServer struct{ keeper Keeper }

func (s messageServer) Execute(goCtx context.Context, m *MsgExecute) (*MsgExecuteResponse, error) {
	if m == nil {
		return nil, status.Error(codes.InvalidArgument, "nil message")
	}
	id, err := s.keeper.Execute(sdk.UnwrapSDKContext(goCtx), m.Sender, m.Payload)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	return &MsgExecuteResponse{Id: id}, nil
}

type queryServer struct{ keeper Keeper }

func (q queryServer) Record(goCtx context.Context, r *QueryRecordRequest) (*QueryRecordResponse, error) {
	if r == nil || len(r.Id) > 80 {
		return nil, status.Error(codes.InvalidArgument, "invalid query")
	}
	ctx := sdk.UnwrapSDKContext(goCtx)
	var result any
	var err error
	switch r.Kind {
	case "config":
		result, err = q.keeper.Config(ctx)
	case "task":
		result, err = q.keeper.Task(ctx, r.Id)
	case "receipt":
		result, err = q.keeper.Receipt(ctx, r.Id)
	case "epoch":
		var id uint64
		id, err = strconv.ParseUint(r.Id, 10, 64)
		if err == nil {
			result, err = q.keeper.Epoch(ctx, id)
		}
	case "challenge":
		result, err = q.keeper.Challenge(ctx, r.Id)
	case "accounting":
		result = q.keeper.Accounting(ctx)
	default:
		err = errors.New("unsupported record kind")
	}
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	b, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	return &QueryRecordResponse{Json: b}, nil
}

func (AppModule) GetTxCmd() *cobra.Command {
	root := &cobra.Command{Use: ModuleName, Short: "Submit domain-bound research contribution operations", DisableFlagParsing: true, RunE: client.ValidateCmd}
	exec := &cobra.Command{Use: "execute payload.json", Short: "Sign one reviewed versioned contribution operation", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		ctx, err := client.GetClientTxContext(cmd)
		if err != nil {
			return err
		}
		f, err := os.Open(args[0])
		if err != nil {
			return err
		}
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, MaxPayloadBytes+1))
		if err != nil {
			return err
		}
		if len(b) > MaxPayloadBytes {
			return fmt.Errorf("payload exceeds %d bytes", MaxPayloadBytes)
		}
		var e Envelope
		if err := strictDecode(b, &e); err != nil {
			return err
		}
		return tx.GenerateOrBroadcastTxCLI(ctx, cmd.Flags(), &MsgExecute{Sender: ctx.GetFromAddress().String(), Payload: b})
	}}
	flags.AddTxFlagsToCmd(exec)
	root.AddCommand(exec)
	return root
}
func (AppModule) GetQueryCmd() *cobra.Command {
	root := &cobra.Command{Use: ModuleName, Short: "Query contribution commitments and immutable settlement state", DisableFlagParsing: true, RunE: client.ValidateCmd}
	for _, kind := range []string{"config", "accounting", "task", "receipt", "epoch", "challenge"} {
		kind := kind
		args := cobra.ExactArgs(1)
		use := kind + " id"
		if kind == "config" || kind == "accounting" {
			args = cobra.NoArgs
			use = kind
		}
		cmd := &cobra.Command{Use: use, Args: args, RunE: func(cmd *cobra.Command, args []string) error {
			ctx, err := client.GetClientQueryContext(cmd)
			if err != nil {
				return err
			}
			id := ""
			if len(args) > 0 {
				id = args[0]
			}
			r, err := NewQueryClient(ctx).Record(cmd.Context(), &QueryRecordRequest{Kind: kind, Id: id})
			if err != nil {
				return err
			}
			var value any
			if err := json.Unmarshal(r.Json, &value); err != nil {
				return err
			}
			b, err := json.MarshalIndent(value, "", "  ")
			if err != nil {
				return err
			}
			return ctx.PrintString(string(b) + "\n")
		}}
		flags.AddQueryFlagsToCmd(cmd)
		root.AddCommand(cmd)
	}
	return root
}
