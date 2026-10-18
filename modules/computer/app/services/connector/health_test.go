package connector_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/domain"
)

// These owner-policy fixtures use detached values and injected guards/journals.
// They establish no HTTP, native-host, filesystem or attachment acceptance.
func healthQuery(now uint64) connector.ObserveHealthQuery {
	return connector.ObserveHealthQuery{ExpectedInstanceID: "instance-health", Snapshot: &domain.ConnectionHealthSnapshot{
		SnapshotAtMillis: now, RuntimeInstanceID: "instance-health", RuntimeStartedAtMillis: now - 200_000,
		RuntimeLifecycle: "running", Live: true, Ready: true,
		ControlPlane: &domain.ControlPlaneHealth{
			Status: "ok", State: "idle", ObservedAtMillis: healthMillis(now - 100_000),
			Details: &domain.ControlPlaneHealthDetails{
				LastAttemptMillis: healthMillis(now - 1000), LastSuccessMillis: healthMillis(now - 1000),
				ConfiguredWaitSeconds: 30, EffectiveWaitSeconds: 30, DeadlineSeconds: 60,
			},
		},
		ResponseDelivery: &domain.ResponseDeliveryHealth{
			Status: "ok", State: "accepted", ObservedAtMillis: healthMillis(now - 100_000),
			Details: &domain.ResponseDeliveryHealthDetails{
				Attempts: 1, Accepted: 1, LastAcceptedMillis: healthMillis(now - 120_000), Disposition: "accepted",
			},
		},
	}}
}
func healthMillis(value uint64) *uint64 { return &value }

func TestHealthUsesOriginalCurrentOwnerAndReturnsDetachedFacts(t *testing.T) {
	f := newFixture(t)
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	binding, err := f.owner.Reconnect(ctx)
	if err != nil {
		t.Fatal(err)
	}
	now := uint64(f.clock.Now().UnixMilli())
	query := healthQuery(now)
	before, err := json.Marshal(query)
	if err != nil {
		t.Fatal(err)
	}
	want := &connector.ObserveHealthResult{
		State: "recent_transport", Reason: "recent_poll_success", LocalReady: true,
		ObservedAtMillis: healthMillis(now), ValidUntilMillis: healthMillis(now + 45_000),
		LastPollSuccessMillis: healthMillis(now - 1000), LastResponseAcceptedMillis: healthMillis(now - 120_000),
	}
	first, err := f.owner.ObserveHealth(ctx, query)
	if err != nil || !reflect.DeepEqual(first, want) {
		t.Fatalf("observation = %+v, err = %v; want %+v", first, err, want)
	}
	second, err := f.owner.ObserveHealth(ctx, query)
	if err != nil || !reflect.DeepEqual(second, want) {
		t.Fatalf("second observation = %+v, err = %v", second, err)
	}
	for _, value := range []*uint64{first.ObservedAtMillis, first.ValidUntilMillis, first.LastPollSuccessMillis, first.LastResponseAcceptedMillis} {
		*value = 1
	}
	after, err := json.Marshal(query)
	if err != nil || string(after) != string(before) || !reflect.DeepEqual(second, want) {
		t.Fatal("result borrowed input or another observation")
	}
	*query.Snapshot.ControlPlane.Details.LastSuccessMillis = 2
	*query.Snapshot.ResponseDelivery.Details.LastAcceptedMillis = 3
	query.Snapshot.SnapshotAtMillis = 4
	if !reflect.DeepEqual(second, want) {
		t.Fatal("input mutation changed a returned result")
	}
	afterBinding, err := f.owner.Reconnect(ctx)
	if err != nil || *afterBinding != *binding || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
		t.Fatal("health read changed owner admission or journal", err)
	}
}

