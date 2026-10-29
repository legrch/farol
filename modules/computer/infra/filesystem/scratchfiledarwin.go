//go:build darwin

package filesystem

import (
	"strconv"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

type scratchFileCustody struct {
	mu       sync.Mutex
	fd       int
	identity mutation.DirectoryIdentity
	uid      uint32
	closed   bool
	closeErr error
}

func (darwinMutation) holdScratchFile(fd int, v fileVersion) (port.ScratchFileCustody, error) {
	if !v.regular() || v.ino == 0 {
		return nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	copyFD, err := unix.FcntlInt(uintptr(fd), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	c := &scratchFileCustody{fd: copyFD, identity: mutation.DirectoryIdentity{Device: strconv.FormatUint(v.dev, 10), Inode: strconv.FormatUint(v.ino, 10)}, uid: v.uid}
	if err := c.Check(c.identity); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

func (c *scratchFileCustody) Check(expected mutation.DirectoryIdentity) error {
	if c == nil {
		return refusal("WORKSPACE_PATH_REFUSED")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || !expected.Valid() || c.identity != expected {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	var stat unix.Stat_t
	if unix.Fstat(c.fd, &stat) != nil || uint64(stat.Dev) != mustIdentity(expected.Device) || stat.Ino != mustIdentity(expected.Inode) || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != c.uid || stat.Nlink != 1 {
		return refusal("WORKSPACE_MUTATION_CONFLICT")
	}
	return nil
}

func (c *scratchFileCustody) Close() error {
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
