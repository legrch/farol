package codex

// CPU-only authority doubles. No native Verify, socket, process, filesystem
// qualification, account or serving catalogue is exercised by these tests.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type authorityVerifier func(context.Context, Selection) error

func (v authorityVerifier) Verify(ctx context.Context, s Selection) error { return v(ctx, s) }

func authoritySnapshot() AuthoritySnapshot {
	start := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	// Exact taskPolicyIdentity bytes for an explicit, single-model TS policy.
	policy := `["farol-task-policy/1","codex",[["codex","selected",[["selected","fixture-model","high"]]]]]`
	hash := sha256.Sum256([]byte(policy))
	s := Selection{
		Binding: task.Binding{Provider: task.Codex, ProfileID: "cpu-profile", HostID: "cpu-host",
			ProjectID: "saved-project", WorkspaceID: "writer", ModelAlias: "selected", Model: "fixture-model",
			Effort: "high", ConfigDigest: hex.EncodeToString(hash[:]),
			Project: task.Root{Path: "/cpu/project", Device: "1", Inode: "10", GitCommonDirectory: "/cpu/project/.git"},
			Writer:  task.Root{Path: "/cpu/writer", Device: "1", Inode: "11", GitCommonDirectory: "/cpu/project/.git"}},
		ExecutablePath: "/cpu/bin/codex", ExecutableSHA256: strings.Repeat("b", 64), SocketPath: "/cpu/codex.sock",
		ExpectedCodexHome: "/cpu/provider-home", ScratchRoot: "/cpu/scratch", Protocol: "codex-app-server/v2",
		SchemaSHA256: strings.Repeat("c", 64), Sandbox: "workspace-write", ApprovalPolicy: "on-request",
		GrantedAt: start, ExpiresAt: start.Add(time.Hour),
	}
	return AuthoritySnapshot{State: AuthorityReady, Selection: s, HostGeneration: 3, ComputerGeneration: 7,
		GrantHostGeneration: 3, GrantComputerGeneration: 7, Approved: true, Access: WorkspaceWrite,
		VerifiedWorkspaceID: "writer", VerifiedComputerGeneration: 7,
		Handoff: HandoffQualification{ExecutablePath: s.ExecutablePath, ExecutableSHA256: s.ExecutableSHA256,
			Protocol: s.Protocol, SchemaSHA256: s.SchemaSHA256, HostGeneration: 3, ProjectBoundCreateStatus: true}}
}

func authorityFollowup(s Selection) FollowupQualification {
	return FollowupQualification{Selection: s, Witness: FollowupSchemaWitness{
		Kind: FollowupSchemaKind, Protocol: s.Protocol, BaseSchemaSHA256: s.SchemaSHA256, SchemaSHA256: strings.Repeat("d", 64)}}
}

func authorityRequest(s AuthoritySnapshot) port.Selection {
	b := s.Selection.Binding
	return port.Selection{Provider: b.Provider, ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, ModelAlias: b.ModelAlias, Effort: b.Effort}
}

// Mutable fixture state is locked so actual concurrent readers can be race-tested.
type authorityCPU struct {
	mu        sync.Mutex
	snapshot  AuthoritySnapshot
	now       time.Time
	reads     int
	verifies  int
	onRead    func(int)
	onVerify  func(context.Context)
	readErr   error
	verifyErr error
}

func authorityFixture(t *testing.T, s AuthoritySnapshot) (*SelectionAuthority, *authorityCPU) {
	t.Helper()
	f := &authorityCPU{snapshot: s, now: s.Selection.GrantedAt.Add(time.Minute)}
	a, err := NewSelectionAuthority(SelectionAuthorityOptions{Selected: s,
		ReadCurrent: func(ctx context.Context) (AuthoritySnapshot, error) {
			f.mu.Lock()
			f.reads++
			n, hook := f.reads, f.onRead
			f.mu.Unlock()
			if hook != nil {
				hook(n)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.snapshot, f.readErr
		}, Verifier: authorityVerifier(func(ctx context.Context, actual Selection) error {
			if actual != s.Selection {
				return task.ErrIdentity
			}
			f.mu.Lock()
			f.verifies++
			hook, err := f.onVerify, f.verifyErr
			f.mu.Unlock()
			if hook != nil {
				hook(ctx)
			}
			return err
		}), Now: func() time.Time {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.now
		}})
	if err != nil {
		t.Fatal(err)
	}
	return a, f
}

func (f *authorityCPU) change(fn func(*AuthoritySnapshot)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(&f.snapshot)
}
func (f *authorityCPU) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reads, f.verifies
}

