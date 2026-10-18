//go:build darwin || linux

package installcopy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// WithCapture creates one internally named private image under the ORIGINAL
// operation directory. It never adopts, removes or retries a failed capture.
// Publication belongs to installmove's restricted capture-publication operation.
// All callbacks, native returns and owned cleanup join before the borrow ends.
func WithCapture(ctx context.Context, parent Directory, until time.Time, fence Fence, fn func(string, Directory) error) (result error) {
	if ctx == nil || parent.File == nil || !canonical(parent.Identity.Device) || !canonical(parent.Identity.Inode) || until.IsZero() || fence == nil || fn == nil {
		return refusal("input")
	}
	end := until
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(end) {
		end = deadline
	}
	bounded, cancel := context.WithDeadline(ctx, end)
	defer cancel()
	r := &runner{ctx: bounded, c: &captured{until: end, fence: fence}}
	if err := r.check(); err != nil {
		return err
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return osFailure(err)
	}
	name := ".launch-capture-" + hex.EncodeToString(nonce[:])
	raw, err := parent.File.SyscallConn()
	if err != nil {
		return osFailure(err)
	}
	var entered error
	err = raw.Control(func(fd uintptr) {
		entered = func() (result error) {
			if err := fence(bounded); err != nil {
				return err
			}
			before, err := r.held(int(fd))
			if err != nil {
				return err
			}
			if !before.privateDir() || before.identity() != parent.Identity {
				return refusal("changed")
			}
			defer func() {
				result = combine(result, r.check())
				if result != nil && r.effected {
					result = &Failure{Code: "launch_copy_io", Internal: true, Uncertain: true, cause: result}
				}
			}()
			if err := r.create("capture-mkdir", func() error {
				return unix.Mkdirat(int(fd), name, 0700)
			}); err != nil {
				return err
			}
			named, err := r.named(int(fd), name)
			if err != nil {
				return err
			}
			if !named.privateDir() || named.device != before.device {
				return refusal("changed")
			}
			child, err := unix.Openat(int(fd), name, dirFlags, 0)
			if err != nil {
				return osFailure(err)
			}
			file := os.NewFile(uintptr(child), "helper-private-capture")
			defer func() { result = combine(result, osFailure(file.Close()), r.check()) }()
			held, err := r.held(child)
			if err != nil || !held.sameObject(named) {
				return combine(err, refusal("changed"))
			}
			if err := r.match(int(fd), name, child, named); err != nil {
				return err
			}
			if err := fn(name, Directory{file, held.identity()}); err != nil {
				return err
			}
			// The callback may have published the capture. Retain and recheck the
			// held inode and parent, without adopting any other named image.
			after, err := r.held(int(fd))
			if err != nil || !before.sameObject(after) {
				return combine(err, refusal("changed"))
			}
			return combine(osFailure(file.Sync()), osFailure(parent.File.Sync()), fence(bounded))
		}()
	})
	return combine(entered, osFailure(err), r.check())
}
