package boot

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
)

// Real Root/execution/connector/Settings policy with deterministic Store/native
// doubles. The separate native test must qualify durable Store semantics.
type renewalStoreFixture struct {
	*settingsStoreFixture
	updates       int
	commitFailure error
	beforeUpdate  func() error
	afterUpdate   func()
}

func (s *renewalStoreFixture) UpdateApproval(ctx context.Context, revision uint64, a authority.Approval) error {
	s.updates++
	if s.beforeUpdate != nil {
		if err := s.beforeUpdate(); err != nil {
			return err
		}
	}
	if ctx.Err() != nil || revision != s.revision || !authority.SameApprovalPolicy(s.approval, a) {
		return errors.New("renewal CAS refused")
	}
	s.approval = a.Clone()
	s.PutApproval(a)
	s.revision++
	if s.afterUpdate != nil {
		s.afterUpdate()
	}
	return s.commitFailure
}

func renewalFixture(t *testing.T, renewable bool) (*computerConnector, *renewalStoreFixture, *connectorEndpointFixture, *wire.ComputerConnectorOpened) {
	t.Helper()
	s, store, endpoint, in := unopenedRenewalFixture(t, renewable)
	out, err := s.Open(context.Background(), "open", in)
	if err != nil {
		t.Fatal(err)
	}
	return s, store, endpoint, out
}

func unopenedRenewalFixture(t *testing.T, renewable bool) (*computerConnector, *renewalStoreFixture, *connectorEndpointFixture, wire.ComputerConnectorOpen) {
	t.Helper()
	s, j, _, endpoint, in := newConnectorFixture(t)
	a := j.approval.Clone()
	a.Capabilities = []authority.Capability{authority.List, authority.Read}
	a.ExpiresAt = j.clock.Now().Add(authority.TaskGrantLifetime)
	j.approval = a.Clone()
	j.PutApproval(a)
	s.root.publication.approval, s.root.publication.renewable = a.Clone(), renewable
	store := &renewalStoreFixture{settingsStoreFixture: j.settingsStoreFixture}
	s.root.store = store
	t.Cleanup(func() { _ = s.Shutdown() })
	return s, store, endpoint, in
}

func TestComputerRenewalFreshOpenAfterIdleWithoutSettingsRead(t *testing.T) {
	for _, closed := range []bool{false, true} {
		for _, elapsed := range []time.Duration{12*time.Hour + time.Millisecond, 72 * time.Hour} {
			for _, mode := range []string{"current", "bounded", "withdrawn", "unknown", "policy-changed"} {
				t.Run(time.Duration(elapsed).String()+"/"+map[bool]string{false: "first", true: "after-close"}[closed]+"/"+mode, func(t *testing.T) {
					s, store, _, in := unopenedRenewalFixture(t, mode != "bounded")
					original := s.root.publication.receipt
					journal := s.journal.(*connectorJournalFixture)
					if closed {
						opened, err := s.Open(context.Background(), "first-open", in)
						if err != nil {
							t.Fatal(err)
						}
						if _, err := s.Close(context.Background(), "first-close", wire.ComputerConnectorClose{Binding: opened.Endpoint.Binding}); err != nil {
							t.Fatal(err)
						}
					}
					publications := journal.publications
					store.clock.now = store.clock.Now().Add(elapsed)
					switch mode {
					case "withdrawn":
						_, _ = s.root.guard.deactivate()
					case "unknown":
						s.root.unknown = true
					case "policy-changed":
						store.approval.Workspaces[0].RootIdentity.Inode = "changed"
					}
					in.RuntimeId, in.ConnectorGeneration = "new-runtime", "2"
					opened, err := s.Open(context.Background(), "new-open", in)
					if mode == "current" {
						if err != nil || opened == nil || store.updates != 1 || journal.publications != publications+1 ||
							s.root.publication.receipt != original || s.root.publication.refreshCount != 1 {
							t.Fatal("new Open after idle failed/republished owner", err)
						}
					} else if err == nil || opened != nil || store.updates != 0 || journal.publications != publications {
						t.Fatal("invalid consent opened/renewed", mode, err)
					}
				})
			}
		}
	}
}