func TestSelectionAuthorityConstructorIsInertAndParentIsAbsent(t *testing.T) {
	s := authoritySnapshot()
	a, err := NewSelectionAuthority(SelectionAuthorityOptions{Selected: s,
		ReadCurrent: func(context.Context) (AuthoritySnapshot, error) { panic("constructor read") },
		Verifier:    authorityVerifier(func(context.Context, Selection) error { panic("constructor Verify") }),
		Now:         func() time.Time { panic("constructor clock") }})
	if err != nil || a == nil {
		t.Fatalf("constructor: %v", err)
	}
	if _, ok := any(a).(port.Authority); ok {
		t.Fatal("selection adapter must not supply Parent authority")
	}
}

func TestSelectionAuthorityResolvePreservesExactBindingAndPolicyDigest(t *testing.T) {
	s := authoritySnapshot()
	a, f := authorityFixture(t, s)
	got, err := a.Resolve(context.Background(), authorityRequest(s))
	if err != nil || got != s.Selection.Binding {
		t.Fatalf("binding: %#v, %v", got, err)
	}
	if got.ConfigDigest != s.Selection.Binding.ConfigDigest {
		t.Fatal("semantic policy digest was rewritten")
	}
	if reads, verifies := f.counts(); reads != 2 || verifies != 1 {
		t.Fatalf("reads=%d Verify=%d", reads, verifies)
	}
}

func TestSelectionAuthorityRequestIdentityHasNoDefaultResolution(t *testing.T) {
	changes := map[string]func(*port.Selection){
		"provider":       func(r *port.Selection) { r.Provider = task.Claude },
		"project":        func(r *port.Selection) { r.ProjectID = "another" },
		"workspace":      func(r *port.Selection) { r.WorkspaceID = "another" },
		"alias":          func(r *port.Selection) { r.ModelAlias = "another" },
		"effort":         func(r *port.Selection) { r.Effort = "low" },
		"omitted-effort": func(r *port.Selection) { r.Effort = "" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			s := authoritySnapshot()
			a, f := authorityFixture(t, s)
			req := authorityRequest(s)
			change(&req)
			b, err := a.Resolve(context.Background(), req)
			if !errors.Is(err, task.ErrIdentity) || b != (task.Binding{}) {
				t.Fatalf("resolved mismatch: %#v %v", b, err)
			}
			if reads, verifies := f.counts(); reads != 0 || verifies != 0 {
				t.Fatal("mismatch reached boundaries")
			}
		})
	}
	// An explicitly selected empty effort stays empty. Serving catalogue support
	// is checked by the existing Client.Supports, never guessed by this adapter.
	s := authoritySnapshot()
	s.Selection.Binding.Effort = ""
	a, _ := authorityFixture(t, s)
	b, err := a.Resolve(context.Background(), authorityRequest(s))
	if err != nil || b.Effort != "" {
		t.Fatalf("empty effort changed: %v", err)
	}
}

