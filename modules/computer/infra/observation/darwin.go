//go:build darwin

package observation

import (
	"context"
	"errors"
	"runtime"
	"syscall"
	"unsafe"

	port "github.com/legrch/farol/modules/computer/app/port/observation"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
	"golang.org/x/sys/unix"
)

// Experimental read-only native observation. No production composition imports
// this package. The fgetattrlist syscall/ABI and APFS firmlink/mount behavior need
// native qualification before even diagnostic production wiring is approved.
type darwinOperations struct{}

func (darwinOperations) uid() uint32 { return uint32(unix.Getuid()) }
func (darwinOperations) openRoot() (int, error) {
	return unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
}
func (darwinOperations) openAt(parent int, name string) (int, error) {
	return unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
}
func (darwinOperations) close(fd int) error { return unix.Close(fd) }
func (darwinOperations) mount(fd int) (mountInstance, error) {
	var s unix.Statfs_t
	if err := unix.Fstatfs(fd, &s); err != nil {
		return mountInstance{}, fail("WORKSPACE_IDENTITY_UNAVAILABLE")
	}
	return mountInstance{
		FSID:        s.Fsid.Val,
		Filesystem:  unix.ByteSliceToString(s.Fstypename[:]),
		MountedOn:   unix.ByteSliceToString(s.Mntonname[:]),
		MountedFrom: unix.ByteSliceToString(s.Mntfromname[:]),
		Flags:       uint64(s.Flags),
	}, nil
}
func (darwinOperations) stat(fd int) (fileIdentity, error) {
	var s unix.Stat_t
	if err := unix.Fstat(fd, &s); err != nil {
		return fileIdentity{}, err
	}
	// Keep the current native Device interpretation, do not silently reinterpret
	// unsupported signed/zero IDs as a new durable identity.
	if s.Dev <= 0 {
		return fileIdentity{}, fail("WORKSPACE_IDENTITY_UNSUPPORTED")
	}
	return fileIdentity{Device: uint64(s.Dev), Inode: s.Ino, Mode: uint32(s.Mode), UID: s.Uid, BirthSeconds: s.Btim.Sec, BirthNanoseconds: s.Btim.Nsec}, nil
}

// Hold retains the original descriptor chain for future read-only requalification.
// No approval, settings update, native tool, or authorization is performed.
func (*Holder) Hold(ctx context.Context, path string) (port.HeldObservation, error) {
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	if runtime.GOARCH != "arm64" && runtime.GOARCH != "amd64" {
		return nil, fail("WORKSPACE_IDENTITY_UNSUPPORTED")
	}
	return hold(ctx, path, darwinOperations{})
}

func (*Probe) Observe(ctx context.Context, path string) (identity.Observation, error) {
	if err := cancelled(ctx); err != nil {
		return identity.Observation{}, err
	}
	if runtime.GOARCH != "arm64" && runtime.GOARCH != "amd64" {
		return identity.Observation{}, fail("WORKSPACE_IDENTITY_UNSUPPORTED")
	}
	return observe(ctx, path, darwinOperations{})
}

// Darwin has no x/sys/unix Fgetattrlist wrapper at the pinned dependency. This
// small isolated syscall prototype preserves CGO_ENABLED=0; it is NOT release
// qualified. There is no path-based, Foundation, diskutil, or inode fallback.
func attributes(fd int, common, volume uint32, size int) ([]byte, error) {
	request := unix.Attrlist{Bitmapcount: 5, Commonattr: common, Volattr: volume}
	buffer := make([]byte, size)
	_, _, errno := syscall.Syscall6(syscall.SYS_FGETATTRLIST, uintptr(fd), uintptr(unsafe.Pointer(&request)), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0, 0)
	runtime.KeepAlive(&request)
	runtime.KeepAlive(buffer)
	if errno != 0 {
		if errors.Is(errno, syscall.ENOTSUP) || errors.Is(errno, syscall.EINVAL) || errors.Is(errno, syscall.ENOSYS) {
			return nil, fail("WORKSPACE_IDENTITY_UNSUPPORTED")
		}
		return nil, fail("WORKSPACE_IDENTITY_UNAVAILABLE")
	}
	return buffer, nil
}

func supportedMount(s unix.Statfs_t) bool {
	return unix.ByteSliceToString(s.Fstypename[:]) == "apfs" && s.Flags&unix.MNT_LOCAL != 0 && s.Flags&(unix.MNT_SNAPSHOT|unix.MNT_RDONLY|unix.MNT_IGNORE_OWNERSHIP) == 0
}
func sameMount(a, b unix.Statfs_t) bool {
	return a.Fsid == b.Fsid && a.Fstypename == b.Fstypename && a.Mntonname == b.Mntonname && a.Mntfromname == b.Mntfromname && a.Flags == b.Flags
}
func (ops darwinOperations) facts(ctx context.Context, fd int) (result identity.Evidence, err error) {
	if err = cancelled(ctx); err != nil {
		return result, err
	}
	current, err := ops.stat(fd)
	if err != nil {
		return result, fail("WORKSPACE_IDENTITY_UNAVAILABLE")
	}
	var mount unix.Statfs_t
	if unix.Fstatfs(fd, &mount) != nil {
		return result, fail("WORKSPACE_IDENTITY_UNAVAILABLE")
	}
	if !supportedMount(mount) {
		return result, fail("WORKSPACE_IDENTITY_UNSUPPORTED")
	}
	// Volume attributes are queried at the mount root. /Users may be a firmlink
	// into the Data volume, so lexical-prefix ancestry is NOT assumed. The root
	// is opened independently without symlinks and bound to this descriptor's
	// device AND fsid; no path-based stat is used to join two different volumes.
	volumePath := unix.ByteSliceToString(mount.Mntonname[:])
	held, err := openChain(ctx, volumePath, ops)
	if err != nil {
		return result, err
	}
	defer func() {
		if closeErr := closeChain(ops, held); closeErr != nil && err == nil {
			result = identity.Evidence{}
			err = closeErr
		}
	}()
	root := held[len(held)-1]
	var rootMount unix.Statfs_t
	if root.identity.Device != current.Device || unix.Fstatfs(root.fd, &rootMount) != nil || !sameMount(mount, rootMount) {
		return result, fail("WORKSPACE_RACE_DETECTED")
	}
	volumeBuffer, err := attributes(root.fd, attrReturned, attrVolumeInfo|attrCapabilities|attrVolumeUUID, volumeBytes)
	if err != nil {
		return result, err
	}
	uuid, err := decodeVolume(volumeBuffer)
	if err != nil {
		return result, err
	}
	objectBuffer, err := attributes(fd, attrReturned|attrDevice|attrBirth|attrFileID, 0, objectBytes)
	if err != nil {
		return result, err
	}
	result, err = decodeObject(objectBuffer, current, uuid)
	if err != nil {
		return identity.Evidence{}, err
	}
	// No successful result can mix observations across a mount/namespace change.
	var after, rootAfter unix.Statfs_t
	currentAfter, statErr := ops.stat(fd)
	if statErr != nil || currentAfter != current || unix.Fstatfs(fd, &after) != nil || unix.Fstatfs(root.fd, &rootAfter) != nil || !sameMount(mount, after) || !sameMount(rootMount, rootAfter) {
		return identity.Evidence{}, fail("WORKSPACE_RACE_DETECTED")
	}
	if err = recheckChain(ctx, held, ops); err != nil {
		return identity.Evidence{}, err
	}
	return result, nil
}
