package execution

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

// These are symbolic policy fixtures. No real parser/admission, filesystem,
// digest, journal durability, lease, process or installed route is qualified.
type parserFixture struct {
	request port.HelperRequest
	err     error
	parse   func(context.Context, []byte)
}

func (p *parserFixture) Parse(ctx context.Context, data []byte) (port.HelperRequest, error) {
	if p.parse != nil {
		p.parse(ctx, data)
	}
	return p.request, p.err
}

type treeFixture struct {
	identity port.HelperIdentity
	build    port.HelperBuild
}

type runtimeFixture struct {
	request port.HelperRequest
	trees   map[port.HelperRecoveryEntry]treeFixture
	phase   string
	trace   []string
	match   bool
	reject  bool
	before  func(string) error
	after   func(string)
}

func requestFixture(action string) port.HelperRequest {
	location := "symbolic-install-location"
	return port.HelperRequest{Action: action, Source: port.HelperBuild{Version: "alpha-1", Digest: "source", BuildID: "source-id"}, Target: port.HelperBuild{Version: "alpha-2", Digest: "target", BuildID: "target-id"}, InstallLocation: &location, LeaseIdentity: &port.HelperIdentity{Device: "1", Inode: "9"}, Predecessor: &port.HelperPredecessor{Kind: "symbolic"}}
}
func newRuntime(request port.HelperRequest) *runtimeFixture {
	r := &runtimeFixture{request: request, trees: make(map[port.HelperRecoveryEntry]treeFixture), match: true}
	source := treeFixture{port.HelperIdentity{Device: "1", Inode: "101"}, request.Source}
	target := treeFixture{port.HelperIdentity{Device: "1", Inode: "202"}, request.Target}
	if request.Action == "rollback" {
		r.trees[port.App], r.trees[port.Previous], r.phase = target, source, "verified"
	} else {
		r.trees[port.App], r.trees[port.Staged] = source, target
	}
	return r
}
func (r *runtimeFixture) call(name string, fn func() error) error {
	r.trace = append(r.trace, name)
	if r.before != nil {
		if err := r.before(name); err != nil {
			return err
		}
	}
	err := fn()
	if r.after != nil {
		r.after(name)
	}
	return err
}
func (r *runtimeFixture) Entries(context.Context) (v port.HelperRecoveryEntries, err error) {
	err = r.call("entries", func() error {
		entries := []*port.HelperRecoveryEntrySnapshot{&v.App, &v.Staged, &v.Previous, &v.Failed}
		for i, out := range entries {
			if tree, ok := r.trees[port.HelperRecoveryEntry(i)]; ok {
				*out = port.HelperRecoveryEntrySnapshot{Present: true, Directory: true, OwnedByEffectiveUser: true, Identity: tree.identity}
			}
		}
		v.RejectedTarget.Present = r.reject
		return nil
	})
	return
}
func (r *runtimeFixture) ReadPhase(context.Context) (string, error) {
	err := r.call("read", func() error { return nil })
	return r.phase, err
}
func (r *runtimeFixture) VerifyTree(_ context.Context, entry port.HelperRecoveryEntry, build port.HelperBuild) error {
	return r.call(fmt.Sprintf("verify:%d:%s", entry, build.Version), func() error {
		if tree, ok := r.trees[entry]; !ok || tree.build != build {
			return &port.HelperRecoveryFailure{Code: "tree", Phase: "refused"}
		}
		return nil
	})
}
func (r *runtimeFixture) MatchesTree(_ context.Context, entry port.HelperRecoveryEntry, build port.HelperBuild) (bool, error) {
	err := r.call("matches", func() error { return nil })
	return r.match && r.trees[entry].build == build, err
}
func (r *runtimeFixture) Fence(context.Context) error {
	return r.call("fence", func() error { return nil })
}
func (r *runtimeFixture) Prepare(context.Context) error {
	return r.call("prepare", func() error {
		if r.phase != "" {
			return &port.HelperRecoveryFailure{Code: "operation_exists", Phase: "refused"}
		}
		r.phase = "prepared"
		return nil
	})
}
func (r *runtimeFixture) WritePhase(_ context.Context, phase string) error {
	return r.call("write:"+phase, func() error { r.phase = phase; return nil })
}
func (r *runtimeFixture) Rename(_ context.Context, from, to port.HelperRecoveryEntry, expected port.HelperIdentity) error {
	return r.call(fmt.Sprintf("rename:%d:%d", from, to), func() error {
		tree, ok := r.trees[from]
		_, collision := r.trees[to]
		if !ok || collision || tree.identity != expected {
			return &port.HelperRecoveryFailure{Code: "rename_identity", Phase: "refused"}
		}
		r.trees[to] = tree
		delete(r.trees, from)
		return nil
	})
}
func (r *runtimeFixture) Exchange(_ context.Context, left, right port.HelperRecoveryEntry, leftID, rightID port.HelperIdentity) error {
	return r.call(fmt.Sprintf("exchange:%d:%d", left, right), func() error {
		l, lok := r.trees[left]
		rightTree, rok := r.trees[right]
		if !lok || !rok || l.identity != leftID || rightTree.identity != rightID {
			return &port.HelperRecoveryFailure{Code: "exchange_identity", Phase: "refused"}
		}
		r.trees[left], r.trees[right] = rightTree, l
		return nil
	})
}
func (r *runtimeFixture) RejectTarget(_ context.Context, expected port.HelperIdentity) error {
	return r.call("reject", func() error {
		if r.reject || r.trees[port.Failed].identity != expected {
			return &port.HelperRecoveryFailure{Code: "target_uncertain", Phase: "refused"}
		}
		r.reject = true
		return nil
	})
}
func bindFixture(t *testing.T, action string) (*Service, *runtimeFixture) {
	t.Helper()
	request := requestFixture(action)
	runtime := newRuntime(request)
	s, err := Bind(context.Background(), []byte("symbolic input"), &parserFixture{request: request}, runtime)
	if err != nil {
		t.Fatal(err)
	}
	return s, runtime
}
func failureFixture(t *testing.T, err error, code, phase string, internal, uncertain bool) *Failure {
	t.Helper()
	f, ok := err.(*Failure)
	if !ok || f == nil || f.Code != code || f.Phase != phase || f.Internal != internal || f.Uncertain != uncertain || err.Error() != "helper_execution_failure" {
		t.Fatalf("failure %#v; want %s/%s internal=%v uncertain=%v", err, code, phase, internal, uncertain)
	}
	return f
}