// Mutations include internally valid alternative selections: equality to the
// original, not merely current validity, must reject them on BOTH current reads.
func authorityChanges() map[string]func(*AuthoritySnapshot) {
	return map[string]func(*AuthoritySnapshot){
		"unknown":                   func(s *AuthoritySnapshot) { s.State = AuthorityUnknown },
		"refused":                   func(s *AuthoritySnapshot) { s.State = AuthorityRefused },
		"unavailable":               func(s *AuthoritySnapshot) { s.State = AuthorityUnavailable },
		"unknown-state":             func(s *AuthoritySnapshot) { s.State = "invented" },
		"approval-withdrawn":        func(s *AuthoritySnapshot) { s.Approved = false },
		"write-access-withdrawn":    func(s *AuthoritySnapshot) { s.Access = WorkspaceRead },
		"unknown-access":            func(s *AuthoritySnapshot) { s.Access = "unknown" },
		"host-generation":           func(s *AuthoritySnapshot) { s.HostGeneration++ },
		"computer-generation":       func(s *AuthoritySnapshot) { s.ComputerGeneration++ },
		"grant-host-generation":     func(s *AuthoritySnapshot) { s.GrantHostGeneration++ },
		"grant-computer-generation": func(s *AuthoritySnapshot) { s.GrantComputerGeneration++ },
		"valid-new-host-generation": func(s *AuthoritySnapshot) { s.HostGeneration++; s.GrantHostGeneration++; s.Handoff.HostGeneration++ },
		"valid-new-computer-generation": func(s *AuthoritySnapshot) {
			s.ComputerGeneration++
			s.GrantComputerGeneration++
			s.VerifiedComputerGeneration++
		},
		"setup-workspace":  func(s *AuthoritySnapshot) { s.VerifiedWorkspaceID = "another" },
		"setup-generation": func(s *AuthoritySnapshot) { s.VerifiedComputerGeneration++ },
		"profile":          func(s *AuthoritySnapshot) { s.Selection.Binding.ProfileID = "another" },
		"host-id":          func(s *AuthoritySnapshot) { s.Selection.Binding.HostID = "another" },
		"project-id":       func(s *AuthoritySnapshot) { s.Selection.Binding.ProjectID = "another" },
		"workspace-id": func(s *AuthoritySnapshot) {
			s.Selection.Binding.WorkspaceID = "another"
			s.VerifiedWorkspaceID = "another"
		},
		"project-path":   func(s *AuthoritySnapshot) { s.Selection.Binding.Project.Path = "/cpu/other-project" },
		"project-device": func(s *AuthoritySnapshot) { s.Selection.Binding.Project.Device = "2" },
		"project-inode":  func(s *AuthoritySnapshot) { s.Selection.Binding.Project.Inode = "12" },
		"writer-path":    func(s *AuthoritySnapshot) { s.Selection.Binding.Writer.Path = "/cpu/other-writer" },
		"writer-device":  func(s *AuthoritySnapshot) { s.Selection.Binding.Writer.Device = "2" },
		"writer-inode":   func(s *AuthoritySnapshot) { s.Selection.Binding.Writer.Inode = "12" },
		"git-common": func(s *AuthoritySnapshot) {
			s.Selection.Binding.Project.GitCommonDirectory = "/cpu/other/.git"
			s.Selection.Binding.Writer.GitCommonDirectory = "/cpu/other/.git"
		},
		"alias":                 func(s *AuthoritySnapshot) { s.Selection.Binding.ModelAlias = "another" },
		"model":                 func(s *AuthoritySnapshot) { s.Selection.Binding.Model = "another-model" },
		"effort":                func(s *AuthoritySnapshot) { s.Selection.Binding.Effort = "low" },
		"policy-digest":         func(s *AuthoritySnapshot) { s.Selection.Binding.ConfigDigest = strings.Repeat("e", 64) },
		"invalid-policy-digest": func(s *AuthoritySnapshot) { s.Selection.Binding.ConfigDigest = "not-a-digest" },
		"executable-path": func(s *AuthoritySnapshot) {
			s.Selection.ExecutablePath = "/cpu/other-bin"
			s.Handoff.ExecutablePath = s.Selection.ExecutablePath
		},
		"executable-hash": func(s *AuthoritySnapshot) {
			s.Selection.ExecutableSHA256 = strings.Repeat("e", 64)
			s.Handoff.ExecutableSHA256 = s.Selection.ExecutableSHA256
		},
		"socket":  func(s *AuthoritySnapshot) { s.Selection.SocketPath = "/cpu/other.sock" },
		"home":    func(s *AuthoritySnapshot) { s.Selection.ExpectedCodexHome = "/cpu/other-home" },
		"scratch": func(s *AuthoritySnapshot) { s.Selection.ScratchRoot = "/cpu/other-scratch" },
		"schema": func(s *AuthoritySnapshot) {
			s.Selection.SchemaSHA256 = strings.Repeat("e", 64)
			s.Handoff.SchemaSHA256 = s.Selection.SchemaSHA256
		},
		"sandbox":                 func(s *AuthoritySnapshot) { s.Selection.Sandbox = "read-only" },
		"approval-policy":         func(s *AuthoritySnapshot) { s.Selection.ApprovalPolicy = "untrusted" },
		"grant-start":             func(s *AuthoritySnapshot) { s.Selection.GrantedAt = s.Selection.GrantedAt.Add(time.Second) },
		"grant-expiry":            func(s *AuthoritySnapshot) { s.Selection.ExpiresAt = s.Selection.ExpiresAt.Add(time.Second) },
		"missing-handoff":         func(s *AuthoritySnapshot) { s.Handoff = HandoffQualification{} },
		"handoff-not-qualified":   func(s *AuthoritySnapshot) { s.Handoff.ProjectBoundCreateStatus = false },
		"handoff-executable":      func(s *AuthoritySnapshot) { s.Handoff.ExecutablePath = "/cpu/wrong" },
		"handoff-executable-hash": func(s *AuthoritySnapshot) { s.Handoff.ExecutableSHA256 = strings.Repeat("e", 64) },
		"handoff-protocol":        func(s *AuthoritySnapshot) { s.Handoff.Protocol = "wrong" },
		"handoff-generation":      func(s *AuthoritySnapshot) { s.Handoff.HostGeneration++ },
		"handoff-digest":          func(s *AuthoritySnapshot) { s.Handoff.SchemaSHA256 = strings.Repeat("e", 64) },
		"followup-added":          func(s *AuthoritySnapshot) { s.Followup = authorityFollowup(s.Selection) },
	}
}