func TestHealthMissingAndHistoricalEvidenceCannotBecomeAttachment(t *testing.T) {
	f := newFixture(t)
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	now := uint64(f.clock.Now().UnixMilli())
	query := healthQuery(now)
	query.Snapshot = nil
	got, err := f.owner.ObserveHealth(ctx, query)
	want := &connector.ObserveHealthResult{State: "unobserved", Reason: "missing_snapshot"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("missing snapshot = %+v, %v", got, err)
	}
	query = healthQuery(now)
	query.Snapshot.ControlPlane.Details.LastSuccessMillis = nil
	got, err = f.owner.ObserveHealth(ctx, query)
	if err != nil || got.State != "unobserved" || got.Reason != "no_poll_success" || got.LastPollSuccessMillis != nil || got.LastResponseAcceptedMillis == nil || *got.LastResponseAcceptedMillis != now-120_000 {
		t.Fatalf("historical upload became current transport = %+v, %v", got, err)
	}
	query.Snapshot.ControlPlane = nil
	got, err = f.owner.ObserveHealth(ctx, query)
	if err != nil || got.State != "unobserved" || got.Reason != "polling_missing" || !got.LocalReady {
		t.Fatalf("local readiness became transport = %+v, %v", got, err)
	}
}

func TestHealthCannotAdmitPendingPublishingOrReviveLostOwner(t *testing.T) {
	f := newFixture(t)
	query := healthQuery(uint64(f.clock.Now().UnixMilli()))
	if got, err := f.owner.ObserveHealth(ctx, query); got != nil || err == nil {
		t.Fatal("pending owner disclosed health", got, err)
	}
	publishingChecked := false
	f.journal.publishHook = func() {
		got, err := f.owner.ObserveHealth(ctx, query)
		if got != nil || err == nil {
			t.Fatal("publishing owner disclosed health", got, err)
		}
		publishingChecked = true
	}
	if err := f.owner.Publish(ctx); err != nil || !publishingChecked {
		t.Fatal("original publication failed", err)
	}
	f.guard.change(func(g *guard) { g.current = false })
	if got, err := f.owner.ObserveHealth(ctx, query); got != nil || err == nil {
		t.Fatal("lost owner disclosed health", got, err)
	}
	f.guard.change(func(g *guard) { g.current = true })
	if got, err := f.owner.ObserveHealth(ctx, query); got != nil || err == nil {
		t.Fatal("health revived a lost owner", got, err)
	}
	if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
		t.Fatal("observation published or withdrew authority")
	}
}

func TestHealthWithdrawnOwnerRemainsWithdrawn(t *testing.T) {
	f := newFixture(t)
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.owner.Withdraw(ctx); err != nil {
		t.Fatal(err)
	}
	if got, err := f.owner.ObserveHealth(ctx, healthQuery(uint64(f.clock.Now().UnixMilli()))); got != nil || err == nil {
		t.Fatal("withdrawn owner disclosed health", got, err)
	}
	if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 1 {
		t.Fatal("read repeated a journal effect")
	}
}

func TestHealthRejectsInvalidContextAndInjectedClock(t *testing.T) {
	for _, mode := range []string{"nil context", "cancelled", "cancelled under guard", "zero clock", "negative clock", "unsafe clock"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			if err := f.owner.Publish(ctx); err != nil {
				t.Fatal(err)
			}
			query := healthQuery(uint64(f.clock.Now().UnixMilli()))
			callCtx := ctx
			switch mode {
			case "nil context":
				callCtx = nil
			case "cancelled", "cancelled under guard":
				cancelled, cancel := context.WithCancel(ctx)
				defer cancel()
				callCtx = cancelled
				if mode == "cancelled" {
					cancel()
				} else {
					f.guard.change(func(g *guard) { g.check = cancel })
				}
			case "zero clock":
				f.clock.ms.Store(0)
			case "negative clock":
				f.clock.ms.Store(-1)
			case "unsafe clock":
				f.clock.ms.Store(1 << 53)
			}
			if got, err := f.owner.ObserveHealth(callCtx, query); got != nil || err == nil {
				t.Fatal("invalid clock/context disclosed health", got, err)
			}
			if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
				t.Fatal("invalid read wrote journal")
			}
		})
	}
	var absent *connector.Service
	if got, err := absent.ObserveHealth(ctx, connector.ObserveHealthQuery{}); got != nil || err == nil {
		t.Fatal("absent owner admitted", got, err)
	}
	if got, err := new(connector.Service).ObserveHealth(ctx, connector.ObserveHealthQuery{}); got != nil || err == nil {
		t.Fatal("missing clock admitted", got, err)
	}
}
