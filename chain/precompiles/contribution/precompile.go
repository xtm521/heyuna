// SPDX-License-Identifier: Apache-2.0
package contribution

import (
	"bytes"
	_ "embed"
	"errors"
	"math/big"

	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	cmn "github.com/cosmos/evm/precompiles/common"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/vm"
	contribution "github.com/heyuna/chain/x/contribution"
)

const Address = "0x0000000000000000000000000000000000000900"

//go:embed abi.json
var abiJSON []byte
var ABI = func() abi.ABI {
	a, err := abi.JSON(bytes.NewReader(abiJSON))
	if err != nil {
		panic(err)
	}
	return a
}()

type Precompile struct {
	cmn.Precompile
	keeper contribution.Keeper
}

var _ vm.PrecompiledContract = (*Precompile)(nil)

func NewPrecompile(k contribution.Keeper) *Precompile {
	return &Precompile{Precompile: cmn.Precompile{KvGasConfig: storetypes.KVGasConfig(), TransientKVGasConfig: storetypes.TransientGasConfig(), ContractAddress: common.HexToAddress(Address)}, keeper: k}
}
func (*Precompile) Name() string { return "heyuna_contribution_readonly" }
func (*Precompile) RequiredGas(input []byte) uint64 {
	n := len(input)
	if n > 4096 {
		n = 4096
	}
	return 5000 + uint64(n)*12
}
func (p *Precompile) Run(evm *vm.EVM, contract *vm.Contract, _ bool) ([]byte, error) {
	return p.RunNativeAction(evm, contract, func(ctx sdk.Context) ([]byte, error) {
		return p.Execute(ctx, contract.Input, contract.Value().Sign() != 0)
	})
}

// Execute accepts only two fixed-size views. CALL and STATICCALL both reach
// exactly this read-only path. No keeper mutation or arbitrary module messages
// are reachable, and output is bounded to at most five ABI words (160 bytes).
func (p *Precompile) Execute(ctx sdk.Context, input []byte, hasValue bool) ([]byte, error) {
	if hasValue || len(input) < 4 || len(input) > 36 {
		return nil, errors.New("invalid nonpayable read-only contribution call")
	}
	method, err := ABI.MethodById(input[:4])
	if err != nil {
		return nil, err
	}
	if len(input) != 4+32*len(method.Inputs) {
		return nil, errors.New("noncanonical contribution calldata length")
	}
	args, err := method.Inputs.Unpack(input[4:])
	if err != nil {
		return nil, err
	}
	switch method.Name {
	case "getEpoch":
		id := args[0].(*big.Int)
		if !id.IsUint64() {
			return nil, errors.New("epoch exceeds uint64")
		}
		e, err := p.keeper.Epoch(ctx, id.Uint64())
		if err != nil {
			return method.Outputs.Pack(common.Hash{}, new(big.Int), new(big.Int), false)
		}
		t, ok := new(big.Int).SetString(e.TrainingBudget, 10)
		if !ok {
			return nil, errors.New("invalid stored training budget")
		}
		v, ok := new(big.Int).SetString(e.VerificationBudget, 10)
		if !ok {
			return nil, errors.New("invalid stored verification budget")
		}
		return method.Outputs.Pack(common.HexToHash(e.Root), t, v, e.Status == "finalized")
	case "getNetwork":
		c, err := p.keeper.Config(ctx)
		if err != nil {
			return nil, err
		}
		return method.Outputs.Pack(new(big.Int).SetUint64(c.EVMChainID), common.HexToHash(c.NetworkDomain), common.HexToAddress(c.VaultAddress), big.NewInt(c.ChallengeSeconds), c.UnsafeTestProfile)
	default:
		return nil, errors.New("unsupported contribution view")
	}
}