func TestApplyMovesOnlyTheCapturedPairAndWritesVerified(t *testing.T) {
	s, r := bindFixture(t, "apply")
	result, err := s.Apply(context.Background(), ApplyCommand{})
	if err != nil || result == nil || result.Result != (Result{Phase: "verified"}) || r.phase != "verified" || r.reject || len(r.trees) != 2 || r.trees[port.App].build != r.request.Target || r.trees[port.Previous].build != r.request.Source {
		t.Fatalf("apply result=%#v err=%v state=%#v", result, err, r)
	}
	want := []string{"entries", "verify:0:alpha-1", "verify:1:alpha-2", "prepare", "exchange:0:1", "verify:1:alpha-1", "fence", "rename:1:2", "write:new_installed", "matches", "write:verified"}
	if !reflect.DeepEqual(r.trace, want) {
		t.Fatalf("order: %v", r.trace)
	}
}
func TestRejectedTargetRestoresSourceBeforeSettledResult(t *testing.T) {
	s, r := bindFixture(t, "apply")
	r.match = false
	result, err := s.Apply(context.Background(), ApplyCommand{})
	if err != nil || result == nil || result.Result != (Result{Phase: "rolled_back", Code: "target_verification"}) || !r.reject || r.phase != "rolled_back" || len(r.trees) != 2 || r.trees[port.App].build != r.request.Source || r.trees[port.Failed].build != r.request.Target {
		t.Fatalf("settlement=%#v err=%v state=%#v", result, err, r)
	}
	want := []string{"read", "entries", "verify:2:alpha-1", "write:rollback_started", "fence", "exchange:0:2", "fence", "rename:2:3", "reject", "verify:0:alpha-1", "write:rolled_back"}
	if !reflect.DeepEqual(r.trace[10:], want) {
		t.Fatalf("rejection order: %v", r.trace)
	}
}

