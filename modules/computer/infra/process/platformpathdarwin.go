//go:build darwin

package process

import (
	"runtime"
	"unsafe"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"golang.org/x/sys/unix"
)

// The qualified profile consumes the kernel pathname, not an alternative APFS,
// case or Unicode spelling. Refuse drift; never turn normalization into a grant.
// This follows the existing native profile owner's F_GETPATH/Pinner contract.
func platformDescriptorPath(fd uintptr) (string, error) {
	var path [1024]byte // Darwin MAXPATHLEN.
	var pinned runtime.Pinner
	pinned.Pin(&path[0])
	defer pinned.Unpin()
	_, err := unix.FcntlInt(fd, unix.F_GETPATH, int(uintptr(unsafe.Pointer(&path[0]))))
	runtime.KeepAlive(&path)
	if err == nil {
		for i, c := range path {
			if c == 0 {
				if value := string(path[:i]); absolutePolicyPath(value) {
					return value, nil
				}
				break
			}
		}
	}
	return "", &processsvc.NativeFailure{}
}
