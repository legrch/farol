// Package handoff persists Chat-owned retirement evidence, never journal recovery.
package handoff

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"sync"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
)

const maxBytes = 16384
const maxSteps = 1024

type Root struct {
	Path     string
	Identity port.JournalRoot
}

// Roots comes from trusted boot qualification. Chat is the fixed existing
// "chat" child of Parent. Native storage never creates or replaces a directory.
type Roots struct {
	ProfileID    string
	Parent, Chat Root
}

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_HANDOFF_STORE_INVALID"
	Refused     Code = "CHAT_HANDOFF_STORE_REFUSED"
	Unknown     Code = "CHAT_HANDOFF_STORE_UNKNOWN"
	Unavailable Code = "CHAT_HANDOFF_STORE_UNAVAILABLE"
	Cancelled   Code = "CHAT_HANDOFF_STORE_CANCELLED"
)

type Failure struct {
	Code           Code
	OutcomeUnknown bool
}

func (f *Failure) Error() string      { return string(f.Code) }
func (f *Failure) Unwrap() error      { return f.Code }
func fail(c Code, unknown bool) error { return &Failure{Code: c, OutcomeUnknown: unknown} }

// storage is private for CPU-only failure fixtures. No public injectable native
// constructor exists. Attempt/commit files are immutable and never removed.
type storage interface {
	read(context.Context, int) ([]byte, bool, error)
	append(context.Context, int, []byte) error
	close() error
	poison() error
}
type Repository struct{ owner *owner }
type owner struct {
	mu               sync.Mutex
	policyGuard      sync.Mutex
	roots            Roots
	disk             storage
	poisoned, closed bool
	closeErr         error
	fenceErr         error
}

var _ port.HandoffStore = (*Repository)(nil)

