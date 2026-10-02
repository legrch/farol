package update

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

// This runtime is a policy double. It supplies no GitHub, filesystem, helper,
// package, process, installed-app or active-work evidence.
type runtimeFixture struct {
	mu        sync.Mutex
	calls     []string
	reconcile func(context.Context) (*port.Restored, error)
	discover  func(context.Context) (*port.Discovery, error)
	download  func(context.Context) (*port.Archive, error)
	retain    func(port.Archive) error
	apply     func(context.Context, port.Archive) (*port.Handoff, error)
	restore   func(context.Context, port.Action) (*port.Handoff, error)
	cancel    func()
}

func (f *runtimeFixture) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}
func (f *runtimeFixture) trace() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}
func (f *runtimeFixture) count(call string) int {
	n := 0
	for _, c := range f.trace() {
		if c == call {
			n++
		}
	}
	return n
}
func (f *runtimeFixture) Reconcile(ctx context.Context) (*port.Restored, error) {
	f.record("reconcile")
	if f.reconcile != nil {
		return f.reconcile(ctx)
	}
	return &port.Restored{}, nil
}
func (f *runtimeFixture) Discover(ctx context.Context) (*port.Discovery, error) {
	f.record("discover")
	if f.discover != nil {
		return f.discover(ctx)
	}
	return &port.Discovery{Available: true}, nil
}
func (f *runtimeFixture) Download(ctx context.Context) (*port.Archive, error) {
	f.record("download")
	if f.download != nil {
		return f.download(ctx)
	}
	a := staged()
	return &a, nil
}
func (f *runtimeFixture) Retain(a port.Archive) error {
	f.record("retain")
	if f.retain != nil {
		return f.retain(a)
	}
	return nil
}
func (f *runtimeFixture) Apply(ctx context.Context, a port.Archive) (*port.Handoff, error) {
	f.record("apply")
	if f.apply != nil {
		return f.apply(ctx, a)
	}
	return &port.Handoff{Decision: port.Accepted}, nil
}
func (f *runtimeFixture) Restore(ctx context.Context, a port.Action) (*port.Handoff, error) {
	if a == port.Recover {
		f.record("recover")
	} else {
		f.record("rollback")
	}
	if f.restore != nil {
		return f.restore(ctx, a)
	}
	return &port.Handoff{Decision: port.Accepted}, nil
}
func (f *runtimeFixture) CancelPending() {
	f.record("cancel")
	if f.cancel != nil {
		f.cancel()
	}
}

type clockFixture struct{ now int64 }

func (f *clockFixture) NowMilliseconds() int64 { return f.now }
func staged() port.Archive {
	return port.Archive{Handle: "private-retained-archive", Version: "0.1.9-owner.beta.1", BuildID: strings.Repeat("b", 64), SHA256: strings.Repeat("a", 64)}
}
func fixture() (*Service, *runtimeFixture, *clockFixture) {
	r := &runtimeFixture{}
	c := &clockFixture{now: 1000}
	return New(r, c), r, c
}
func snapshot(t *testing.T, s *Service) View {
	t.Helper()
	r, err := s.Status(StatusRequest{})
	if err != nil || r == nil {
		t.Fatalf("status: %v", err)
	}
	return r.View
}
func initialize(t *testing.T, s *Service) {
	t.Helper()
	r, err := s.Initialize(context.Background(), InitializeRequest{})
	if err != nil || r == nil {
		t.Fatalf("initialize: %v", err)
	}
}
func check(t *testing.T, s *Service, manual bool) {
	t.Helper()
	r, err := s.Check(context.Background(), CheckRequest{Manual: manual})
	if err != nil || r == nil {
		t.Fatalf("check: %v", err)
	}
}
func wait(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(3 * time.Second):
		t.Fatal("fixture rendezvous timed out")
	}
}

func TestReadyRequiresDurableRetainAndLaterNeverApplies(t *testing.T) {
	s, r, _ := fixture()
	initialize(t, s)
	initialize(t, s)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	r.retain = func(a port.Archive) error { close(entered); <-release; return nil }
	go func() { s.Check(context.Background(), CheckRequest{}); close(done) }()
	wait(t, entered)
	if snapshot(t, s).Phase != "downloading" {
		t.Fatal("ready before durable retain")
	}
	s.Apply(context.Background(), ApplyRequest{})
	if r.count("apply") != 0 {
		t.Fatal("applied unretained bytes")
	}
	close(release)
	wait(t, done)
	s.Later(LaterRequest{})
	check(t, s, true)
	v := snapshot(t, s)
	if v.Phase != "ready" || !v.Deferred || v.Version != staged().Version {
		t.Fatalf("view %+v", v)
	}
	if !reflect.DeepEqual(r.trace(), []string{"reconcile", "discover", "download", "retain"}) {
		t.Fatalf("unexpected effects %v", r.trace())
	}
}

