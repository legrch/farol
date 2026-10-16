package rejection

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"golang.org/x/sys/unix"
)

// Record consumes the shared attempt before observing cancellation or doing I/O.
// Synchronous native work and every owned Close finish before the gate releases.
func (r *Repository) Record(ctx context.Context, expected port.HelperIdentity) (result error) {
	if r == nil || r.state == nil {
		return failure("input", false, false, nil)
	}
	s := r.state
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.attempted {
		return failure("attempt_used", false, s.unknown != nil || s.admission.JournalUnknown(s.operation), s.unknown)
	}
	s.attempted = true
	if s.closed {
		return failure("closed", false, s.unknown != nil, s.unknown)
	}
	effective, done, err := s.context(ctx)
	if err != nil {
		return err
	}
	defer done()
	possible, returned := false, false
	defer func() {
		// Runs after hold and all owned cleanup, including panic/Goexit unwind.
		// Do not recover or replace the original unwind; retain its possible
		// persistence before allowing another consumer through the owner gate.
		if possible && !returned {
			result = combine(result, failure("unknown", true, true, nil))
		}
		result = classify(combine(result, effective.check()), possible)
		if uncertain(result) {
			s.retain(result)
		}
	}()
	if s.unknown != nil || s.admission.JournalUnknown(s.operation) {
		return failure("unknown", false, true, s.unknown)
	}
	if err := effective.check(); err != nil {
		return err
	}
	if !canonical(expected.Device) || !canonical(expected.Inode) {
		return failure("input", false, false, nil)
	}
	result = s.hold(func(fd int) error { return s.record(effective, fd, expected, &possible) })
	returned = true
	return result
}

