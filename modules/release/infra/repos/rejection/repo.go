// Package rejection persists only the existing rejected-target.json record.
// It borrows the journal owner, gate and operation descriptor, never authority.
package rejection

import (
	"context"
	"errors"
	"os"
	"strconv"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"golang.org/x/sys/unix"
)

const filename = "rejected-target.json"
const failedName = "failed.app"

type fingerprint struct {
	device, inode, links                           uint64
	mode, uid, gid                                 uint32
	size, mtimeSec, mtimeNano, ctimeSec, ctimeNano int64
}

func (s fingerprint) object() fingerprint {
	s.links, s.size, s.mtimeSec, s.mtimeNano, s.ctimeSec, s.ctimeNano = 0, 0, 0, 0, 0, 0
	return s
}
func (s fingerprint) identity() port.HelperIdentity {
	return port.HelperIdentity{Device: strconv.FormatUint(s.device, 10), Inode: strconv.FormatUint(s.inode, 10)}
}
func (s fingerprint) directory(private bool) bool {
	mask := uint32(0o022)
	if private {
		mask = 0o077
	}
	return s.mode&unix.S_IFMT == unix.S_IFDIR && s.uid == uint32(os.Geteuid()) && s.mode&(mask|0o7000) == 0
}
func (s fingerprint) file() bool {
	return s.mode&unix.S_IFMT == unix.S_IFREG && s.uid == uint32(os.Geteuid()) && s.mode&0o7077 == 0 && s.links == 1 && s.size >= 0 && s.size <= records.MaxHelperRecordBytes
}
func canonical(s string) bool {
	n, err := strconv.ParseUint(s, 10, 64)
	return err == nil && strconv.FormatUint(n, 10) == s
}
func validBinding(b port.JournalDirectory) bool {
	return canonical(b.Device) && canonical(b.Inode) && canonical(b.ParentDevice) && canonical(b.ParentInode)
}
func record(op release.Operation, identity port.HelperIdentity) records.RejectedTarget {
	build := func(b release.Build) records.Build {
		return records.Build{Digest: b.Digest, Version: b.Version, BuildID: b.BuildID}
	}
	return records.RejectedTarget{Operation: records.Operation{ID: op.ID, Source: build(op.Source), Target: build(op.Target)}, Device: identity.Device, Inode: identity.Inode}
}

// Copies share attempt and close state. No descriptor is owned between calls.
type Repository struct{ state *state }
type state struct {
	directory               *os.File
	binding                 port.JournalDirectory
	operation               release.Operation
	admission               port.JournalAdmission
	gate                    port.StateGate
	original                context.Context
	until                   time.Time
	directoryPin, parentPin fingerprint
	attempted, closed       bool
	unknown                 error
	// Private per-instance seams; production uses only native calls.
	step    func(string) error
	write   func(*os.File, []byte) (int, error)
	publish func(int, string) error
	sync    func(*os.File) error
	close   func(*os.File) error
	create  func(int, string, int, uint32) (int, error)
}

var _ port.HelperTargetRejectionRepository = (*Repository)(nil)

func failure(code string, internal, uncertain bool, cause error) error {
	return &port.HelperRecoveryFailure{Code: code, Phase: "refused", Internal: internal, Uncertain: uncertain, Cause: cause}
}
func bounded(code string) bool {
	switch code {
	case "input", "directory", "failed_directory", "failed_changed", "existing", "attempt_used", "unknown", "admission", "native", "cleanup", "canceled", "unsupported", "closed":
		return true
	}
	return false
}