func TestSelectionAuthorityCurrentSnapshotBeforeAndAfterVerify(t *testing.T) {
	for _, stage := range []string{"before", "after"} {
		t.Run(stage, func(t *testing.T) {
			for name, change := range authorityChanges() {
				t.Run(name, func(t *testing.T) {
					s := authoritySnapshot()
					a, f := authorityFixture(t, s)
					if stage == "before" {
						f.change(change)
					} else {
						f.onVerify = func(context.Context) { f.change(change) }
					}
					b, err := a.Resolve(context.Background(), authorityRequest(s))
					if err == nil || b != (task.Binding{}) {
						t.Fatalf("stale binding authorized: %#v %v", b, err)
					}
					reads, verifies := f.counts()
					if stage == "before" && (reads != 1 || verifies != 0) {
						t.Fatalf("stale precheck: reads=%d Verify=%d", reads, verifies)
					}
					if stage == "after" && (reads != 2 || verifies != 1) {
						t.Fatalf("stale postcheck: reads=%d Verify=%d", reads, verifies)
					}
					// Re-resolution cannot adopt the changed settings even when its
					// requested fields happen to match the original Binding.
					if err := a.Recheck(context.Background(), s.Selection.Binding); err == nil {
						t.Fatal("adopted newer snapshot")
					}
				})
			}
		})
	}
}

func TestSelectionAuthorityMissingQualificationAndInvalidDependencies(t *testing.T) {
	base := authoritySnapshot()
	options := func(s AuthoritySnapshot) SelectionAuthorityOptions {
		return SelectionAuthorityOptions{Selected: s,
			ReadCurrent: func(context.Context) (AuthoritySnapshot, error) { panic("invalid constructor read") },
			Verifier:    authorityVerifier(func(context.Context, Selection) error { panic("invalid constructor Verify") }),
			Now:         func() time.Time { panic("invalid constructor clock") }}
	}
	changes := authorityChanges()
	for _, name := range []string{"unknown", "refused", "unavailable", "unknown-state", "approval-withdrawn",
		"write-access-withdrawn", "unknown-access", "host-generation", "computer-generation",
		"grant-host-generation", "grant-computer-generation", "setup-workspace", "setup-generation",
		"invalid-policy-digest", "missing-handoff", "handoff-not-qualified", "handoff-executable",
		"handoff-executable-hash", "handoff-protocol", "handoff-generation", "handoff-digest"} {
		s := base
		changes[name](&s)
		t.Run(name, func(t *testing.T) {
			a, err := NewSelectionAuthority(options(s))
			if err == nil || a != nil {
				t.Fatal("unqualified constructor accepted")
			}
		})
	}
	for _, missing := range []string{"reader", "verifier", "clock"} {
		t.Run(missing, func(t *testing.T) {
			o := options(base)
			switch missing {
			case "reader":
				o.ReadCurrent = nil
			case "verifier":
				o.Verifier = nil
			case "clock":
				o.Now = nil
			}
			if a, err := NewSelectionAuthority(o); !errors.Is(err, task.ErrInvalid) || a != nil {
				t.Fatalf("missing dependency: %v", err)
			}
		})
	}
}