func TestTargetVerificationReadErrorRollsBackKnownPair(t *testing.T) {
	s, r := bindFixture(t, "apply")
	r.before = func(name string) error {
		if name == "matches" {
			return errors.New("verification I/O failure")
		}
		return nil
	}
	result, err := s.Apply(context.Background(), ApplyCommand{})
	if err != nil || result == nil || result.Result.Phase != "rolled_back" || result.Result.Code != "apply_failed" || r.trees[port.App].build != r.request.Source || r.phase != "rolled_back" {
		t.Fatal("known pair was not restored after verification error", result, err, r.trace)
	}
}

func TestAutomaticRollbackNeverDisplacesReplacementOrCompletesWithoutRecord(t *testing.T) {
	for _, kind := range []string{"replacement", "record-unknown"} {
		t.Run(kind, func(t *testing.T) {
			s, r := bindFixture(t, "apply")
			r.match = false
			if kind == "replacement" {
				r.after = func(name string) {
					if name == "matches" {
						tree := r.trees[port.App]
						tree.identity.Inode = "303"
						r.trees[port.App] = tree
					}
				}
			} else {
				r.before = func(name string) error {
					if name == "reject" {
						return &port.HelperRecoveryFailure{Code: "record_unknown", Phase: "refused", Uncertain: true}
					}
					return nil
				}
			}
			result, err := s.Apply(context.Background(), ApplyCommand{})
			if result != nil || r.reject || r.phase == "rolled_back" {
				t.Fatal("unsettled automatic rollback returned terminal result")
			}
			if kind == "replacement" {
				failureFixture(t, err, "target_uncertain", "new_installed", false, true)
				if r.trees[port.App].identity.Inode != "303" || r.trees[port.Previous].build != r.request.Source {
					t.Fatal("replacement displaced")
				}
			} else {
				failureFixture(t, err, "record_unknown", "rollback_started", false, true)
				if r.trees[port.App].build != r.request.Source || r.trees[port.Failed].build != r.request.Target {
					t.Fatal("failed target custody lost")
				}
			}
		})
	}
}
func TestManualRollbackRequiresTerminalPhaseAndPreservesFailedTarget(t *testing.T) {
	for _, phase := range []string{"verified", "completed", "launch_requested"} {
		t.Run(phase, func(t *testing.T) {
			s, r := bindFixture(t, "rollback")
			r.phase = phase
			result, err := s.Rollback(context.Background(), RollbackCommand{})
			if err != nil || result == nil || result.Result != (Result{Phase: "rolled_back"}) || r.reject || len(r.trees) != 2 || r.trees[port.App].build != r.request.Source || r.trees[port.Failed].build != r.request.Target {
				t.Fatalf("rollback=%#v err=%v state=%#v", result, err, r)
			}
			want := []string{"read", "entries", "verify:0:alpha-2", "verify:2:alpha-1", "write:rollback_started", "fence", "exchange:0:2", "fence", "rename:2:3", "verify:0:alpha-1", "write:rolled_back"}
			if !reflect.DeepEqual(r.trace, want) {
				t.Fatalf("rollback order: %v", r.trace)
			}
		})
	}
}
func TestApplyPreflightRefusesWithoutEffects(t *testing.T) {
	for _, kind := range []string{"app", "staged", "previous", "failed", "rejected", "device", "source-tree", "target-tree", "journal"} {
		t.Run(kind, func(t *testing.T) {
			s, r := bindFixture(t, "apply")
			code := "operation_exists"
			switch kind {
			case "app":
				delete(r.trees, port.App)
				code = "app_missing"
			case "staged":
				delete(r.trees, port.Staged)
				code = "staged_missing"
			case "previous":
				r.trees[port.Previous] = r.trees[port.App]
			case "failed":
				r.trees[port.Failed] = r.trees[port.Staged]
			case "rejected":
				r.reject = true
			case "device":
				tree := r.trees[port.Staged]
				tree.identity.Device = "2"
				r.trees[port.Staged] = tree
				code = "exchange_unsupported"
			case "source-tree", "target-tree":
				entry := port.App
				if kind == "target-tree" {
					entry = port.Staged
				}
				tree := r.trees[entry]
				tree.build.Digest = "different"
				r.trees[entry] = tree
				code = "tree"
			case "journal":
				r.phase = "prepared"
			}
			before := make(map[port.HelperRecoveryEntry]treeFixture)
			for k, v := range r.trees {
				before[k] = v
			}
			result, err := s.Apply(context.Background(), ApplyCommand{})
			if result != nil {
				t.Fatal("refusal returned result")
			}
			failureFixture(t, err, code, "refused", false, false)
			if !reflect.DeepEqual(r.trees, before) || kind != "journal" && r.phase != "" {
				t.Fatal("preflight changed policy state")
			}
		})
	}
}
func TestRollbackRefusesAmbiguousPhasePairAndIncompatiblePredecessor(t *testing.T) {
	for _, kind := range []string{"prepared", "rollback_started", "rolled_back", "unknown", "missing", "staged", "failed", "rejected", "incompatible"} {
		t.Run(kind, func(t *testing.T) {
			s, r := bindFixture(t, "rollback")
			code := "rollback_pair"
			switch kind {
			case "prepared", "rollback_started", "rolled_back", "unknown":
				r.phase = kind
				code = "rollback_phase"
			case "missing":
				delete(r.trees, port.Previous)
			case "staged":
				r.trees[port.Staged] = r.trees[port.Previous]
			case "failed":
				r.trees[port.Failed] = r.trees[port.App]
			case "rejected":
				r.reject = true
			case "incompatible":
				s.request.Source.Version = "0.1.9"
				code = "predecessor_state_unqualified"
			}
			result, err := s.Rollback(context.Background(), RollbackCommand{})
			if result != nil {
				t.Fatal("refusal returned result")
			}
			phase := "verified"
			if code != "rollback_pair" {
				phase = "refused"
			}
			failureFixture(t, err, code, phase, false, false)
			for _, call := range r.trace {
				if call != "read" && call != "entries" {
					t.Fatalf("unsafe phase/pair reached %s", call)
				}
			}
		})
	}
}