func renewalList(t *testing.T, methods map[string]desktop.Method, e wire.ComputerConnectorExecution) *desktop.Outcome {
	t.Helper()
	return computerInvoke(t, methods["computer.workspace.list"], wire.ComputerListRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "list", WorkspaceId: "work", RelativePath: "."})
}

func TestComputerRenewalNewRequestsAcrossTwelveTwentyFourSeventyTwoHours(t *testing.T) {
	s, store, endpoint, out := renewalFixture(t, true)
	start := store.clock.Now()
	original := s.root.publication.approval.Clone()
	receipt := s.root.publication.receipt
	ceiling, err := s.current.owner.ExecutionCeiling(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, hours := range []int{0, 12, 24, 72} {
		store.clock.now = start.Add(time.Duration(hours) * time.Hour)
		if got := renewalList(t, endpoint.methods, out.Execution); got.Status != "ok" {
			t.Fatalf("%dh: %+v", hours, got)
		}
		if s.current.opened.Endpoint.Binding != out.Endpoint.Binding || s.current.opened.Execution != out.Execution ||
			s.root.publication.receipt != receipt || !reflect.DeepEqual(s.root.publication.approval, original) {
			t.Fatal("renewal replaced host, participant or original publication")
		}
		after, err := s.current.owner.ExecutionCeiling(context.Background())
		if err != nil || !reflect.DeepEqual(ceiling, after) {
			t.Fatal("original seal changed", err)
		}
		if !store.approval.ExpiresAt.Equal(store.clock.Now().Add(authority.TaskGrantLifetime)) {
			t.Fatal("unbounded horizon")
		}
	}
	if store.updates != 3 || s.root.publication.refreshCount != 3 {
		t.Fatal("wrong known renewal count", store.updates)
	}
	if j := s.journal.(*connectorJournalFixture); j.publications != 1 || j.withdrawals != 0 {
		t.Fatal("renewal re-created connector")
	}
}

func TestComputerRenewalCoalescesConcurrentNewAdmissions(t *testing.T) {
	s, store, _, _ := renewalFixture(t, true)
	store.clock.now = store.approval.ExpiresAt.Add(24 * time.Hour)
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.current.route.admit(context.Background(), authority.List)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if store.updates != 1 || s.root.publication.refreshCount != 1 {
		t.Fatal("duplicate renewal", store.updates)
	}
}

func TestComputerRenewalKeepsExistingExecutionDeadline(t *testing.T) {
	s, store, _, _ := renewalFixture(t, true)
	old, err := s.current.route.admit(context.Background(), authority.List)
	if err != nil {
		t.Fatal(err)
	}
	deadline := old.Deadline()
	store.clock.now = store.approval.ExpiresAt
	if _, err := s.current.route.admit(context.Background(), authority.List); err != nil {
		t.Fatal(err)
	}
	if !old.Deadline().Equal(deadline) {
		t.Fatal("old deadline extended")
	}
	if err := old.WithSnapshot(context.Background(), old.Binding().ParticipantID, func(port.AccessSnapshot) error { t.Fatal("old lease disclosed"); return nil }); err == nil {
		t.Fatal("expired old lease renewed")
	}
}

func TestComputerRenewalSettingsFixedLeaseAllowsOnlyAcknowledgedTimeChange(t *testing.T) {
	for _, change := range []string{"renew", "renew-and-revision", "renew-expired-lease", "withdraw"} {
		t.Run(change, func(t *testing.T) {
			s, store, _, _ := renewalFixture(t, true)
			clock := store.clock
			clock.now = store.approval.ExpiresAt.Add(-authority.ApprovalRefreshLeadTime - time.Millisecond)
			s.root.native.(*settingsNativeFixture).after = func() {
				clock.now = clock.now.Add(2 * time.Millisecond)
				if change == "withdraw" {
					_, _ = s.root.guard.deactivate()
					return
				}
				if err := s.root.refreshCurrentApproval(context.Background()); err != nil {
					t.Fatal(err)
				}
				if change == "renew-and-revision" {
					store.revision++
				}
				if change == "renew-expired-lease" {
					clock.now = clock.now.Add(16 * time.Second)
				}
			}
			out, err := s.root.settingsList(context.Background(), wire.ComputerSettingsListRequest{Publication: s.root.publication.receipt, WorkspaceId: "work", RelativePath: "."})
			if change == "renew" {
				if err != nil || out == nil || store.updates != 1 {
					t.Fatalf("known expiry-only commit refused: %+v %v", out, err)
				}
			} else if err == nil || out != nil {
				t.Fatal("real change or old deadline hidden")
			}
		})
	}
}

func TestComputerRenewalSettingsSnapshotAcrossKnownCommit(t *testing.T) {
	s, store, _, _ := renewalFixture(t, true)
	clock := store.clock
	clock.now = store.approval.ExpiresAt.Add(-authority.ApprovalRefreshLeadTime - time.Millisecond)
	native := &settingsSnapshotNative{}
	s.root.native = native
	native.after = func() {
		clock.now = clock.now.Add(2 * time.Millisecond)
		if err := s.root.refreshCurrentApproval(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	out, err := s.root.settingsSnapshot(context.Background(), wire.ComputerSettingsSnapshotRequest{Publication: s.root.publication.receipt, WorkspaceId: "work", RelativePath: "note.md"})
	if err != nil || out == nil || out.Bytes != 10 || store.updates != 1 || native.calls != 1 {
		t.Fatalf("snapshot across known commit: %+v %v", out, err)
	}
}

func TestComputerRenewalRefusesBoundedChangedRevokedAndUnknownConsent(t *testing.T) {
	for _, change := range []string{"bounded", "withdraw", "root", "excluded", "capability", "participant", "backend", "publication", "unknown", "unacknowledged-expiry"} {
		t.Run(change, func(t *testing.T) {
			s, store, endpoint, out := renewalFixture(t, change != "bounded")
			store.clock.now = store.approval.ExpiresAt
			switch change {
			case "withdraw":
				_, _ = s.root.guard.deactivate()
			case "root":
				store.approval.Workspaces[0].RootIdentity.Inode = "changed"
			case "excluded":
				store.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/disposable/private"}}
			case "capability":
				store.approval.Capabilities = []authority.Capability{authority.Read}
			case "participant":
				store.RevokeParticipant(out.Execution.ParticipantId)
			case "backend":
				s.root.peer.BackendGeneration = "changed"
			case "publication":
				s.root.publication.receipt.SettingsRevision = "other"
			case "unknown":
				s.root.unknown = true
			case "unacknowledged-expiry":
				store.approval.ExpiresAt = store.approval.ExpiresAt.Add(time.Hour)
			}
			if got := renewalList(t, endpoint.methods, out.Execution); got.Status == "ok" || store.updates != 0 {
				t.Fatal("invalid consent renewed", change, got, store.updates)
			}
		})
	}
}

func TestComputerRenewalUnknownCommitNeverRetry(t *testing.T) {
	for _, fault := range []string{"lost-ack", "readback-mismatch"} {
		t.Run(fault, func(t *testing.T) {
			s, store, _, _ := renewalFixture(t, true)
			store.clock.now = store.approval.ExpiresAt
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "lost-ack":
				store.commitFailure = &accessrepo.CommitFailure{Unknown: true}
			case "readback-mismatch":
				store.afterUpdate = func() { store.revision++ }
			}
			if err := s.root.refreshCurrentApproval(ctx); err == nil {
				t.Fatal("uncertain commit accepted")
			}
			if !s.root.unknown || s.root.publication.currentApproval != nil || s.root.publication.refreshCount != 0 {
				t.Fatal("uncertain view became known")
			}
			for range 2 {
				if err := s.root.refreshCurrentApproval(context.Background()); err == nil {
					t.Fatal("unknown retried")
				}
			}
			if store.updates != 1 {
				t.Fatal("duplicate Store commit", store.updates)
			}
		})
	}
}

func TestComputerRenewalKnownCommitSurvivesClosureWithoutNewAuthority(t *testing.T) {
	for _, fault := range []string{"withdraw", "host-close", "lifetime-cancel", "caller-cancel"} {
		t.Run(fault, func(t *testing.T) {
			s, store, _, _ := renewalFixture(t, true)
			store.clock.now = store.approval.ExpiresAt
			original := s.root.publication.receipt
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store.afterUpdate = func() {
				switch fault {
				case "withdraw":
					_, _ = s.root.guard.deactivate()
				case "host-close":
					s.current.guard.close()
				case "lifetime-cancel":
					s.cancel()
				case "caller-cancel":
					cancel()
				}
			}
			if err := s.root.refreshCurrentApproval(ctx); err == nil {
				t.Fatal("closed/cancelled operation authorized")
			}
			if s.root.unknown || s.root.publication.refreshCount != 1 || s.root.publication.currentApproval == nil ||
				s.root.publication.receipt != original || store.updates != 1 {
				t.Fatal("known Store acknowledgement lost")
			}
			if err := s.root.freezeForRetirement(context.Background()); err != nil {
				t.Fatal("known acknowledgement prevented clean retirement", err)
			}
			if _, err := s.current.route.admit(context.Background(), authority.List); err == nil || store.updates != 1 {
				t.Fatal("closed authority revived or effect repeated")
			}
		})
	}
}

func TestComputerRenewalKnownPreWriteRevocationDoesNotBecomeUnknown(t *testing.T) {
	s, store, _, _ := renewalFixture(t, true)
	store.clock.now = store.approval.ExpiresAt
	previous := store.approval.Clone()
	store.beforeUpdate = func() error {
		_, _ = s.root.guard.deactivate()
		return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
	if err := s.root.refreshCurrentApproval(context.Background()); err == nil || s.root.unknown ||
		s.root.publication.refreshCount != 0 || !reflect.DeepEqual(store.approval, previous) {
		t.Fatal("known revocation corrupted acknowledgement/uncertainty")
	}
	if _, err := s.current.route.admit(context.Background(), authority.List); err == nil || store.updates != 1 {
		t.Fatal("revocation renewed or repeated")
	}
	if err := s.root.freezeForRetirement(context.Background()); err != nil {
		t.Fatal("known pre-write refusal blocked retirement", err)
	}
}

func TestComputerRenewalBackwardClockKeepsTypedReadRefusal(t *testing.T) {
	s, store, endpoint, out := renewalFixture(t, true)
	store.clock.now = store.clock.Now().Add(-time.Minute)
	e := out.Execution
	body := wire.ComputerReadRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "backward-read", WorkspaceId: "work", RelativePath: "note.md"}
	got := computerInvoke(t, endpoint.methods["computer.workspace.read"], body)
	var refusal wire.ComputerReadRefusal
	if got.Status != "refused" || wire.Validate("ComputerReadRefusal", got.Data) != nil ||
		json.Unmarshal(got.Data, &refusal) != nil || refusal.Request == nil || *refusal.Request != body ||
		refusal.Source != "authority-store" || refusal.Retry != "never" || store.updates != 0 ||
		s.root.native.(*settingsNativeFixture).calls != 0 {
		t.Fatal("known planner refusal lost request or dispatched native IO", got)
	}
}

func TestComputerRenewalDoesNotChangeTypedReadRefusal(t *testing.T) {
	_, store, endpoint, out := renewalFixture(t, true)
	store.clock.now = store.approval.ExpiresAt
	store.commitFailure = &accessrepo.CommitFailure{Unknown: true}
	e := out.Execution
	body := wire.ComputerReadRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "read", WorkspaceId: "work", RelativePath: "note.md"}
	got := computerInvoke(t, endpoint.methods["computer.workspace.read"], body)
	var refusal wire.ComputerReadRefusal
	if got.Status != "refused" || json.Unmarshal(got.Data, &refusal) != nil || refusal.Request == nil || *refusal.Request != body || refusal.Retry != "never" {
		t.Fatal("original request/refusal lost", got)
	}
}

func TestComputerRenewalProactiveHeartbeatAndStop(t *testing.T) {
	s, store, _, _ := renewalFixture(t, true)
	store.clock.now = store.approval.ExpiresAt.Add(-4 * time.Minute)
	ticks := make(chan time.Time)
	known := make(chan struct{})
	store.after = func() {
		if store.updates == 1 && s.root.publication.refreshCount == 1 {
			close(known)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.pollRenewal(ctx, s.current.renewalScope, ticks) }()
	// Tick time is not consent and is intentionally old. Root samples the
	// independently current clock inside its guarded owner read.
	ticks <- time.UnixMilli(1)
	select {
	case <-known:
	case <-time.After(time.Second):
		t.Fatal("proactive renewal missing")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("renewal poll did not stop")
	}
	if store.updates != 1 || !store.approval.ExpiresAt.Equal(store.clock.Now().Add(authority.TaskGrantLifetime)) {
		t.Fatal("wrong proactive horizon")
	}
}

func TestComputerRenewalClosedConnectorDoesNotBlockSettings(t *testing.T) {
	s, store, _, out := renewalFixture(t, true)
	if _, err := s.Close(context.Background(), "close", wire.ComputerConnectorClose{Binding: out.Endpoint.Binding}); err != nil {
		t.Fatal(err)
	}
	if s.root.renewal != nil {
		t.Fatal("closed scope retained as current")
	}
	start := store.clock.Now()
	for _, hours := range []int{12, 24, 72} {
		store.clock.now = start.Add(time.Duration(hours) * time.Hour)
		if got, err := s.root.settingsList(context.Background(), wire.ComputerSettingsListRequest{Publication: s.root.publication.receipt, WorkspaceId: "work", RelativePath: "."}); err != nil || got == nil {
			t.Fatal("closed scope poisoned independent Settings", hours, err)
		}
		if s.root.renewal != nil || s.current != nil {
			t.Fatal("Settings reopened connector")
		}
	}
	if store.updates != 3 {
		t.Fatal("wrong owner-only renewal count", store.updates)
	}
}

func TestComputerRenewalSettingsWithoutConnectorKeepsConsentGuards(t *testing.T) {
	for _, mode := range []string{"current", "withdrawn", "bounded", "unknown", "policy-changed"} {
		t.Run(mode, func(t *testing.T) {
			root, fixture, native, request := settingsFixture(t)
			store := &renewalStoreFixture{settingsStoreFixture: fixture}
			root.store, root.publication.renewable = store, mode != "bounded"
			fixture.clock.now = fixture.approval.ExpiresAt.Add(72 * time.Hour)
			switch mode {
			case "withdrawn":
				_, _ = root.guard.deactivate()
			case "unknown":
				root.unknown = true
			case "policy-changed":
				fixture.approval.Workspaces[0].RootIdentity.Inode = "changed"
			}
			got, err := root.settingsList(context.Background(), request)
			if mode == "current" {
				if err != nil || got == nil || store.updates != 1 || native.calls != 1 || root.renewal != nil {
					t.Fatal("owner-only renewal failed", err)
				}
			} else if err == nil || got != nil || store.updates != 0 || native.calls != 0 {
				t.Fatal("invalid owner consent renewed/disclosed", mode, err)
			}
		})
	}
}
