// SPDX-License-Identifier: Apache-2.0
package evmd

import (
	storetypes "github.com/cosmos/cosmos-sdk/store/v2/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/ethereum/go-ethereum/common"
	contributionprecompile "github.com/heyuna/chain/precompiles/contribution"
	"github.com/heyuna/chain/x/contribution"
)

func newContributionModule(app *EVMD, key *storetypes.KVStoreKey) module.AppModule {
	k := contribution.NewKeeper(key)
	app.EVMKeeper.RegisterStaticPrecompile(common.HexToAddress(contributionprecompile.Address), contributionprecompile.NewPrecompile(k))
	return contribution.NewAppModule(k)
}