func TestSelectionAuthorityRetainsExactReadOnlyGrantAndCapturedValues(t *testing.T) {
	s := authoritySnapshot()
	s.Selection.Sandbox = "read-only"
	s.Access = WorkspaceRead
	a, f := authorityFixture(t, s)
	// Caller mutation of its original value does not rewrite captured options.
	original := s
	s.Selection.Binding.Model = "another"
	s.Approved = false
	got, err := a.Resolve(context.Background(), authorityRequest(original))
	if err != nil || got != original.Selection.Binding {
		t.Fatalf("captured values changed: %v", err)
	}
	f.change(func(s *AuthoritySnapshot) { s.Access = WorkspaceWrite })
	if err := a.Recheck(context.Background(), original.Selection.Binding); !errors.Is(err, task.ErrIdentity) {
		t.Fatalf("adopted changed access even though new access suffices: %v", err)
	}
}

func TestSelectionAuthorityFollowupBindsFullOriginalSelection(t *testing.T) {
	s := authoritySnapshot()
	s.Followup = authorityFollowup(s.Selection)
	a, f := authorityFixture(t, s)
	if err := a.Recheck(context.Background(), s.Selection.Binding); err != nil {
		t.Fatal(err)
	}
	changes := map[string]func(*AuthoritySnapshot){
		"removed":                func(s *AuthoritySnapshot) { s.Followup = FollowupQualification{} },
		"kind":                   func(s *AuthoritySnapshot) { s.Followup.Witness.Kind = "base" },
		"protocol":               func(s *AuthoritySnapshot) { s.Followup.Witness.Protocol = "wrong" },
		"baseline":               func(s *AuthoritySnapshot) { s.Followup.Witness.BaseSchemaSHA256 = strings.Repeat("e", 64) },
		"same-digest":            func(s *AuthoritySnapshot) { s.Followup.Witness.SchemaSHA256 = s.Selection.SchemaSHA256 },
		"new-independent-digest": func(s *AuthoritySnapshot) { s.Followup.Witness.SchemaSHA256 = strings.Repeat("e", 64) },
		"partial-selection":      func(s *AuthoritySnapshot) { s.Followup.Selection.Binding.Effort = "low" },
		"other-socket":           func(s *AuthoritySnapshot) { s.Followup.Selection.SocketPath = "/cpu/other.sock" },
		"other-grant":            func(s *AuthoritySnapshot) { s.Followup.Selection.ExpiresAt = s.Selection.ExpiresAt.Add(time.Second) },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			a, f := authorityFixture(t, s)
			f.onVerify = func(context.Context) { f.change(change) }
			if err := a.Recheck(context.Background(), s.Selection.Binding); err == nil {
				t.Fatal("changed follow-up authorized")
			}
		})
	}
	if reads, verifies := f.counts(); reads != 2 || verifies != 1 {
		t.Fatal("valid follow-up missing current checks")
	}
}

func TestSelectionAuthorityExpiryAndCancellationAcrossEveryAwait(t *testing.T) {
	for _, stage := range []string{"before", "first-read", "verify", "second-read"} {
		for _, reason := range []string{"expiry", "cancel"} {
			t.Run(stage+"/"+reason, func(t *testing.T) {
				s := authoritySnapshot()
				a, f := authorityFixture(t, s)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				deny := func() {
					if reason == "cancel" {
						cancel()
					} else {
						f.mu.Lock()
						f.now = s.Selection.ExpiresAt
						f.mu.Unlock()
					}
				}
				switch stage {
				case "before":
					deny()
				case "verify":
					f.onVerify = func(context.Context) { deny() }
				case "first-read", "second-read":
					f.onRead = func(n int) {
						if stage == "first-read" && n == 1 || stage == "second-read" && n == 2 {
							deny()
						}
					}
				}
				if err := a.Recheck(ctx, s.Selection.Binding); err == nil {
					t.Fatal("expired/cancelled authority accepted")
				}
			})
		}
	}
	for _, name := range []string{"before-start", "at-start", "before-expiry", "at-expiry"} {
		t.Run(name, func(t *testing.T) {
			s := authoritySnapshot()
			a, f := authorityFixture(t, s)
			switch name {
			case "before-start":
				f.now = s.Selection.GrantedAt.Add(-time.Nanosecond)
			case "at-start":
				f.now = s.Selection.GrantedAt
			case "before-expiry":
				f.now = s.Selection.ExpiresAt.Add(-time.Nanosecond)
			case "at-expiry":
				f.now = s.Selection.ExpiresAt
			}
			err := a.Recheck(context.Background(), s.Selection.Binding)
			allowed := name == "at-start" || name == "before-expiry"
			if (err == nil) != allowed {
				t.Fatalf("grant interval: %v", err)
			}
		})
	}
}

