package cmd

import (
	cmtjson "github.com/cometbft/cometbft/libs/json"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	"github.com/spf13/cobra"
)

// Uses the same SDK conversion as the node instead of guessing which AppGenesis
// wrapper fields the CometBFT RPC exposes. Consumers hash the canonical JSON.
func genesisDocumentCmd() *cobra.Command {
	return &cobra.Command{Use: "genesis-document FILE", Short: "Export the CometBFT genesis document for network identity", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		genesis, err := genutiltypes.AppGenesisFromFile(args[0])
		if err != nil {
			return err
		}
		if err = genesis.ValidateAndComplete(); err != nil {
			return err
		}
		document, err := genesis.ToGenesisDoc()
		if err != nil {
			return err
		}
		raw, err := cmtjson.Marshal(document)
		if err != nil {
			return err
		}
		_, err = cmd.OutOrStdout().Write(append(raw, '\n'))
		return err
	}}
}
