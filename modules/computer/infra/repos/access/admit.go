package access

import (
	"context"
	"reflect"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// These methods are a trusted composition seam, not wire methods. Approval
// input comes only from current owner consent; task/participant input comes from
// the trusted admission owner. A caller body cannot supply either proof.
func (s *Store) UpdateApproval(ctx context.Context, revision uint64, value authority.Approval) error {
	return s.updateApproval(ctx, revision, value, nil)
}

// UpdateApprovalWithPublication keeps the same Store CAS and policy checks.
// Trusted composition holds current consent around one final snapshot rename;
// staging, durability and readback stay outside those authority gates. The
// callback is synchronous, calls publish exactly once only if current, and must
// not reenter Store. No wire request can supply this guard.
func (s *Store) UpdateApprovalWithPublication(ctx context.Context, revision uint64, value authority.Approval, withPublication func(func() error) error) error {
	if withPublication == nil {
		return unavailable()
	}
	return s.updateApproval(ctx, revision, value, withPublication)
}

func (s *Store) updateApproval(ctx context.Context, revision uint64, value authority.Approval, withPublication func(func() error) error) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	n, err := s.next(ctx, revision)
	if err != nil {
		return err
	}
	if !validApproval(value, s.binding) {
		return invalid()
	}
	now, err := s.now()
	if err != nil {
		return err
	}
	if now.After(value.ExpiresAt) {
		return authority.Fail("AUTHORITY_EXPIRED", "computer-approval")
	}
	if n.SeenApproval {
		if value.Generation < n.Generation || value.Generation == n.Generation && n.Approval == nil {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
		}
		if value.Generation == n.Generation {
			before := approval(*n.Approval)
			after := approval(value)
			before.ExpiresAt = after.ExpiresAt
			if !reflect.DeepEqual(encodeApproval(before), encodeApproval(after)) {
				return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
			}
		}
	}
	value = approval(value)
	n.Approval = &value
	n.Generation = value.Generation
	n.SeenApproval = true
	return s.commitWithPublication(ctx, n, withPublication)
}
func (s *Store) RevokeApproval(ctx context.Context, revision uint64) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	n, err := s.next(ctx, revision)
	if err != nil {
		return err
	}
	// Preserve the seen generation. Reissue after revocation needs a later owner
	// approval generation; a cached startup approval cannot resurrect consent.
	n.Approval = nil
	n.SeenApproval = true
	return s.commit(ctx, n)
}
func (s *Store) Admit(ctx context.Context, revision uint64, input authority.Admission, identity authority.ParticipantAdmission) (*authority.Participant, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	n, err := s.next(ctx, revision)
	if err != nil {
		return nil, err
	}
	if input.OwnerID != s.binding.OwnerID || input.ComputerID != s.binding.ComputerID || !identifier(input.SessionID, 120) || !identifier(input.TaskID, 120) || !identifier(input.AuthorityID, 120) || !identifier(identity.ParticipantID, 120) || !validPolicy(input.Policy) {
		return nil, invalid()
	}
	if n.Approval == nil {
		return nil, authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-policy")
	}
	now, err := s.now()
	if err != nil {
		return nil, err
	}
	g, err := authority.Derive(*n.Approval, input, now)
	if err != nil {
		return nil, err
	}
	p, err := authority.Create(*g, identity)
	if err != nil {
		return nil, err
	}
	if existing, ok := n.Participants[p.ParticipantID]; ok {
		if existing.Revoked || !reflect.DeepEqual(encodeParticipant(existing.Value, false), encodeParticipant(*p, false)) {
			return nil, authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
		}
		out := participant(existing.Value)
		return &out, nil
	}
	if len(n.Participants) >= maxParticipants {
		return nil, unavailable()
	}
	n.Participants[p.ParticipantID] = retainedParticipant{Value: participant(*p)}
	if err = s.commit(ctx, n); err != nil {
		return nil, err
	}
	out := participant(*p)
	return &out, nil
}
func (s *Store) Delegate(ctx context.Context, revision uint64, parentID string, input authority.Delegation) (*authority.Participant, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	n, err := s.next(ctx, revision)
	if err != nil {
		return nil, err
	}
	parent, ok := n.Participants[parentID]
	if !ok || parent.Revoked {
		return nil, authority.Fail("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store")
	}
	if n.Approval == nil {
		return nil, authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-policy")
	}
	if parent.Value.Grant.ComputerGeneration != n.Approval.Generation || !n.Approval.FilePolicy.Valid() || parent.Value.Grant.FilePolicy != n.Approval.FilePolicy {
		return nil, authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
	now, err := s.now()
	if err != nil {
		return nil, err
	}
	if now.After(parent.Value.Grant.ExpiresAt) || now.After(n.Approval.ExpiresAt) {
		return nil, authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	p, err := authority.Delegate(parent.Value, input)
	if err != nil {
		return nil, err
	}
	if !validParticipant(*p, s.binding) {
		return nil, invalid()
	}
	if existing, ok := n.Participants[p.ParticipantID]; ok {
		if existing.Revoked || !reflect.DeepEqual(encodeParticipant(existing.Value, false), encodeParticipant(*p, false)) {
			return nil, authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
		}
		out := participant(existing.Value)
		return &out, nil
	}
	if len(n.Participants) >= maxParticipants {
		return nil, unavailable()
	}
	n.Participants[p.ParticipantID] = retainedParticipant{Value: participant(*p)}
	if err = s.commit(ctx, n); err != nil {
		return nil, err
	}
	out := participant(*p)
	return &out, nil
}
func (s *Store) RevokeParticipant(ctx context.Context, revision uint64, id string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	n, err := s.next(ctx, revision)
	if err != nil {
		return err
	}
	if _, ok := n.Participants[id]; !ok {
		return authority.Fail("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store")
	}
	revoked := map[string]bool{id: true}
	for changed := true; changed; {
		changed = false
		for id, p := range n.Participants {
			if !revoked[id] && revoked[p.Value.ParentParticipantID] {
				revoked[id] = true
				changed = true
			}
		}
	}
	for id := range revoked {
		p := n.Participants[id]
		p.Revoked = true
		n.Participants[id] = p
	}
	return s.commit(ctx, n)
}
