package mutation

import (
	"context"
	"path/filepath"
	"strings"
)

// Root is a physical storage binding from trusted composition, not a request,
// workspace approval, restored task or path discovered from old state.
type Root struct {
	Path          string
	Device, Inode uint64
	OwnerUID      uint32
}

func validRoot(r Root) bool {
	return filepath.IsAbs(r.Path) && r.Path != "/" && len(r.Path) <= 4096 && filepath.Clean(r.Path) == r.Path && !strings.ContainsAny(r.Path, "\x00\r\n") && r.Device != 0 && r.Inode != 0
}
func New(ctx context.Context, root Root) (*Repository, error) {
	if ctx == nil || ctx.Err() != nil || !validRoot(root) {
		return nil, unavailable()
	}
	disk, err := openNative(root)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		_ = disk.close()
		return nil, unavailable()
	}
	return newRepository(disk), nil
}
