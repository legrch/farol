package process

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
)

// Pure policy-correlation double. It does not produce native qualification.
type policyPrepared struct {
	*prepared
	matches bool
	checks  int
}

func (p *policyPrepared) MatchesPolicy(snapshot port.AccessSnapshot) bool {
	if !p.e.inCallback || snapshot.Participant == nil || snapshot.Approval == nil {
		panic("policy comparison outside coherent snapshot")
	}
	p.checks++
	return p.matches
}
func TestCurrentProfileMismatchRefusesBeforeReservationAndDisclosures(t *testing.T) {
	s, _, _, reservations, prepared := setup(t)
	policy := &policyPrepared{prepared: prepared}
	s.prepared = policy
	if _, err := s.Start(context.Background(), StartRequest{"operation"}); err == nil || reservations.calls != 0 || prepared.calls != 0 || policy.checks != 1 {
		t.Fatal("profile mismatch reached reservation/spawn", err)
	}
	// A separately admitted CPU fixture uses the same pure binding before native
	// dispatch and result disclosure. A changed profile cannot leak retained data.
	s, _, _, reservations, prepared = setup(t)
	policy = &policyPrepared{prepared: prepared, matches: true}
	s.prepared = policy
	out, err := s.Start(context.Background(), StartRequest{"operation"})
	if err != nil || reservations.calls != 1 || prepared.calls != 1 {
		t.Fatal("valid CPU profile correlation refused", err)
	}
	policy.matches = false
	if _, err := s.Read(context.Background(), ReadRequest{Handle: out.Handle}); err == nil {
		t.Fatal("changed profile disclosed output")
	}
}
