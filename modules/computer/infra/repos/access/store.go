package access

import (
	"context"
	"errors"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Store is the profile's sole current Computer authority owner. The trusted
// assembler supplies its private directory and binding; no workspace request
// selects either. All approval/grant changes must use this owner before product
// activation. Independent TS settings writers are not serialized by this lock.
// One native lock is held for the backend lifetime; Close belongs to its owner.
type Store struct {
	mutex            sync.Mutex
	binding          Binding
	disk             *disk
	clock            port.Clock
	current          state
	digest           [32]byte
	poisoned, closed bool
}

var _ port.AccessRepository = (*Store)(nil)

// CommitFailure preserves the distinction between an unavailable owner and a
// possibly published authority update. Its error unwraps to an existing refusal
// vocabulary; it never carries native paths or authorizes automatic replay.
type CommitFailure struct{ Unknown bool }

func (e *CommitFailure) Error() string { return unavailable().Error() }
func (e *CommitFailure) Unwrap() error { return unavailable() }
func OutcomeUnknown(err error) bool {
	var failure *CommitFailure
	return errors.As(err, &failure) && failure.Unknown
}

type Status struct {
	Revision, Generation uint64
	ApprovalPresent      bool
}

// Create starts with no approval and no participants. It cannot replace an
// existing snapshot. Open restores exactly the protected current state, never
// an expired launch snapshot or a fabricated default approval.
func Create(root string, binding Binding, clock port.Clock) (*Store, error) {
	return open(root, binding, clock, true)
}
func Open(root string, binding Binding, clock port.Clock) (*Store, error) {
	return open(root, binding, clock, false)
}
func open(root string, b Binding, clock port.Clock, create bool) (*Store, error) {
	if !validBinding(b) || clock == nil {
		return nil, unavailable()
	}
	return openWithDisk(root, b, clock, create, openDisk)
}

// Only package tests inject native sync failures into the real disk adapter.
// Production callers cannot select a weaker restore path.
func openWithDisk(root string, b Binding, clock port.Clock, create bool, openDisk func(string) (*disk, error)) (*Store, error) {
	if !validBinding(b) || clock == nil {
		return nil, unavailable()
	}
	d, err := openDisk(root)
	if err != nil {
		return nil, err
	}
	s := &Store{binding: b, disk: d, clock: clock}
	fail := func(err error) (*Store, error) { d.close(); return nil, err }
	if create {
		initial := state{Participants: map[string]retainedParticipant{}}
		raw, err := encodeState(b, initial)
		if err != nil {
			return fail(err)
		}
		if err = d.create(raw); err != nil {
			return fail(err)
		}
	}
	raw, err := d.read()
	if err != nil {
		return fail(err)
	}
	if s.current, err = decodeState(b, raw); err != nil {
		return fail(err)
	}
	// An unknown publication cannot lose its fence merely because visible bytes
	// can be decoded. Restore must qualify those exact bytes before activation.
	if err = d.confirm(raw); err != nil {
		return fail(err)
	}
	s.digest = digest(raw)
	return s, nil
}
func (s *Store) check(ctx context.Context) error {
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	if s.closed || s.poisoned {
		return unavailable()
	}
	raw, err := s.disk.read()
	if err != nil || digest(raw) != s.digest {
		s.poisoned = true
		return unavailable()
	}
	// Decode on restore and each trusted publication; byte identity keeps a valid
	// external replacement from bypassing the owner's mutation serialization.
	return nil
}
func (s *Store) Status(ctx context.Context) (Status, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.check(ctx); err != nil {
		return Status{}, err
	}
	return Status{s.current.Revision, s.current.Generation, s.current.Approval != nil}, nil
}
func (s *Store) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.check(ctx); err != nil {
		return err
	}
	if inspect == nil {
		return unavailable()
	}
	snapshot := port.AccessSnapshot{}
	if current, ok := s.current.Participants[id]; ok && !current.Revoked {
		p := participant(current.Value)
		snapshot.Participant = &p
		if s.current.Approval != nil {
			a := approval(*s.current.Approval)
			snapshot.Approval = &a
		}
	}
	return inspect(snapshot)
}
func (s *Store) Close() error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.disk.close()
}
func (s *Store) next(ctx context.Context, revision uint64) (state, error) {
	if err := s.check(ctx); err != nil {
		return state{}, err
	}
	if revision != s.current.Revision || revision == ^uint64(0) {
		return state{}, unavailable()
	}
	n := s.current
	n.Revision++
	n.Participants = make(map[string]retainedParticipant, len(s.current.Participants))
	for id, p := range s.current.Participants {
		n.Participants[id] = retainedParticipant{participant(p.Value), p.Revoked}
	}
	if n.Approval != nil {
		a := approval(*n.Approval)
		n.Approval = &a
	}
	return n, nil
}
func (s *Store) commit(ctx context.Context, n state) error {
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	raw, err := encodeState(s.binding, n)
	if err != nil {
		return err
	}
	// The same decoder gates restore and ingress, including graph and bounds.
	if _, err = decodeState(s.binding, raw); err != nil {
		return err
	}
	if err = s.disk.write(raw, s.digest); err != nil {
		s.poisoned = true
		return err
	}
	s.current = n
	s.digest = digest(raw)
	return nil
}