// The owner may return its existing helper refusal codes. Never copy a raw
// dependency code into an outward result; admission remains our closed code.
func dependencyCode(code string) bool {
	if len(code) == 0 || len(code) > 80 || code[0] < 'a' || code[0] > 'z' {
		return false
	}
	for _, c := range code[1:] {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
func uncertain(err error) bool {
	pending := []error{err}
	for remaining := 128; len(pending) > 0; remaining-- {
		if remaining == 0 {
			return true
		}
		e := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if e == nil {
			continue
		}
		if f, ok := e.(*port.HelperRecoveryFailure); ok && (f == nil || f.Uncertain) {
			return true
		}
		switch w := e.(type) {
		case interface{ Unwrap() []error }:
			causes := w.Unwrap()
			if len(causes) > remaining {
				return true
			}
			pending = append(pending, causes...)
		case interface{ Unwrap() error }:
			pending = append(pending, w.Unwrap())
		}
	}
	return false
}

// Only an original closed classification or exact cancellation sentinel is a
// refusal. Opaque wrappers/joins remain internal even if errors.Is matches one.
func classify(err error, possible bool) error {
	if err == nil {
		return nil
	}
	if f, ok := err.(*port.HelperRecoveryFailure); ok && f != nil && bounded(f.Code) && f.Phase == "refused" {
		return failure(f.Code, f.Internal, possible || f.Uncertain, err)
	}
	if err == context.Canceled || err == context.DeadlineExceeded {
		return failure("canceled", false, possible, err)
	}
	return failure("native", true, possible || uncertain(err), err)
}
func combine(primary, secondary error) error {
	if primary == nil {
		return classify(secondary, false)
	}
	if secondary == nil {
		return classify(primary, false)
	}
	a, b := classify(primary, false).(*port.HelperRecoveryFailure), classify(secondary, false).(*port.HelperRecoveryFailure)
	return failure(a.Code, a.Internal || b.Internal, a.Uncertain || b.Uncertain, errors.Join(primary, secondary))
}
func (s *state) retain(err error) error {
	s.unknown = combine(s.unknown, err)
	s.admission.RetainJournalUnknown(s.operation)
	return err
}

type callContext struct {
	context.Context
	original context.Context
	until    time.Time
}

func (c callContext) Deadline() (time.Time, bool) { return c.until, true }
func (c callContext) Err() error {
	if err := c.original.Err(); err != nil {
		return err
	}
	if err := c.Context.Err(); err != nil {
		return err
	}
	if !time.Now().Before(c.until) {
		return context.DeadlineExceeded
	}
	return nil
}
func (c callContext) check() error {
	// Preserve concurrent cancellation causes as well as independent time expiry.
	var causes []error
	if err := c.original.Err(); err != nil {
		causes = append(causes, err)
	}
	if err := c.Context.Err(); err != nil {
		causes = append(causes, err)
	}
	if !time.Now().Before(c.until) {
		causes = append(causes, context.DeadlineExceeded)
	}
	if len(causes) > 0 {
		return failure("canceled", false, false, errors.Join(causes...))
	}
	return nil
}
func (s *state) context(ctx context.Context) (callContext, func(), error) {
	if ctx == nil {
		return callContext{}, nil, failure("input", false, false, nil)
	}
	until := s.until
	if earlier, ok := ctx.Deadline(); ok && earlier.Before(until) {
		until = earlier
	}
	return s.effective(ctx, until)
}
func (s *state) effective(ctx context.Context, until time.Time) (callContext, func(), error) {
	// Freeze the supplied deadline before the standard library inspects it.
	parent := callContext{Context: ctx, original: s.original, until: until}
	base, cancel := context.WithDeadline(parent, until)
	// Cancellation propagation only; no native work or resource cleanup is detached.
	stop := context.AfterFunc(s.original, cancel)
	return callContext{Context: base, original: s.original, until: until}, func() { stop(); cancel() }, nil
}

// New performs no namespace mutation. The caller retains the SAME original
// journal admission and borrowed directory through every actual native return.
func New(ctx context.Context, directory *os.File, binding port.JournalDirectory, operation release.Operation, admission port.JournalAdmission, until time.Time) (repo *Repository, result error) {
	if ctx == nil || directory == nil || admission == nil || until.IsZero() {
		return nil, failure("input", false, false, nil)
	}
	gate := admission.JournalGate()
	if gate == nil || !validBinding(binding) {
		return nil, failure("input", false, false, nil)
	}
	if _, err := records.EncodeRejectedTarget(record(operation, port.HelperIdentity{Device: "0", Inode: "0"})); err != nil {
		return nil, failure("input", false, false, err)
	}
	if earlier, ok := ctx.Deadline(); ok && earlier.Before(until) {
		until = earlier
	}
	s := &state{directory: directory, binding: binding, operation: operation, admission: admission, gate: gate, original: ctx, until: until}
	effective, done, _ := s.effective(ctx, until)
	gate.Lock()
	defer gate.Unlock()
	defer done()
	defer func() {
		result = combine(result, effective.check())
		if result != nil {
			repo = nil
			if uncertain(result) {
				s.retain(result)
			}
		}
	}()
	if err := effective.check(); err != nil {
		return nil, err
	}
	if admission.JournalUnknown(operation) {
		return nil, failure("unknown", false, true, nil)
	}
	if !nativeSupported() {
		return nil, failure("unsupported", false, false, nil)
	}
	result = s.hold(func(fd int) error {
		if err := s.verifyDirectory(effective, fd, true); err != nil {
			return err
		}
		return s.fence(effective, fd)
	})
	if result != nil {
		return nil, result
	}
	return &Repository{state: s}, nil
}

// hold keeps the borrowed os.File alive without Fd's blocking-mode changes or
// duplication/closure of its open description, through synchronous cleanup.
func (s *state) hold(fn func(int) error) error {
	raw, err := s.directory.SyscallConn()
	if err != nil {
		return classify(err, false)
	}
	var result error
	err = raw.Control(func(fd uintptr) { result = fn(int(fd)) })
	return combine(result, classify(err, false))
}
func statFD(fd int) (fingerprint, error) {
	var st unix.Stat_t
	err := unix.Fstat(fd, &st)
	return metadata(st), err
}
func statAt(fd int, name string) (fingerprint, error) {
	var st unix.Stat_t
	err := unix.Fstatat(fd, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	return metadata(st), err
}
func directoryFlags() int {
	return unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
}
func fileFlags() int { return unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK }
func (s *state) checkpoint(point string) error {
	if s.step != nil {
		return classify(s.step(point), false)
	}
	return nil
}
func (s *state) closeOwned(f *os.File) error {
	close := s.close
	if close == nil {
		close = (*os.File).Close
	}
	if err := close(f); err != nil {
		return failure("cleanup", true, true, err)
	}
	return nil
}
func (s *state) verifyDirectory(ctx callContext, fd int, initial bool) (result error) {
	if err := ctx.check(); err != nil {
		return err
	}
	held, err := statFD(fd)
	if err != nil {
		return classify(err, false)
	}
	id := held.identity()
	if !held.directory(true) || id.Device != s.binding.Device || id.Inode != s.binding.Inode || !initial && held.object() != s.directoryPin {
		return failure("directory", false, false, nil)
	}
	parentFD, err := unix.Openat(fd, "..", directoryFlags(), 0)
	if err != nil {
		return classify(err, false)
	}
	parent := os.NewFile(uintptr(parentFD), "rejection-parent")
	defer func() { result = combine(combine(result, s.closeOwned(parent)), ctx.check()) }()
	p, err := statFD(parentFD)
	if err != nil {
		return classify(err, false)
	}
	pid := p.identity()
	if !p.directory(true) || pid.Device != s.binding.ParentDevice || pid.Inode != s.binding.ParentInode || !initial && p.object() != s.parentPin {
		return failure("directory", false, false, nil)
	}
	named, err := statAt(parentFD, s.operation.ID)
	if err != nil {
		return classify(err, false)
	}
	again, err := statAt(fd, "..")
	if err != nil {
		return classify(err, false)
	}
	if named.object() != held.object() || again.object() != p.object() {
		return failure("directory", false, false, nil)
	}
	if initial {
		s.directoryPin, s.parentPin = held.object(), p.object()
	}
	return nil
}
func (s *state) fence(ctx callContext, fd int) error {
	if err := s.verifyDirectory(ctx, fd, false); err != nil {
		return err
	}
	if s.admission.JournalUnknown(s.operation) {
		return failure("unknown", false, true, s.unknown)
	}
	if err := ctx.check(); err != nil {
		return err
	}
	if err := s.admission.ReverifyJournal(ctx, s.operation, s.binding); err != nil {
		// Invoked owner failure cannot be used to obtain a fresh admission.
		internal := true
		if f, ok := err.(*port.HelperRecoveryFailure); ok && f != nil && f.Phase == "refused" && dependencyCode(f.Code) {
			internal = f.Internal
		} else if err == context.Canceled || err == context.DeadlineExceeded {
			internal = false
		}
		return failure("admission", internal, true, err)
	}
	return combine(s.verifyDirectory(ctx, fd, false), ctx.check())
}

// Close serializes through actual return and closes no borrowed resource.
func (r *Repository) Close() error {
	if r == nil || r.state == nil {
		return failure("input", false, false, nil)
	}
	s := r.state
	s.gate.Lock()
	defer s.gate.Unlock()
	s.closed = true
	return nil
}