func New(ctx context.Context, roots Roots) (*Repository, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, fail(Cancelled, false)
	}
	d, err := openDisk(ctx, roots)
	if err != nil {
		return nil, err
	}
	return &Repository{owner: &owner{roots: roots, disk: d}}, nil
}
func encode(r port.HandoffRecord) ([]byte, error) {
	if policy.ValidateRecord(r) != nil {
		return nil, fail(Invalid, false)
	}
	raw, err := json.Marshal(r)
	if err != nil || len(raw) > maxBytes {
		return nil, fail(Invalid, false)
	}
	return raw, nil
}
func decode(raw []byte) (port.HandoffRecord, error) {
	if len(raw) == 0 || len(raw) > maxBytes || !utf8.Valid(raw) || !boundedDepth(raw) {
		return port.HandoffRecord{}, fail(Invalid, false)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var r port.HandoffRecord
	if dec.Decode(&r) != nil || dec.Decode(new(any)) != io.EOF {
		return r, fail(Invalid, false)
	}
	canonical, err := encode(r)
	if err != nil || !bytes.Equal(raw, canonical) {
		return r, fail(Invalid, false)
	}
	return r, nil
}
func (s *owner) check(ctx context.Context) error {
	if ctx == nil {
		return fail(Invalid, false)
	}
	if s.poisoned {
		return fail(Unknown, true)
	}
	if s.closed {
		return fail(Unavailable, s.closeErr != nil)
	}
	if ctx.Err() != nil {
		return fail(Cancelled, false)
	}
	return nil
}
func (s *owner) uncertain() error {
	if !s.poisoned {
		s.poisoned = true
		s.fenceErr = s.disk.poison()
	}
	return fail(Unknown, true)
}
func (s *owner) bound(r port.HandoffRecord) bool {
	b := r.Publication.Binding
	return b.ProfileID == s.roots.ProfileID && b.ParentRoot == s.roots.Parent.Identity && b.ChatRoot == s.roots.Chat.Identity
}
func (s *owner) scan(ctx context.Context) (*port.HandoffHead, int, []port.HandoffRecord, error) {
	head := &port.HandoffHead{}
	history := []port.HandoffRecord{}
	for index := 1; index <= maxSteps+1; index++ {
		raw, present, err := s.disk.read(ctx, index)
		if err != nil || ctx.Err() != nil {
			return nil, 0, nil, s.uncertain()
		}
		if !present {
			return head, index, history, nil
		}
		if index > maxSteps {
			return nil, 0, nil, s.uncertain()
		}
		r, err := decode(raw)
		if err != nil || !s.bound(r) || policy.ValidateTransition(head.Record, head.Digest, r) != nil || reused(history, r) {
			return nil, 0, nil, s.uncertain()
		}
		d := sha256.Sum256(raw)
		copy := policy.Copy(r)
		head = &port.HandoffHead{Record: &copy, Digest: d}
		history = append(history, r)
	}
	return nil, 0, nil, s.uncertain()
}

// At cycle boundaries no old origin, host lifetime, child launch, successor
// attempt or generation may be reused, even after several successful cycles.
func reused(history []port.HandoffRecord, r port.HandoffRecord) bool {
	for _, old := range history {
		if r.Stage == port.HandoffCaptured && old.Stage == port.HandoffCaptured {
			a, b := old.Publication, r.Publication
			if a.HandoffID == b.HandoffID || a.Binding.BackendGeneration == b.Binding.BackendGeneration || a.Binding.HostLifetimeID == b.Binding.HostLifetimeID || a.Binding.ChildLaunchID == b.Binding.ChildLaunchID {
				return true
			}
		}
		if r.Stage == port.HandoffConsumed {
			if old.Stage == port.HandoffCaptured && old.Publication.Binding.BackendGeneration == r.Consumption.Next.BackendGeneration {
				return true
			}
			if old.Stage == port.HandoffConsumed && (old.Consumption.Next.BackendGeneration == r.Consumption.Next.BackendGeneration || old.Consumption.AttemptID == r.Consumption.AttemptID) {
				return true
			}
		}
	}
	return false
}
func (r *Repository) Load(ctx context.Context) (*port.HandoffHead, error) {
	if r == nil || r.owner == nil {
		return nil, fail(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(ctx); err != nil {
		return nil, err
	}
	h, _, _, err := s.scan(ctx)
	return h, err
}
func (r *Repository) Publish(ctx context.Context, expected [32]byte, next port.HandoffRecord) (*port.HandoffHead, error) {
	if r == nil || r.owner == nil {
		return nil, fail(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(ctx); err != nil {
		return nil, err
	}
	next = policy.Copy(next)
	raw, err := encode(next)
	if err != nil || !s.bound(next) {
		return nil, fail(Invalid, false)
	}
	h, index, history, err := s.scan(ctx)
	if err != nil {
		return nil, err
	}
	if h.Digest != expected || policy.ValidateTransition(h.Record, h.Digest, next) != nil || reused(history, next) || index > maxSteps {
		return nil, fail(Refused, false)
	}
	if ctx.Err() != nil {
		return nil, fail(Cancelled, false)
	}
	if s.disk.append(ctx, index, raw) != nil {
		return nil, s.uncertain()
	}
	visible, present, err := s.disk.read(ctx, index)
	if err != nil || !present || !bytes.Equal(visible, raw) || ctx.Err() != nil {
		return nil, s.uncertain()
	}
	return &port.HandoffHead{Record: &next, Digest: sha256.Sum256(raw)}, nil
}

// Close releases only owned descriptors. It never removes a claim, attempt,
// committed record or unknown fence, and can never discharge uncertainty.
func (r *Repository) Close() error {
	if r == nil || r.owner == nil {
		return fail(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.closeErr
	}
	s.closed = true
	if s.disk.close() != nil {
		s.poisoned = true
		s.closeErr = fail(Unknown, true)
	}
	return s.closeErr
}

// Guard is dedicated policy serialization; it is distinct from the repository
// IO mutex and from the actual retiring lifecycle owner's gate.
func (r *Repository) Guard() port.Gate {
	if r == nil || r.owner == nil {
		return nil
	}
	return &r.owner.policyGuard
}

func (r *Repository) Digest(value port.HandoffRecord) ([32]byte, error) {
	raw, err := encode(value)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

func boundedDepth(raw []byte) bool {
	depth := 0
	quoted, escape := false, false
	for _, c := range raw {
		if quoted {
			if escape {
				escape = false
			} else if c == '\\' {
				escape = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		if c == '"' {
			quoted = true
		} else if c == '{' || c == '[' {
			depth++
			if depth > 24 {
				return false
			}
		} else if c == '}' || c == ']' {
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	return !quoted && depth == 0
}

func (r *Repository) Fence(ctx context.Context) error {
	if r == nil || r.owner == nil || ctx == nil {
		return fail(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return fail(Unknown, true)
	}
	if !s.poisoned {
		s.poisoned = true
		s.fenceErr = s.disk.poison()
	}
	return s.fenceErr
}
