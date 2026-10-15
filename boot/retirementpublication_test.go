package boot

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/transport/desktop"
)

// Real ingress owner with controlled persistence and Chat/Task fixtures. No
// native root, socket, child, browser or provider operation is launched.
func TestRetirementPublicationCannotReopenThroughFreshWithdrawal(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	if err := p.ingress.freezeForRetirement(context.Background()); err != nil {
		t.Fatal(err)
	}
	before, revision := p.store.updates, p.store.revision
	d, err := p.ingress.Deactivate(context.Background(), "pump-stop-withdrawal")
	if err != nil {
		t.Fatal("negative pump withdrawal refused", err)
	}
	result, err := p.ingress.Publish(context.Background(), "late-settings-publication", wire.ComputerAuthorityPublishRequest{
		Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: "2", Approval: p.approval, TaskCurrentSettings: p.sourceFacts(t, &p.metadata, nil),
	})
	if result != nil || err == nil || p.store.updates != before || p.store.revision != revision || p.ingress.guard.active {
		t.Fatal("retired owner accepted publication or changed persisted approval", result, err)
	}
	if _, err := p.read(); err == nil {
		t.Fatal("retired Task source disclosed")
	}
}

type retirementPublicationStore struct {
	*taskPublicationStore
	entered chan struct{}
	release chan struct{}
}

func (s *retirementPublicationStore) UpdateApproval(ctx context.Context, revision uint64, approval authority.Approval) error {
	close(s.entered)
	<-s.release
	return s.taskPublicationStore.UpdateApproval(ctx, revision, approval)
}

func TestRetirementPublicationJoinsOriginalInflightBeforeFreezing(t *testing.T) {
	p := newTaskPublicationFixture(t)
	d, err := p.ingress.Deactivate(context.Background(), "original-withdrawal")
	if err != nil {
		t.Fatal(err)
	}
	store := &retirementPublicationStore{taskPublicationStore: p.store, entered: make(chan struct{}), release: make(chan struct{})}
	p.ingress.store = store
	published := make(chan error, 1)
	go func() {
		_, err := p.ingress.Publish(context.Background(), "original-publication", wire.ComputerAuthorityPublishRequest{
			Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: "1", Approval: p.approval,
		})
		published <- err
	}()
	<-store.entered
	retired := make(chan error, 1)
	go func() { retired <- p.ingress.freezeForRetirement(context.Background()) }()
	select {
	case err := <-retired:
		close(store.release)
		<-published
		t.Fatal("retirement returned before original publication IO settled", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(store.release)
	if err := <-published; err != nil {
		t.Fatal(err)
	}
	if err := <-retired; err != nil {
		t.Fatal(err)
	}
	if p.store.updates != 1 || p.ingress.guard.active {
		t.Fatal("original effect or negative closure lost")
	}
	latest, err := p.ingress.Deactivate(context.Background(), "late-negative")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.ingress.Publish(context.Background(), "late-publication", wire.ComputerAuthorityPublishRequest{
		Fence: latest.Fence, ExpectedStoreRevision: latest.StoreRevision, SettingsRevision: "2", Approval: p.approval,
	}); err == nil || p.store.updates != 1 {
		t.Fatal("publication reopened after drain", err)
	}
}

func TestRetirementPublicationNeverCleansUnknownOrCancelledOwner(t *testing.T) {
	for _, fault := range []string{"unknown", "cancelled"} {
		t.Run(fault, func(t *testing.T) {
			p := newTaskPublicationFixture(t)
			p.publish(t, &p.metadata)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if fault == "unknown" {
				p.ingress.poison()
			} else {
				cancel()
			}
			if p.ingress.freezeForRetirement(ctx) == nil {
				t.Fatal("uncertain retirement accepted")
			}
			if !p.ingress.retiring || p.ingress.guard.active {
				t.Fatal("failure reopened owner")
			}
		})
	}
}

func TestRetirementPublicationPrepareClosesBeforeLaterSnapshotFailure(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	runtime := &NativeRuntime{
		ingress:    p.ingress,
		retirement: &nativeRetirement{},
		settingsDelivery: &SettingsDeliveryIngress{
			initialAttempted: true,
			initialErr:       errors.New("controlled unsettled Settings snapshot"),
		},
	}
	body, err := json.Marshal(wire.CoreRetirementPrepare{HandoffId: "original-handoff"})
	if err != nil {
		t.Fatal(err)
	}
	prepare := runtime.retirementMethods()["core.retirement.prepare"].Handle
	outcome, err := prepare(context.Background(), desktop.Request{OperationID: "original-prepare", Body: body})
	if err != nil || outcome == nil || outcome.Status == "ok" || !p.ingress.retiring || p.ingress.guard.active {
		t.Fatal("failed prepare did not permanently close publication", outcome, err)
	}
	if !runtime.settingsDelivery.frozen || !runtime.retirement.attempted {
		t.Fatal("original snapshot failure was not retained")
	}
	d, err := p.ingress.Deactivate(context.Background(), "pump-stop-after-failed-prepare")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.ingress.Publish(context.Background(), "publication-after-failed-prepare", wire.ComputerAuthorityPublishRequest{
		Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: "2", Approval: p.approval,
	}); err == nil {
		t.Fatal("failed prepare reopened publication")
	}
	outcome, err = prepare(context.Background(), desktop.Request{OperationID: "later-prepare", Body: body})
	if err != nil || outcome == nil || outcome.Status != "refused" {
		t.Fatal("failed original prepare became retryable", outcome, err)
	}
}
