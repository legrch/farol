//go:build darwin

package boot

import (
	"errors"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

// Inherited stdin/stdout may be blocking descriptors that os.NewFile did not
// register with the Go poller. Own duplicates of ONLY pipe/socket streams in
// this private child. The original handles remain owned by Run; no descriptors
// or process identities are borrowed from another lifetime.
func emptyRecoveryDeadlineStreams(in io.Reader, out io.Writer) (io.Reader, io.Writer, func() error, error) {
	var owned []*os.File
	closeOwned := func() error {
		var result error
		for _, f := range owned {
			result = errors.Join(result, f.Close())
		}
		owned = nil
		return result
	}
	duplicate := func(value any) (any, error) {
		f, ok := value.(*os.File)
		if !ok {
			return value, nil // Pure peers must still supply both deadline methods.
		}
		raw, err := f.SyscallConn()
		if err != nil {
			return nil, err
		}
		fd := -1
		var nativeErr error
		err = raw.Control(func(original uintptr) {
			var s unix.Stat_t
			nativeErr = unix.Fstat(int(original), &s)
			if nativeErr != nil {
				return
			}
			kind := uint32(s.Mode) & unix.S_IFMT
			if kind != unix.S_IFIFO && kind != unix.S_IFSOCK {
				nativeErr = os.ErrInvalid
				return
			}
			fd, nativeErr = unix.Dup(int(original))
			if nativeErr == nil {
				unix.CloseOnExec(fd)
				nativeErr = unix.SetNonblock(fd, true)
			}
		})
		if err != nil || nativeErr != nil {
			if fd >= 0 {
				nativeErr = errors.Join(nativeErr, unix.Close(fd))
			}
			return nil, errors.Join(err, nativeErr)
		}
		pollable := os.NewFile(uintptr(fd), "empty-recovery-owned-pipe")
		if pollable == nil {
			return nil, errors.Join(os.ErrInvalid, unix.Close(fd))
		}
		owned = append(owned, pollable)
		return pollable, nil
	}
	r, err := duplicate(in)
	if err != nil {
		return nil, nil, nil, errors.Join(err, closeOwned())
	}
	w, err := duplicate(out)
	if err != nil {
		return nil, nil, nil, errors.Join(err, closeOwned())
	}
	return r.(io.Reader), w.(io.Writer), closeOwned, nil
}