func TestHandoffNeverReplaysAfterAcceptedUnknownOrMalformedResult(t *testing.T) {
	for _, tc := range []struct {
		name  string
		h     *port.Handoff
		err   error
		phase string
	}{
		{"accepted", &port.Handoff{Decision: port.Accepted}, nil, "applying"},
		{"unknown", &port.Handoff{Decision: port.Unknown, Code: "UPDATE_HANDOFF_UNKNOWN"}, nil, "failed"},
		{"nil result", nil, nil, "failed"},
		{"invalid decision", &port.Handoff{Decision: 99}, nil, "failed"},
		{"unbound blocker", &port.Handoff{Decision: port.Blocked}, nil, "failed"},
		{"private blocker text", &port.Handoff{Decision: port.Blocked, Code: "private fixture text"}, nil, "failed"},
		{"error after dispatch", nil, &port.Failure{Code: "UPDATE_WORK_PENDING"}, "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r, _ := fixture()
			r.apply = func(context.Context, port.Archive) (*port.Handoff, error) { return tc.h, tc.err }
			initialize(t, s)
			check(t, s, false)
			for range 3 {
				s.Apply(context.Background(), ApplyRequest{})
				check(t, s, true)
				s.Restore(context.Background(), RestoreRequest{Action: Rollback})
			}
			v := snapshot(t, s)
			if v.Phase != tc.phase || (v.Phase == "failed" && !v.RecoveryRequired) {
				t.Fatalf("view %+v", v)
			}
			if r.count("apply") != 1 || r.count("download") != 1 || r.count("rollback") != 0 {
				t.Fatalf("replayed: %v", r.trace())
			}
		})
	}
}

func TestKnownAdmissionBlockRetainsArchiveAndNeedsExplicitIntention(t *testing.T) {
	s, r, _ := fixture()
	r.apply = func(context.Context, port.Archive) (*port.Handoff, error) {
		return &port.Handoff{Decision: port.Blocked, Code: "UPDATE_WORK_PENDING"}, nil
	}
	initialize(t, s)
	check(t, s, false)
	s.Apply(context.Background(), ApplyRequest{})
	if v := snapshot(t, s); v.Phase != "ready" || !v.Deferred || v.BlockedBy != "UPDATE_WORK_PENDING" {
		t.Fatalf("view %+v", v)
	}
	check(t, s, false)
	if r.count("apply") != 1 {
		t.Fatal("automatic retry")
	}
	check(t, s, true)
	if snapshot(t, s).BlockedBy != "" || r.count("download") != 1 {
		t.Fatal("manual observation redownloaded")
	}
	r.apply = nil
	s.Apply(context.Background(), ApplyRequest{})
	if r.count("apply") != 2 || snapshot(t, s).Phase != "applying" {
		t.Fatal("explicit intention not admitted")
	}
}

func TestRecoveryInitializationObservesAndDoesNotDispatch(t *testing.T) {
	for _, tc := range []struct {
		name      string
		recovered *port.Restored
		action    RestoreAction
		expected  string
	}{
		{"ready", &port.Restored{Archive: ptrArchive(staged())}, 0, "ready"},
		{"recover", &port.Restored{RecoveryVersion: "0.1.8-owner.beta.1"}, Recover, "recovery"},
		{"rollback", &port.Restored{RollbackVersion: "0.1.8-owner.beta.1"}, Rollback, "idle"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, r, _ := fixture()
			r.reconcile = func(context.Context) (*port.Restored, error) { return tc.recovered, nil }
			initialize(t, s)
			if snapshot(t, s).Phase != tc.expected {
				t.Fatal("wrong restored view")
			}
			if !reflect.DeepEqual(r.trace(), []string{"reconcile"}) {
				t.Fatalf("recovery dispatched: %v", r.trace())
			}
			if tc.action != 0 {
				s.Restore(context.Background(), RestoreRequest{Action: tc.action})
				s.Restore(context.Background(), RestoreRequest{Action: tc.action})
				if r.count(tc.name) != 1 {
					t.Fatalf("restore replayed: %v", r.trace())
				}
			} else {
				check(t, s, true)
				if r.count("download") != 0 {
					t.Fatal("ready redownloaded")
				}
			}
		})
	}
}
func ptrArchive(a port.Archive) *port.Archive { return &a }

