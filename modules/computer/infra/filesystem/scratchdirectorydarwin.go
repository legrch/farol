//go:build darwin

package filesystem

import (
	"sync"

	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// scratchDirectoryCustody pins the exact descriptor opened before publication.
// It is lifetime-local; neither a stored inode nor this handle grants authority.
type scratchDirectoryCustody struct {
	mu       sync.Mutex
	fd       int
	identity mutation.DirectoryIdentity
	uid      uint32
	closed   bool
	closeErr error
}

func (c *scratchDirectoryCustody) Check(expected mutation.DirectoryIdentity) error {
	if c == nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || !expected.Valid() || expected != c.identity {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	var stat unix.Stat_t
	if unix.Fstat(c.fd, &stat) != nil || uint64(stat.Dev) != mustIdentity(expected.Device) || stat.Ino != mustIdentity(expected.Inode) || stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Mode&07777 != 0700 || stat.Uid != c.uid {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	return nil
}

func (c *scratchDirectoryCustody) Close() error {
	if c == nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		c.closeErr = unix.Close(c.fd)
	}
	return c.closeErr
}
