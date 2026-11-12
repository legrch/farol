//go:build darwin

package lease

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	domain "github.com/legrch/farol/modules/computer/domain/lease"
	"golang.org/x/sys/unix"
)

const utilityTimeout = 3 * time.Second

type darwinOperations struct {
	runtimeID string
	pid       int
}

func newNative() ops {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return &darwinOperations{pid: os.Getpid()}
	}
	return &darwinOperations{runtimeID: hex.EncodeToString(nonce), pid: os.Getpid()}
}
func (*darwinOperations) openRoot() (int, error) {
	return unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
}
func (*darwinOperations) openAt(fd int, name string) (int, error) {
	return unix.Openat(fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
}
func (*darwinOperations) close(fd int) error { return unix.Close(fd) }
func (*darwinOperations) stat(fd int) (file, error) {
	var s unix.Stat_t
	if err := unix.Fstat(fd, &s); err != nil {
		return file{}, err
	}
	if s.Dev <= 0 {
		return file{}, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
	}
	return file{Device: uint64(s.Dev), Inode: s.Ino, Mode: uint32(s.Mode)}, nil
}
func (*darwinOperations) mount(fd int) (domain.Mount, error) {
	var s unix.Statfs_t
	var f unix.Stat_t
	if err := unix.Fstatfs(fd, &s); err != nil {
		return domain.Mount{}, err
	}
	if err := unix.Fstat(fd, &f); err != nil {
		return domain.Mount{}, err
	}
	if f.Dev <= 0 {
		return domain.Mount{}, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
	}
	return domain.Mount{
		Device: uint64(f.Dev), Inode: f.Ino, FSID: s.Fsid.Val,
		Filesystem:  unix.ByteSliceToString(s.Fstypename[:]),
		MountedOn:   unix.ByteSliceToString(s.Mntonname[:]),
		MountedFrom: unix.ByteSliceToString(s.Mntfromname[:]),
		Local:       s.Flags&unix.MNT_LOCAL != 0, ReadOnly: s.Flags&unix.MNT_RDONLY != 0,
		Snapshot:        s.Flags&unix.MNT_SNAPSHOT != 0,
		IgnoreOwnership: s.Flags&unix.MNT_IGNORE_OWNERSHIP != 0,
	}, nil
}
func (o *darwinOperations) epoch(ctx context.Context) (domain.Epoch, error) {
	if err := checkContext(ctx); err != nil {
		return domain.Epoch{}, err
	}
	if o.runtimeID == "" || os.Getpid() != o.pid {
		return domain.Epoch{}, refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	boot, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil {
		return domain.Epoch{}, refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	return domain.Epoch{Boot: strings.ToLower(strings.TrimSpace(boot)), Runtime: strconv.Itoa(o.pid) + ":" + o.runtimeID}, nil
}

func (o *darwinOperations) metadata(ctx context.Context, path string) (domain.Metadata, error) {
	if err := checkContext(ctx); err != nil {
		return domain.Metadata{}, err
	}
	if path != domain.SystemPath && path != domain.DataPath {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_METADATA_INVALID")
	}
	qctx, cancel := context.WithTimeout(ctx, utilityTimeout)
	defer cancel()
	cmd := exec.CommandContext(qctx, "/usr/sbin/diskutil", "info", "-plist", path)
	cmd.WaitDelay = time.Second
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C"}
	out := &boundWriter{}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	cmd.Stdin = nil
	if err := cmd.Run(); err != nil || qctx.Err() != nil {
		return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_UNAVAILABLE")
	}
	return decodeMetadata(out.data, path)
}
