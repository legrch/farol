package access

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	journal "github.com/legrch/farol/modules/computer/domain/journal"
	"golang.org/x/sys/unix"
)

// Real protected Store publications and reopen, but effect ACKs here are
// synthetic: native Go connector, lifecycle and ProductSettings owners are NOT
// invoked. These tests cannot qualify installed continuity or different-boot
// recovery. The C4 linkage is the only consumption publication.
func linkedChildRequest(f stateFixture) journal.Request {
	r := transitionIntent
	r.OperationID = "66666666-6666-4666-8666-666666666666"
	r.RequestDigest = strings.Repeat("f", 64)
	r.ConsentDigest = strings.Repeat("c", 64)
	r.WorkspaceID = "work"
	r.Root = f.workspace
	r.ExpectedRevision = "2"
	r.ExpectedGeneration = "3"
	r.BootUUID = "22222222-2222-4222-8222-222222222222"
	r.HostLifetimeID = "host"
	return r
}

func completeLinkedStopFixture(t *testing.T, f stateFixture, child journal.Request) journal.StopRequest {
	t.Helper()
	// C4 admission now requires an actual current qualified Go approval,
	// independently of the historical ProductSettings ACK. This fixture
	// creates one before C7 original Stop custody is admitted.
	approve(t, f)
	r := stopStoreRequest(f, 1)
	r.CommandKind = "computer.confirm-workspace"
	r.ChildOperationID = child.OperationID
	r.ChildMode = "legacy-confirm"
	stable, err := stableChildIntentDigest(child, r.ChildMode)
	if err != nil {
		t.Fatal(err)
	}
	r.ChildIntentDigest = stable
	r.ConsentDigest = child.ConsentDigest
	ctx := context.Background()
	original, admitted, err := f.store.BeginStop(ctx, r)
	if err != nil || !admitted {
		t.Fatal("original admission before synthetic Stop", err)
	}
	update := func(next journal.StopEntry) {
		t.Helper()
		if err := f.store.AdvanceStop(ctx, r.OperationID, next); err != nil {
			t.Fatal("original phase", next.Phase, err)
		}
	}
	original.Phase = journal.StopEffectIntent
	update(original)
	original.Closure = &journal.StopClosure{
		EffectID: r.StopEffectID, BackendGeneration: r.BackendGeneration,
		RuntimeID:    r.RuntimeID,
		LifecycleID:  "77777777-7777-4777-8777-777777777777",
		StopRevision: "1", PreparationRevision: "0",
		ClosureOperationID: "88888888-8888-4888-8888-888888888888",
		ClosureDigest:      strings.Repeat("a", 64),
	}
	original.Phase = journal.StopAcknowledged
	update(original)
	original.SettingsIntent = &journal.StopSettingsPlan{
		EffectID: r.SettingsEffectID, ExpectedRevision: r.ExpectedRevision,
		ExpectedDigest: r.SettingsDigest, NextRevision: child.ExpectedRevision,
		NextDigest:          strings.Repeat("b", 64),
		ComputerGeneration:  r.ComputerGeneration,
		ConnectorGeneration: r.ConnectorGeneration,
		ConsentDigest:       r.ConsentDigest,
	}
	original.Phase = journal.StoppedSettingsIntent
	update(original)
	original.SettingsAck = &journal.StopSettingsReceipt{
		EffectID: r.SettingsEffectID, Revision: child.ExpectedRevision,
		DocumentDigest:      original.SettingsIntent.NextDigest,
		ComputerGeneration:  r.ComputerGeneration,
		ConnectorGeneration: r.ConnectorGeneration,
		ConsentDigest:       r.ConsentDigest,
	}
	original.Phase = journal.StoppedSettingsAcknowledged
	update(original)
	original.Phase = journal.StopCleanupIntent
	update(original)
	original.CleanupAck = &journal.StopCleanupReceipt{
		EffectID: r.CleanupEffectID, BackendGeneration: r.BackendGeneration,
		RuntimeID: r.RuntimeID, Digest: strings.Repeat("d", 64),
	}
	original.Phase = journal.StopCleanupAcknowledged
	update(original)
	original.Phase = journal.StopComplete
	update(original)
	return r
}

func TestOriginalCertificateConsumedByOneSchemaTwoC4Publication(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	child := linkedChildRequest(f)
	parent := completeLinkedStopFixture(t, f, child)
	before := f.store.stopLedgerDigest
	admitted, first, err := f.store.BeginLinkedTransition(ctx, child, parent.OperationID, "legacy-confirm")
	if err != nil || !first || admitted.Parent == nil ||
		admitted.Parent.ParentOperationID != parent.OperationID ||
		admitted.Parent.Mode != "legacy-confirm" ||
		admitted.Parent.ChildIntentDigest != parent.ChildIntentDigest ||
		admitted.Parent.FullRequestDigest != child.RequestDigest {
		t.Fatal("single C4 publication lost exact parent/certificate identity", err)
	}
	if f.store.stopLedgerDigest != before {
		t.Fatal("child admission wrote a competing parent-consumed flag")
	}
	raw, err := f.store.disk.readJournal()
	if err != nil || !bytes.Contains(raw, []byte(`"schema":2`)) {
		t.Fatal("linked C4 was not written with the strict schema-2 reader", err)
	}
	reopened := restored(t, f)
	prior, again, err := reopened.BeginLinkedTransition(ctx, child, parent.OperationID, "legacy-confirm")
	if err != nil || again || prior.Parent == nil || *prior.Parent != *admitted.Parent {
		t.Fatal("restart redispatched admitted child or lost parent linkage", err)
	}
	if reopened.stopLedgerDigest != before {
		t.Fatal("restart changed immutable parent receipt")
	}
	if _, err := reopened.Status(ctx); err == nil {
		t.Fatal("pending linked C4 child reactivated old approval")
	}
}