func TestKnownOfflineCheckPreservesMeasuredRollback(t *testing.T) {
	s, r, _ := fixture()
	r.reconcile = func(context.Context) (*port.Restored, error) {
		return &port.Restored{RollbackVersion: "0.1.8-owner.beta.1"}, nil
	}
	r.discover = func(context.Context) (*port.Discovery, error) {
		return nil, &port.Failure{Code: "UPDATE_NETWORK_FAILURE"}
	}
	initialize(t, s)
	check(t, s, false)
	if v := snapshot(t, s); v.Phase != "failed" || v.RecoveryRequired || v.RollbackVersion == "" {
		t.Fatalf("view %+v", v)
	}
	r.restore = func(context.Context, port.Action) (*port.Handoff, error) {
		return &port.Handoff{Decision: port.Blocked, Code: "UPDATE_WORK_PENDING"}, nil
	}
	s.Restore(context.Background(), RestoreRequest{Action: Rollback})
	if v := snapshot(t, s); v.Code != "UPDATE_WORK_PENDING" || v.RollbackVersion == "" {
		t.Fatalf("view %+v", v)
	}
	r.restore = func(context.Context, port.Action) (*port.Handoff, error) {
		return &port.Handoff{Decision: port.Unknown}, nil
	}
	s.Restore(context.Background(), RestoreRequest{Action: Rollback})
	s.Restore(context.Background(), RestoreRequest{Action: Rollback})
	check(t, s, true)
	if v := snapshot(t, s); !v.RecoveryRequired || v.RollbackVersion != "" {
		t.Fatalf("view %+v", v)
	}
	if r.count("rollback") != 2 || r.count("discover") != 1 {
		t.Fatalf("replayed: %v", r.trace())
	}
}

func TestUncertainStagingRetentionAndRecoveryFenceFurtherWork(t *testing.T) {
	for _, stage := range []string{"download", "retain", "reconcile", "classified-reconcile"} {
		t.Run(stage, func(t *testing.T) {
			s, r, _ := fixture()
			err := errors.New("private fixture detail must not escape")
			switch stage {
			case "download":
				r.download = func(context.Context) (*port.Archive, error) { return nil, err }
			case "retain":
				r.retain = func(port.Archive) error { return err }
			case "classified-reconcile":
				r.reconcile = func(context.Context) (*port.Restored, error) {
					return nil, &port.Failure{Code: "UPDATE_RECOVERY_UNAVAILABLE"}
				}
			case "reconcile":
				r.reconcile = func(context.Context) (*port.Restored, error) { return nil, err }
			}
			initialize(t, s)
			check(t, s, false)
			before := r.trace()
			check(t, s, true)
			s.Apply(context.Background(), ApplyRequest{})
			v := snapshot(t, s)
			if !v.RecoveryRequired || v.Phase != "failed" || strings.Contains(v.Code, "private") {
				t.Fatalf("view %+v", v)
			}
			if !reflect.DeepEqual(before, r.trace()) {
				t.Fatalf("replayed: %v", r.trace())
			}
		})
	}
}

func TestSixHourClockAndSnapshotIsolation(t *testing.T) {
	s, r, c := fixture()
	r.discover = func(context.Context) (*port.Discovery, error) { return &port.Discovery{}, nil }
	check(t, s, true)
	if r.count("discover") != 0 {
		t.Fatal("checked before initialization")
	}
	initialize(t, s)
	check(t, s, false)
	v := snapshot(t, s)
	if v.CheckedAt == nil || *v.CheckedAt != 1000 {
		t.Fatalf("view %+v", v)
	}
	*v.CheckedAt = 0
	if *snapshot(t, s).CheckedAt != 1000 {
		t.Fatal("snapshot mutated state")
	}
	c.now += 6*60*60*1000 - 1
	check(t, s, false)
	if r.count("discover") != 1 {
		t.Fatal("early automatic check")
	}
	c.now++
	check(t, s, false)
	if r.count("discover") != 2 {
		t.Fatal("missed interval")
	}
	c.now = 1
	check(t, s, false)
	if r.count("discover") != 2 {
		t.Fatal("clock regression retried")
	}
	check(t, s, true)
	if r.count("discover") != 3 {
		t.Fatal("explicit check blocked by clock")
	}
}

func TestConcurrentChecksAndApplyCoalesce(t *testing.T) {
	s, r, _ := fixture()
	initialize(t, s)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	r.download = func(context.Context) (*port.Archive, error) { close(entered); <-release; a := staged(); return &a, nil }
	go func() { s.Check(context.Background(), CheckRequest{}); close(done) }()
	wait(t, entered)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			s.Check(context.Background(), CheckRequest{Manual: true})
			s.Apply(context.Background(), ApplyRequest{})
		})
	}
	wg.Wait()
	if r.count("download") != 1 || r.count("apply") != 0 {
		t.Fatalf("concurrent effects %v", r.trace())
	}
	close(release)
	wait(t, done)
	for range 20 {
		wg.Go(func() { s.Apply(context.Background(), ApplyRequest{}) })
	}
	wg.Wait()
	if r.count("apply") != 1 {
		t.Fatalf("apply replayed %v", r.trace())
	}
}