func (s *state) absent(ctx callContext, fd int) error {
	if err := ctx.check(); err != nil {
		return err
	}
	if _, err := statAt(fd, filename); err == nil {
		return failure("existing", false, false, nil)
	} else if !errors.Is(err, unix.ENOENT) {
		return classify(err, false)
	}
	if err := s.checkpoint("absence"); err != nil {
		return err
	}
	if err := s.verifyDirectory(ctx, fd, false); err != nil {
		return err
	}
	if err := ctx.check(); err != nil {
		return err
	}
	if _, err := statAt(fd, filename); err == nil {
		return failure("existing", false, false, nil)
	} else if !errors.Is(err, unix.ENOENT) {
		return classify(err, false)
	}
	return nil
}
func (s *state) failed(ctx callContext, fd int, expected port.HelperIdentity) (file *os.File, pin fingerprint, result error) {
	if err := ctx.check(); err != nil {
		return nil, pin, err
	}
	before, err := statAt(fd, failedName)
	if err != nil {
		return nil, pin, classify(err, false)
	}
	if !before.directory(false) || before.identity() != expected {
		return nil, pin, failure("failed_directory", false, false, nil)
	}
	if err := s.checkpoint("failed-open"); err != nil {
		return nil, pin, err
	}
	if err := ctx.check(); err != nil {
		return nil, pin, err
	}
	opened, err := unix.Openat(fd, failedName, directoryFlags(), 0)
	if err != nil {
		return nil, pin, classify(err, false)
	}
	file = os.NewFile(uintptr(opened), "rejection-failed")
	if err := s.checkFailed(ctx, fd, opened, before); err != nil {
		return nil, pin, combine(err, s.closeOwned(file))
	}
	return file, before, nil
}
func (s *state) checkFailed(ctx callContext, fd, failedFD int, pin fingerprint) error {
	if err := ctx.check(); err != nil {
		return err
	}
	held, err := statFD(failedFD)
	if err != nil {
		return classify(err, false)
	}
	named, err := statAt(fd, failedName)
	if err != nil {
		return classify(err, false)
	}
	// Include size, link count, mtime and ctime: content mutation or mode/owner
	// changes during this one rejection cannot silently reuse a directory pin.
	if !held.directory(false) || held != pin || named != pin {
		return failure("failed_changed", false, false, nil)
	}
	return combine(s.verifyDirectory(ctx, fd, false), ctx.check())
}
func (s *state) syncOwned(file *os.File) error {
	sync := s.sync
	if sync == nil {
		sync = (*os.File).Sync
	}
	return classify(sync(file), false)
}
func (s *state) record(ctx callContext, fd int, expected port.HelperIdentity, possible *bool) (result error) {
	if err := s.fence(ctx, fd); err != nil {
		return err
	}
	if err := s.absent(ctx, fd); err != nil {
		return err
	}
	failed, pin, err := s.failed(ctx, fd, expected)
	if err != nil {
		return err
	}
	// Fd is used only for this OWNED description, never the borrowed directory.
	failedFD := int(failed.Fd())
	defer func() { result = combine(result, s.closeOwned(failed)) }()
	data, err := records.EncodeRejectedTarget(record(s.operation, pin.identity()))
	if err != nil {
		return failure("input", false, false, err)
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return classify(err, false)
	}
	temp := ".rejected-target-" + hex.EncodeToString(nonce[:])
	if err := s.checkpoint("create-before"); err != nil {
		return err
	}
	if err := s.fence(ctx, fd); err != nil {
		return err
	}
	if err := s.checkFailed(ctx, fd, failedFD, pin); err != nil {
		return err
	}
	if err := s.absent(ctx, fd); err != nil {
		return err
	}
	if err := ctx.check(); err != nil {
		return err
	}
	create := s.create
	if create == nil {
		create = unix.Openat
	}
	// Even a lost/error create result may hide persistence. No subsequent failure
	// deletes/replays the temporary evidence or clears the original owner's state.
	*possible = true
	createdFD, err := create(fd, temp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC|unix.O_NONBLOCK, 0o600)
	if err != nil {
		if createdFD >= 0 {
			err = errors.Join(err, s.closeOwned(os.NewFile(uintptr(createdFD), "rejection-temp")))
		}
		return classify(err, true)
	}
	file := os.NewFile(uintptr(createdFD), "rejection-temp")
	closed := false
	defer func() {
		if !closed {
			result = combine(result, s.closeOwned(file))
		}
	}()
	if err := s.checkpoint("create-after"); err != nil {
		return err
	}
	if err := ctx.check(); err != nil {
		return err
	}
	created, err := statFD(createdFD)
	if err != nil {
		return classify(err, false)
	}
	if !created.file() || created.size != 0 {
		return failure("native", true, false, nil)
	}
	write := s.write
	if write == nil {
		write = (*os.File).Write
	}
	for offset := 0; offset < len(data); {
		if err := s.checkpoint("write-before"); err != nil {
			return err
		}
		if err := ctx.check(); err != nil {
			return err
		}
		n, err := write(file, data[offset:])
		if err != nil {
			return classify(err, false)
		}
		if n <= 0 || n > len(data)-offset {
			return failure("native", true, false, io.ErrShortWrite)
		}
		offset += n
	}
	if err := s.checkpoint("write-after"); err != nil {
		return err
	}
	if err := s.fence(ctx, fd); err != nil {
		return err
	}
	if err := s.checkFailed(ctx, fd, failedFD, pin); err != nil {
		return err
	}
	if err := s.checkpoint("file-sync-before"); err != nil {
		return err
	}
	if err := ctx.check(); err != nil {
		return err
	}
	if err := s.syncOwned(file); err != nil {
		return err
	}
	if err := s.checkpoint("file-sync-after"); err != nil {
		return err
	}
	complete, err := statFD(createdFD)
	if err != nil {
		return classify(err, false)
	}
	if !complete.file() || complete.object() != created.object() || complete.size != int64(len(data)) {
		return failure("native", true, false, nil)
	}
	err = s.closeOwned(file)
	closed = true
	if err != nil {
		return err
	}
	if err := s.checkpoint("file-close-after"); err != nil {
		return err
	}
	if err := s.checkpoint("publish-before"); err != nil {
		return err
	}
	if err := s.fence(ctx, fd); err != nil {
		return err
	}
	if err := s.checkFailed(ctx, fd, failedFD, pin); err != nil {
		return err
	}
	if err := s.absent(ctx, fd); err != nil {
		return err
	}
	named, err := statAt(fd, temp)
	if err != nil {
		return classify(err, false)
	}
	if named != complete {
		return failure("native", true, false, nil)
	}
	if err := ctx.check(); err != nil {
		return err
	}
	rename := s.publish
	if rename == nil {
		rename = publish
	}
	if err := rename(fd, temp); err != nil {
		return classify(err, false)
	}
	if err := s.checkpoint("rename-after"); err != nil {
		return err
	}
	if err := s.fence(ctx, fd); err != nil {
		return err
	}
	if err := s.checkFailed(ctx, fd, failedFD, pin); err != nil {
		return err
	}
	if err := s.checkpoint("parent-sync-before"); err != nil {
		return err
	}
	if err := ctx.check(); err != nil {
		return err
	}
	// Sync the actual borrowed directory without closing or changing its flags.
	if err := s.syncOwned(s.directory); err != nil {
		return err
	}
	if err := s.checkpoint("parent-sync-after"); err != nil {
		return err
	}
	if err := s.checkpoint("readback-before"); err != nil {
		return err
	}
	if err := s.readback(ctx, fd, complete, data); err != nil {
		return err
	}
	if err := s.fence(ctx, fd); err != nil {
		return err
	}
	if err := s.checkFailed(ctx, fd, failedFD, pin); err != nil {
		return err
	}
	return s.checkpoint("ack-before")
}
func (s *state) readback(ctx callContext, fd int, complete fingerprint, expected []byte) (result error) {
	if err := ctx.check(); err != nil {
		return err
	}
	before, err := statAt(fd, filename)
	if err != nil {
		return classify(err, false)
	}
	// Rename may change ctime; bind to its resulting stable metadata below while
	// preserving the created object, mode/owner, size and mutation time.
	if !before.file() || before.object() != complete.object() || before.size != complete.size || before.mtimeSec != complete.mtimeSec || before.mtimeNano != complete.mtimeNano {
		return failure("native", true, false, nil)
	}
	if err := s.checkpoint("read-open"); err != nil {
		return err
	}
	if err := ctx.check(); err != nil {
		return err
	}
	opened, err := unix.Openat(fd, filename, fileFlags(), 0)
	if err != nil {
		return classify(err, false)
	}
	file := os.NewFile(uintptr(opened), "rejection-readback")
	defer func() { result = combine(result, s.closeOwned(file)) }()
	held, err := statFD(opened)
	if err != nil {
		return classify(err, false)
	}
	if held != before {
		return failure("native", true, false, nil)
	}
	if err := ctx.check(); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(file, records.MaxHelperRecordBytes+1))
	if err != nil {
		return classify(err, false)
	}
	if len(data) > records.MaxHelperRecordBytes || int64(len(data)) != before.size || !bytes.Equal(data, expected) {
		return failure("native", true, false, nil)
	}
	if err := s.checkpoint("read-bytes"); err != nil {
		return err
	}
	if err := ctx.check(); err != nil {
		return err
	}
	held, err = statFD(opened)
	if err != nil {
		return classify(err, false)
	}
	named, err := statAt(fd, filename)
	if err != nil {
		return classify(err, false)
	}
	if held != before || named != before {
		return failure("native", true, false, nil)
	}
	// Exact encoder bytes exclude duplicate keys, unknown fields and Unicode
	// substitution, without changing the wider legacy persisted decoder.
	_, err = records.DecodeRejectedTarget(data, record(s.operation, port.HelperIdentity{}).Operation)
	return classify(err, false)
}
