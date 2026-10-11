package boot

import (
	"context"
	"os"
	"strconv"

	"github.com/legrch/farol/modules/computer/domain/authority"
	"golang.org/x/sys/unix"
)

// Allocate only in the compiler's fixed scratch class. The process producer
// subsequently opens and retains the exact directory identity without following
// links, verifies the canonical APFS path and seals it into the reservation.
// These directories are intentionally retained on every outcome: root exit does
// not prove descendant settlement. There is no recursive or crash-time cleanup.
// The existing bounded connector operation ledger limits allocation attempts.
func newConnectorShellScratch(ctx context.Context) (connectorShellScratch, error) {
	refuse := func() (connectorShellScratch, error) {
		return connectorShellScratch{}, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
	}
	if ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	path, err := os.MkdirTemp("/private/tmp", "farol-shell-")
	if err != nil {
		return refuse()
	}
	var metadata unix.Stat_t
	if unix.Lstat(path, &metadata) != nil || metadata.Mode&unix.S_IFMT != unix.S_IFDIR ||
		metadata.Mode&07777 != 0700 || metadata.Uid != uint32(os.Geteuid()) || metadata.Ino == 0 || ctx.Err() != nil {
		return refuse()
	}
	return connectorShellScratch{path: path, identity: authority.RootIdentity{
		Device: strconv.FormatUint(uint64(metadata.Dev), 10), Inode: strconv.FormatUint(uint64(metadata.Ino), 10)}}, nil
}