func TestCloseRetainsCompletedDownloadAndDrainsOnce(t *testing.T) {
	s, r, _ := fixture()
	initialize(t, s)
	entered, release, retaining, retained, done := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	r.download = func(context.Context) (*port.Archive, error) { close(entered); <-release; a := staged(); return &a, nil }
	r.retain = func(port.Archive) error { close(retaining); <-retained; return nil }
	go func() { s.Check(context.Background(), CheckRequest{}); close(done) }()
	wait(t, entered)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if response, err := s.Close(ctx, CloseRequest{}); response != nil || !errors.Is(err, context.Canceled) {
		t.Fatal("unconfirmed drain reported success")
	}
	closed := make(chan struct{})
	go func() { s.Close(context.Background(), CloseRequest{}); close(closed) }()
	select {
	case <-closed:
		t.Fatal("drained before download")
	default:
	}
	close(release)
	wait(t, retaining)
	select {
	case <-closed:
		t.Fatal("drained before retention")
	default:
	}
	close(retained)
	wait(t, done)
	wait(t, closed)
	check(t, s, true)
	s.Apply(context.Background(), ApplyRequest{})
	if r.count("retain") != 1 || r.count("cancel") != 1 || r.count("apply") != 0 || snapshot(t, s).Phase == "ready" {
		t.Fatalf("close effects %v", r.trace())
	}
}

func TestInvalidPortRepliesCannotExposeReadyOrPermitRetry(t *testing.T) {
	for _, stage := range []string{"reconcile", "download"} {
		t.Run(stage, func(t *testing.T) {
			s, r, _ := fixture()
			bad := staged()
			bad.BuildID = "unmeasured"
			if stage == "reconcile" {
				r.reconcile = func(context.Context) (*port.Restored, error) { return &port.Restored{Archive: &bad}, nil }
			} else {
				r.download = func(context.Context) (*port.Archive, error) { return &bad, nil }
			}
			initialize(t, s)
			check(t, s, false)
			check(t, s, true)
			if v := snapshot(t, s); v.Phase != "failed" || !v.RecoveryRequired {
				t.Fatalf("view %+v", v)
			}
			if r.count("retain") != 0 || r.count("download") > 1 {
				t.Fatalf("effects %v", r.trace())
			}
		})
	}
	s, r, _ := fixture()
	initialize(t, s)
	if response, err := s.Restore(context.Background(), RestoreRequest{Action: 99}); response != nil || !errors.Is(err, ErrInvalidAction) {
		t.Fatal("accepted invalid action")
	}
	if r.count("recover")+r.count("rollback") != 0 {
		t.Fatal("invalid action dispatched")
	}
}

func TestUnclassifiedFailureTextDoesNotEscape(t *testing.T) {
	s, r, _ := fixture()
	r.discover = func(context.Context) (*port.Discovery, error) {
		return nil, &port.Failure{Code: "private fixture text"}
	}
	initialize(t, s)
	check(t, s, false)
	if v := snapshot(t, s); v.Code != "UPDATE_CHECK_FAILED" || v.RecoveryRequired {
		t.Fatalf("view %+v", v)
	}
}

func TestObservedRollbackStillNeedsRuntimeAdmission(t *testing.T) {
	s, r, _ := fixture()
	r.reconcile = func(context.Context) (*port.Restored, error) {
		return &port.Restored{RollbackVersion: "0.1.8-owner.beta.1"}, nil
	}
	initialize(t, s)
	// This double supplies an explicit pre-dispatch admission refusal. It does
	// not supply physical helper or native lease evidence.
	r.restore = func(_ context.Context, action port.Action) (*port.Handoff, error) {
		if action != port.Rollback {
			t.Fatalf("wrong restoration action: %v", action)
		}
		return &port.Handoff{Decision: port.Blocked, Code: "UPDATE_WORK_PENDING"}, nil
	}
	s.Restore(context.Background(), RestoreRequest{Action: Rollback})
	if v := snapshot(t, s); v.Phase == "applying" || v.BlockedBy != "UPDATE_WORK_PENDING" || v.RollbackVersion == "" {
		t.Fatalf("observed rollback bypassed native refusal: %+v", v)
	}
	snapshot(t, s)
	s.Later(LaterRequest{})
	check(t, s, true)
	if r.count("rollback") != 1 || r.count("apply") != 0 {
		t.Fatalf("presentation/check retried refused restoration: %v", r.trace())
	}
}