func TestOriginalChildStableScopeRejectsDifferentModeRootConsentAndUUID(t *testing.T) {
	f := fixtureState(t)
	child := linkedChildRequest(f)
	parent := completeLinkedStopFixture(t, f, child)
	cases := []struct {
		name   string
		mutate func(*journal.Request)
		mode   string
	}{
		{"wrong-mode", func(*journal.Request) {}, "enrolled-rebind"},
		{"wrong-child", func(r *journal.Request) { r.OperationID = "99999999-9999-4999-8999-999999999999" }, "legacy-confirm"},
		{"wrong-root", func(r *journal.Request) { r.Root = f.home }, "legacy-confirm"},
		{"wrong-workspace", func(r *journal.Request) { r.WorkspaceID = "different" }, "legacy-confirm"},
		{"wrong-consent", func(r *journal.Request) { r.ConsentDigest = strings.Repeat("e", 64) }, "legacy-confirm"},
		{"wrong-boot", func(r *journal.Request) { r.BootUUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, "legacy-confirm"},
		{"wrong-revision", func(r *journal.Request) { r.ExpectedRevision = "3" }, "legacy-confirm"},
		{"wrong-generation", func(r *journal.Request) { r.ExpectedGeneration = "4" }, "legacy-confirm"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			selected := child
			tc.mutate(&selected)
			if _, admitted, err := f.store.BeginLinkedTransition(context.Background(), selected, parent.OperationID, tc.mode); err == nil || admitted {
				t.Fatal("changed child admitted with historical original certificate")
			}
		})
	}
	if !f.store.stops.Valid() || f.store.journalPresent {
		t.Fatal("refused child corrupted retained original or created C4 WAL")
	}
}

func TestSingleC4FirstPublicationUnknownNeverPermitsNewChildOrStop(t *testing.T) {
	f := fixtureState(t)
	child := linkedChildRequest(f)
	parent := completeLinkedStopFixture(t, f, child)
	before := f.store.stopLedgerDigest
	ctx := context.Background()
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	_, first, err := f.store.BeginLinkedTransition(ctx, child, parent.OperationID, "legacy-confirm")
	if first || !OutcomeUnknown(err) {
		t.Fatal("unknown first C4 publication became admitted work", err)
	}
	if f.store.stopLedgerDigest != before {
		t.Fatal("failed C4 consumed parent in separate file")
	}
	if _, again, err := f.store.BeginLinkedTransition(ctx, child, parent.OperationID, "legacy-confirm"); err == nil || again {
		t.Fatal("poisoned owner retried uncertain C4")
	}
	reopened := restored(t, f)
	state, err := reopened.TransitionStatus(ctx)
	if err != nil || !state.Present || !state.Restricted {
		t.Fatal("reopen lost possibly published original C4 child", err)
	}
	if _, first, err := reopened.BeginStop(ctx, stopStoreRequest(f, 2)); err == nil || first {
		t.Fatal("new Stop admitted while original C4 child pending")
	}
	// Exact same-child observation is not another effect admission.
	prior, first, err := reopened.BeginLinkedTransition(ctx, child, parent.OperationID, "legacy-confirm")
	if err != nil || first || prior.Request.OperationID != child.OperationID {
		t.Fatal("reopen attempted a second C4 child publication", err)
	}
}

func TestLinkedChildCannotReuseCertificateForSecondOriginal(t *testing.T) {
	f := fixtureState(t)
	child := linkedChildRequest(f)
	parent := completeLinkedStopFixture(t, f, child)
	ctx := context.Background()
	if _, admitted, err := f.store.BeginLinkedTransition(ctx, child, parent.OperationID, "legacy-confirm"); err != nil || !admitted {
		t.Fatal("expected one original linked child", err)
	}
	other := child
	other.OperationID = "99999999-9999-4999-8999-999999999999"
	other.RequestDigest = strings.Repeat("1", 64)
	if _, admitted, err := f.store.BeginLinkedTransition(ctx, other, parent.OperationID, "legacy-confirm"); err == nil || admitted {
		t.Fatal("same certificate consumed by another child")
	}
	if _, admitted, err := f.store.BeginTransition(ctx, other); err == nil || admitted {
		t.Fatal("legacy unlinked C4 path bypassed linked consumption")
	}
}

func TestOriginalLinkedChildNeedsFreshCurrentGoApprovalAfterStoppedSettings(t *testing.T) {
	for _, kind := range []string{"approval-revoked", "approval-expired"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			child := linkedChildRequest(f)
			parent := completeLinkedStopFixture(t, f, child)
			ctx := context.Background()
			switch kind {
			case "approval-revoked":
				if err := f.store.RevokeApproval(ctx, f.store.current.Revision); err != nil {
					t.Fatal(err)
				}
			case "approval-expired":
				f.clock.ms.Add((2 * time.Hour).Milliseconds())
			}
			if _, admitted, err := f.store.BeginLinkedTransition(ctx, child, parent.OperationID, "legacy-confirm"); err == nil || admitted {
				t.Fatal("historical certificate overrode current owner policy")
			}
			if f.store.journalPresent || !f.store.stops.Valid() {
				t.Fatal("policy refusal published child or discarded original receipts")
			}
		})
	}
}
