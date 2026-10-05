package lifecycle

import (
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"sync"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_JOURNAL_INVALID"
	Refused     Code = "CHAT_JOURNAL_REFUSED"
	Unavailable Code = "CHAT_JOURNAL_UNAVAILABLE"
	Unknown     Code = "CHAT_JOURNAL_UNKNOWN"
	Cancelled   Code = "CHAT_JOURNAL_CANCELLED"
)

// Failure never includes paths, raw IO diagnostics or private content. Unknown
// marks possibly published bytes; every failure is sticky for this owner and
// supplies no permission to retry, reopen, unlink a claim or change executor.
type Failure struct {
	Code           Code
	OutcomeUnknown bool
}

func (f *Failure) Error() string         { return string(f.Code) }
func (f *Failure) Unwrap() error         { return f.Code }
func failure(c Code, unknown bool) error { return &Failure{Code: c, OutcomeUnknown: unknown} }

// Root is a trusted boot qualification, not a body-selected path or profile.
// Physical identity remains stable across backend incarnations. Boot must retain
// the association to the real profile; creating a fresh replacement root cannot
// discharge an earlier unknown journal. Native checks verify rather than infer it.
type Root struct {
	Path, ProfileID string
	Device, Inode   uint64
	OwnerUID        uint32
}

// Limits are explicit accepted metadata-storage budgets from boot. No entries or
// unknown fences are evicted at saturation; the write is refused before IO.
type Limits struct{ Bytes, Records int }

// Repository copies alias the SAME owner/mutex/claim, never an independent writer.
type Repository struct{ owner *owner }
type owner struct {
	mu                       sync.Mutex
	profile                  string
	root                     port.JournalRoot
	predecessor              *record
	expectedScope            port.JournalScope
	limits                   Limits
	disk                     storage
	current                  record
	digest                   [32]byte
	opened, poisoned, closed bool
	closeErr                 error
	lastFailure              error
}

var _ port.Journal = (*Repository)(nil)

// storage is adapter-private for failure-window tests. Production always uses
// the native implementation and its permanent root claim; callers cannot inject
// weaker IO or choose a restore path.
type storage interface {
	read(int) ([]byte, error)
	create(context.Context, []byte) error
	replace(context.Context, []byte, [32]byte, int) error
	close() error
}

func New(ctx context.Context, root Root, limits Limits) (*Repository, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	if !validID(root.ProfileID) || !validLimits(limits) {
		return nil, failure(Invalid, false)
	}
	d, err := openDisk(ctx, root)
	if err != nil {
		return nil, err
	}
	return newOwner(root.ProfileID, limits, d, root.identity()), nil
}
func newOwner(profile string, limits Limits, d storage, root port.JournalRoot) *Repository {
	return &Repository{owner: &owner{profile: profile, limits: limits, disk: d, root: root}}
}
func validLimits(l Limits) bool { return l.Bytes > 0 && l.Bytes < math.MaxInt && l.Records > 0 }

func (r *Repository) OpenFresh(ctx context.Context, scope port.JournalScope) (*port.JournalHead, error) {
	if r == nil || r.owner == nil || ctx == nil {
		return nil, failure(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkContext(ctx); err != nil {
		return nil, err
	}
	if s.opened || !validID(scope.ProfileID) || !validID(scope.BackendGeneration) || scope.ProfileID != s.profile {
		return nil, s.reject(Refused, false)
	}
	incarnations := []string{scope.BackendGeneration}
	if s.predecessor != nil {
		if scope != s.expectedScope {
			return nil, s.reject(Refused, false)
		}
		incarnations = append(append([]string{}, s.predecessor.Incarnations...), scope.BackendGeneration)
	}
	initial := record{Version: 3, Root: s.root, Scope: scope, Incarnations: incarnations, Writes: []port.JournalWrite{}}
	raw, err := encode(initial, s.limits)
	if err != nil {
		return nil, s.reject(Invalid, false)
	}
	if s.predecessor == nil {
		err = s.disk.create(ctx, raw)
	} else {
		err = s.disk.replace(ctx, raw, s.digest, s.limits.Bytes)
	}
	if err != nil {
		return nil, s.storageFailure(err)
	}
	visible, err := s.disk.read(s.limits.Bytes)
	if err != nil || sha256.Sum256(visible) != sha256.Sum256(raw) {
		return nil, s.reject(Unknown, true)
	}
	if ctx.Err() != nil {
		return nil, s.reject(Unknown, true)
	}
	s.current, s.digest, s.opened = initial, sha256.Sum256(raw), true
	s.predecessor = nil
	return &port.JournalHead{Scope: scope, Root: s.root}, nil
}

// Commit never replays a known or uncertain write. Scope, revision, canonical
// metadata and exact queue semantics are checked before native publication.
func (r *Repository) Commit(ctx context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if r == nil || r.owner == nil || ctx == nil {
		return nil, failure(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkContext(ctx); err != nil {
		return nil, err
	}
	if !s.opened {
		return nil, s.reject(Refused, false)
	}
	visible, err := s.disk.read(s.limits.Bytes)
	if err != nil {
		return nil, s.storageFailure(err)
	}
	if sha256.Sum256(visible) != s.digest {
		return nil, s.reject(Unavailable, false)
	}
	candidate := s.current
	candidate.Writes = append(append([]port.JournalWrite(nil), s.current.Writes...), w)
	raw, err := encode(candidate, s.limits)
	if err != nil {
		return nil, s.reject(Refused, false)
	}
	if ctx.Err() != nil {
		return nil, s.reject(Cancelled, false)
	}
	if err = s.disk.replace(ctx, raw, s.digest, s.limits.Bytes); err != nil {
		return nil, s.storageFailure(err)
	}
	visible, err = s.disk.read(s.limits.Bytes)
	if err != nil || sha256.Sum256(visible) != sha256.Sum256(raw) || ctx.Err() != nil {
		return nil, s.reject(Unknown, true)
	}
	s.current, s.digest = candidate, sha256.Sum256(raw)
	return &port.JournalReceipt{Write: w}, nil
}

func (s *owner) checkContext(ctx context.Context) error {
	if s.poisoned {
		return s.lastFailure
	}
	if s.closed {
		return failure(Unavailable, s.closeErr != nil)
	}
	if ctx.Err() != nil {
		return s.reject(Cancelled, false)
	}
	return nil
}
func (s *owner) reject(c Code, unknown bool) error {
	if !s.poisoned {
		s.poisoned = true
		s.lastFailure = failure(c, unknown)
	}
	return s.lastFailure
}
func (s *owner) storageFailure(err error) error {
	var classified *Failure
	if errors.As(err, &classified) {
		switch classified.Code {
		case Invalid, Refused, Unavailable, Unknown, Cancelled:
			return s.reject(classified.Code, classified.OutcomeUnknown)
		}
	}
	return s.reject(Unknown, true)
}

// Close belongs only to boot's lifetime owner. It releases owned descriptors;
// the permanent claim and every snapshot/temp fence remain. It is not retirement.
func (r *Repository) Close() error {
	if r == nil || r.owner == nil {
		return failure(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.closeErr
	}
	s.closed = true
	if s.disk.close() != nil {
		s.closeErr = failure(Unavailable, true)
		return s.closeErr
	}
	return nil
}