func TestSelectionAuthorityBoundaryErrorsAreClassifiedWithoutRetry(t *testing.T) {
	for _, stage := range []string{"first-read", "verify", "second-read"} {
		for _, raw := range []error{errors.New("private diagnostic"), fmt.Errorf("private: %w", task.ErrUnknown), fmt.Errorf("private: %w", task.ErrIdentity), fmt.Errorf("private: %w", task.ErrState)} {
			t.Run(stage+"/"+raw.Error(), func(t *testing.T) {
				s := authoritySnapshot()
				a, f := authorityFixture(t, s)
				if stage == "verify" {
					f.verifyErr = raw
				} else {
					f.onRead = func(n int) {
						if stage == "first-read" && n == 1 || stage == "second-read" && n == 2 {
							f.mu.Lock()
							f.readErr = raw
							f.mu.Unlock()
						}
					}
				}
				b, err := a.Resolve(context.Background(), authorityRequest(s))
				if err == nil || b != (task.Binding{}) || strings.Contains(err.Error(), "private") {
					t.Fatalf("raw/unclassified result: %v", err)
				}
				if errors.Is(raw, task.ErrUnknown) && !errors.Is(err, task.ErrUnknown) {
					t.Fatal("unknown reinterpreted")
				}
				reads, verifies := f.counts()
				expectedReads, expectedVerify := 1, 0
				if stage == "verify" {
					expectedVerify = 1
				}
				if stage == "second-read" {
					expectedReads, expectedVerify = 2, 1
				}
				if reads != expectedReads || verifies != expectedVerify {
					t.Fatalf("retry: reads=%d Verify=%d", reads, verifies)
				}
			})
		}
	}
}

func TestSelectionAuthorityWrongBindingNilAndCancelledInputs(t *testing.T) {
	s := authoritySnapshot()
	a, f := authorityFixture(t, s)
	other := s.Selection.Binding
	other.HostID = "another"
	if err := a.Recheck(context.Background(), other); !errors.Is(err, task.ErrIdentity) {
		t.Fatalf("binding mismatch: %v", err)
	}
	var absent *SelectionAuthority
	if err := absent.Recheck(context.Background(), s.Selection.Binding); err == nil {
		t.Fatal("nil authority accepted")
	}
	if b, err := absent.Resolve(context.Background(), authorityRequest(s)); err == nil || b != (task.Binding{}) {
		t.Fatal("nil resolve accepted")
	}
	if err := a.Recheck(nil, s.Selection.Binding); err == nil {
		t.Fatal("nil context accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := a.Recheck(ctx, s.Selection.Binding); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	if reads, verifies := f.counts(); reads != 0 || verifies != 0 {
		t.Fatal("invalid input reached boundaries")
	}
}

func TestSelectionAuthorityConcurrentCurrentChecks(t *testing.T) {
	s := authoritySnapshot()
	a, f := authorityFixture(t, s)
	const count = 16
	var wg sync.WaitGroup
	for range count {
		wg.Go(func() {
			if err := a.Recheck(context.Background(), s.Selection.Binding); err != nil {
				t.Errorf("concurrent recheck: %v", err)
			}
		})
	}
	wg.Wait()
	if reads, verifies := f.counts(); reads != 2*count || verifies != count {
		t.Fatalf("counts: %d %d", reads, verifies)
	}
}

func TestSelectionAuthorityAwaitedVerifyRejectsConcurrentSettingsChange(t *testing.T) {
	s := authoritySnapshot()
	a, f := authorityFixture(t, s)
	entered, release := make(chan struct{}), make(chan struct{})
	f.onVerify = func(ctx context.Context) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- a.Recheck(ctx, s.Selection.Binding) }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("Verify not entered")
	}
	f.change(func(s *AuthoritySnapshot) { s.Approved = false })
	close(release)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("concurrent withdrawal ignored")
		}
	case <-ctx.Done():
		t.Fatal("recheck did not finish")
	}
}