func TestOneAttemptIncludesCanceledAndConcurrentCopiedServices(t *testing.T) {
	s, r := bindFixture(t, "apply")
	copy := *s
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := s.Apply(ctx, ApplyCommand{})
	if result != nil || len(r.trace) != 0 {
		t.Fatal("canceled attempt reached port")
	}
	failureFixture(t, err, "canceled", "refused", false, false)
	result, err = copy.Apply(context.Background(), ApplyCommand{})
	if result != nil || len(r.trace) != 0 {
		t.Fatal("copy replayed consumed attempt")
	}
	failureFixture(t, err, "execution_attempt_unknown", "refused", false, true)

	s, r = bindFixture(t, "apply")
	copy = *s
	var wg sync.WaitGroup
	results := make(chan error, 16)
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			owner := s
			if i%2 == 1 {
				owner = &copy
			}
			_, err := owner.Apply(context.Background(), ApplyCommand{})
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else {
			failureFixture(t, err, "execution_attempt_unknown", "refused", false, true)
		}
	}
	if successes != 1 || r.phase != "verified" {
		t.Fatal("concurrent attempts did not consume exactly once")
	}
}

func TestBoundRequestDoesNotAliasInputOrParserPointers(t *testing.T) {
	r := requestFixture("apply")
	p := &parserFixture{request: r, parse: func(_ context.Context, raw []byte) { raw[0] = 'x' }}
	runtime := newRuntime(r)
	input := []byte("symbolic")
	s, err := Bind(context.Background(), input, p, runtime)
	if err != nil {
		t.Fatal(err)
	}
	*r.InstallLocation = "changed"
	r.Predecessor.Kind = "changed"
	r.LeaseIdentity.Inode = "changed"
	if string(input) != "symbolic" || *s.request.InstallLocation != "symbolic-install-location" || s.request.Predecessor.Kind != "symbolic" || s.request.LeaseIdentity.Inode != "9" {
		t.Fatal("captured request aliases parser or caller")
	}
}

