package filesystem

const (
	searchFileBytes   = 8 * 1024 * 1024
	searchTotalBytes  = 64 * 1024 * 1024
	searchOutputBytes = 512*1024 - 1024
	searchEntries     = 100000
	searchDirectories = 10000
	searchDepth       = 64
	searchMatches     = 100
	searchLineRunes   = 500
	searchIgnoreBytes = 256 * 1024
	searchIgnoreRules = 4096
)
