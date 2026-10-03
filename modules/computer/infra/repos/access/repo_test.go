package access

import (
	"context"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestRevocationSerializesWithCoherentSnapshotAndValuesDoNotAlias(t *testing.T) {
	r := New()
	p := authority.Participant{ParticipantID: "participant", Grant: authority.Grant{ComputerID: "computer", Policy: authority.Policy{Capabilities: []authority.Capability{authority.Read}}}}
	a := authority.Approval{ComputerID: "computer", Capabilities: []authority.Capability{authority.Read}}
	r.PutParticipant(p)
	r.PutApproval(a)
	p.Grant.Capabilities[0] = authority.Shell
	a.Capabilities[0] = authority.Shell
	requested, revoked := make(chan struct{}), make(chan struct{})
	err := r.WithSnapshot(context.Background(), "participant", func(snapshot port.AccessSnapshot) error {
		if snapshot.Participant.Grant.Capabilities[0] != authority.Read || snapshot.Approval.Capabilities[0] != authority.Read {
			t.Fatal("input alias changed snapshot")
		}
		go func() { close(requested); r.RevokeParticipant("participant"); close(revoked) }()
		<-requested
		select {
		case <-revoked:
			t.Fatal("revocation crossed disclosure guard")
		case <-time.After(10 * time.Millisecond):
		}
		snapshot.Approval.Capabilities[0] = authority.Shell
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-revoked:
	case <-time.After(time.Second):
		t.Fatal("revocation never completed")
	}
	r.PutParticipant(p)
	if err := r.WithSnapshot(context.Background(), "participant", func(snapshot port.AccessSnapshot) error {
		if snapshot.Approval.Capabilities[0] != authority.Read {
			t.Fatal("output alias changed approval")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	r.RevokeApproval("computer")
	if err := r.WithSnapshot(context.Background(), "participant", func(snapshot port.AccessSnapshot) error {
		if snapshot.Approval != nil {
			t.Fatal("revoked approval still visible")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