type cyclicCause struct{}

func (cyclicCause) Error() string   { return "private cyclic cause" }
func (c cyclicCause) Unwrap() error { return c }

func TestPortFailuresPreserveUnknownAndOpaqueClassification(t *testing.T) {
	for _, kind := range []string{"known-before", "known-after", "uncertain-before", "opaque-before", "opaque-join", "malformed", "cyclic"} {
		t.Run(kind, func(t *testing.T) {
			s, r := bindFixture(t, "apply")
			cause := error(&port.HelperRecoveryFailure{Code: "lease_changed", Phase: "refused"})
			at, code, phase, internal, unknown := "prepare", "lease_changed", "refused", false, false
			switch kind {
			case "known-after":
				at, phase, unknown = "exchange:0:1", "prepared", true
			case "uncertain-before":
				cause.(*port.HelperRecoveryFailure).Uncertain = true
				unknown = true
			case "opaque-before":
				cause = errors.New("private native path failure")
				code, internal, unknown = "internal", true, true
			case "opaque-join":
				cause = errors.Join(cause, &port.HelperRecoveryFailure{Code: "effect", Phase: "refused", Uncertain: true})
				at, code, internal, unknown = "entries", "internal", true, true
			case "malformed":
				cause = &port.HelperRecoveryFailure{Code: "private\npath", Phase: "refused"}
				code, internal, unknown = "internal", true, true
			case "cyclic":
				cause = cyclicCause{}
				at, code, internal, unknown = "entries", "internal", true, true
			}
			r.before = func(name string) error {
				if name == at {
					return cause
				}
				return nil
			}
			result, err := s.Apply(context.Background(), ApplyCommand{})
			if result != nil {
				t.Fatal("failed port returned success")
			}
			f := failureFixture(t, err, code, phase, internal, unknown)
			// Do not call errors.Is on the deliberate cycle; it is unbounded.
			if kind != "cyclic" && !errors.Is(f, cause) {
				t.Fatal("dependency cause lost")
			}
		})
	}
}
func TestCancellationAfterPortReturnNeverPublishesResult(t *testing.T) {
	for _, point := range []string{"entries", "prepare", "exchange:0:1", "write:verified", "write:rolled_back"} {
		t.Run(point, func(t *testing.T) {
			s, r := bindFixture(t, "apply")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r.match = point != "write:rolled_back"
			r.after = func(name string) {
				if name == point {
					cancel()
				}
			}
			result, err := s.Apply(ctx, ApplyCommand{})
			if result != nil || !errors.Is(err, context.Canceled) {
				t.Fatalf("late result=%#v error=%v", result, err)
			}
			f, ok := err.(*Failure)
			if !ok || f.Code != "canceled" || f.Internal || f.Uncertain != (point != "entries") {
				t.Fatalf("late cancellation %#v", err)
			}
		})
	}
}

// Inject each controlled post-swap failure once. The real runtime independently
// refuses compensation for unknown effects or lost custody; this symbolic
// table proves the application does not abandon a pair it can still restore.
func TestControlledPostSwapFailuresAlwaysSettle(t *testing.T) {
	for _, point := range []string{"verify:1:alpha-1", "fence", "rename:1:2", "write:new_installed", "matches", "write:verified"} {
		t.Run(point, func(t *testing.T) {
			s, r := bindFixture(t, "apply")
			injected, exchanged := false, false
			r.after = func(name string) {
				if name == "exchange:0:1" {
					exchanged = true
				}
			}
			r.before = func(name string) error {
				if exchanged && !injected && name == point {
					injected = true
					return errors.New("controlled failure")
				}
				return nil
			}
			result, err := s.Apply(context.Background(), ApplyCommand{})
			if !injected || err != nil || result == nil || r.phase != "rolled_back" || r.trees[port.App].build != r.request.Source {
				t.Fatal("controlled error did not settle", result, err, r.phase, r.trace)
			}
		})
	}
}
