package connector_test

import (
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func catalogueVerificationActive(t *testing.T) verificationFixture {
	t.Helper()
	f := newVerificationFixture(t)
	f.launch.Approval.Workspaces, f.launch.Approval.Capabilities = nil, nil
	f.launch.Approval.Commands = authority.NoCommands
	f.launch.Admission.Workspaces, f.launch.Admission.Capabilities = nil, nil
	f.launch.Admission.Commands = authority.NoCommands
	f.launch.Participant.MutationOwnership = authority.NoOwnership
	f.journal.approval = f.launch.Approval.Clone()
	var err error
	f.owner, err = connector.New(f.gate, f.io, f.guard, f.clock, f.launch)
	if err != nil {
		t.Fatal(err)
	}
	f.root.owner = f.owner
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func catalogueObservation(f verificationFixture) port.ConnectorVerification {
	v := f.observation()
	v.Catalogue, v.WorkspaceID, v.EntryCount = true, "", 0
	return v
}

func TestEmptyCatalogueVerificationHasDistinctProofAndOneAttempt(t *testing.T) {
	f := catalogueVerificationActive(t)
	v := catalogueObservation(f)
	verificationAbsent(t, f.owner)
	if err := f.owner.BeginVerification(ctx, v.ChallengeDigest, "invented", v.CallID); err == nil {
		t.Fatal("empty grant admitted workspace verification")
	}
	if err := f.owner.BeginCatalogueVerification(ctx, v.ChallengeDigest, v.CallID); err != nil {
		t.Fatal(err)
	}
	verificationRefused(t, f.owner, ctx) // Reserved is not proof of completion.
	if err := f.owner.BeginCatalogueVerification(ctx, v.ChallengeDigest, "another-call"); err == nil {
		t.Fatal("pending catalogue replayed")
	}
	if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
		t.Fatal(err)
	}
	got, err := f.owner.CurrentVerification(ctx)
	if err != nil || got == nil || *got != v {
		t.Fatalf("catalogue proof: %+v %v", got, err)
	}
	if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
		t.Fatal(err)
	}
	if err := f.owner.BeginVerification(ctx, v.ChallengeDigest, "invented", "later"); err == nil {
		t.Fatal("completed catalogue enabled List")
	}
	f.clock.advance(time.Hour)
	verificationRefused(t, f.owner, ctx)
}

func TestCatalogueVerificationRejectsCrossedAndNonemptyProof(t *testing.T) {
	for name, change := range map[string]func(*port.ConnectorVerification){
		"workspace proof": func(v *port.ConnectorVerification) { v.Catalogue = false },
		"workspace id":    func(v *port.ConnectorVerification) { v.WorkspaceID = "work" },
		"count":           func(v *port.ConnectorVerification) { v.EntryCount = 1 },
		"truncated":       func(v *port.ConnectorVerification) { v.Truncated = true },
		"call":            func(v *port.ConnectorVerification) { v.CallID = "other" },
		"challenge":       func(v *port.ConnectorVerification) { v.ChallengeDigest[0]++ },
		"host":            func(v *port.ConnectorVerification) { v.Host.RuntimeID = "other" },
		"binding":         func(v *port.ConnectorVerification) { v.Binding.TurnID = "other" },
	} {
		t.Run(name, func(t *testing.T) {
			f := catalogueVerificationActive(t)
			v := catalogueObservation(f)
			if err := f.owner.BeginCatalogueVerification(ctx, v.ChallengeDigest, v.CallID); err != nil {
				t.Fatal(err)
			}
			change(&v)
			if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, v); err == nil {
				t.Fatal("invalid catalogue proof recorded")
			}
			verificationRefused(t, f.owner, ctx)
		})
	}
	f := verificationActive(t)
	v := f.observation()
	if err := f.owner.BeginCatalogueVerification(ctx, v.ChallengeDigest, v.CallID); err == nil {
		t.Fatal("nonempty grant bypassed workspace verification")
	}
	verificationBegin(t, f)
	if err := f.owner.BeginCatalogueVerification(ctx, v.ChallengeDigest, "fallback"); err == nil {
		t.Fatal("uncertain workspace attempt fell back to catalogue")
	}
}

func TestCatalogueVerificationRevocationWinsRecordingAndObservation(t *testing.T) {
	for _, complete := range []bool{false, true} {
		f := catalogueVerificationActive(t)
		v := catalogueObservation(f)
		if err := f.owner.BeginCatalogueVerification(ctx, v.ChallengeDigest, v.CallID); err != nil {
			t.Fatal(err)
		}
		if complete {
			if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
				t.Fatal(err)
			}
		}
		f.journal.change(func(j *journal) { j.revoked = true })
		if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err == nil {
			t.Fatal("revoked catalogue proof recorded")
		}
		verificationRefused(t, f.owner, ctx)
	}
}
