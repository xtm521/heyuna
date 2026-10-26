package evmd

// No cross-version migration is approved for this research release. In
// particular, the upstream example's unrelated evmd upgrade is not registered.
// A future migration must specify state transformations and pass historical
// replay and interrupted-upgrade tests before a handler is added here.
func (app EVMD) RegisterUpgradeHandlers() {
	info, err := app.UpgradeKeeper.ReadUpgradeInfoFromDisk()
	if err != nil {
		panic(err)
	}
	if info.Name != "" && !app.UpgradeKeeper.IsSkipHeight(info.Height) {
		panic("no reviewed HEYUNA state migration is registered")
	}
}
