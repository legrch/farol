package connector_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure owner policy fixtures only. No native suites, filesystem, host, transport,
// provider, startup or external Setup proof is exercised. Root owns digest creation
// and the assertion that the real List and final disclosure have succeeded.
type verificationGate struct{ held bool }

func (g *verificationGate) Lock() {
	if g.held {
		panic("fixture owner gate reentered")
	}
	g.held = true
}
func (g *verificationGate) Unlock() {
	if !g.held {
		panic("fixture owner gate not held")
	}
	g.held = false
}

type verificationJournal struct {
	*journal
	snapshots int
	gate      *verificationGate
}

func (j *verificationJournal) WithSnapshot(c context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	if j.gate.held {
		panic("fixture journal entered under owner gate")
	}
	j.snapshots++
	return j.journal.WithSnapshot(c, id, inspect)
}

type verificationFixture struct {
	fixture
	gate *verificationGate
	io   *verificationJournal
}

func newVerificationFixture(t *testing.T) verificationFixture {
	t.Helper()
	f := newFixture(t)
	f.launch.VerificationChallenge = [32]byte{1, 9}
	other := f.launch.Approval.Workspaces[0]
	other.WorkspaceID, other.Root = "other", "/other"
	f.launch.Approval.Workspaces = append(f.launch.Approval.Workspaces, other)
	approvedOnly := other
	approvedOnly.WorkspaceID, approvedOnly.Root = "approved-only", "/approved-only"
	f.launch.Approval.Workspaces = append(f.launch.Approval.Workspaces, approvedOnly)
	scope := f.launch.Admission.Workspaces[0]
	scope.WorkspaceID, scope.Root = other.WorkspaceID, other.Root
	f.launch.Admission.Workspaces = append(f.launch.Admission.Workspaces, scope)
	f.journal.approval = f.launch.Approval.Clone()
	g := &verificationGate{}
	j := &verificationJournal{journal: f.journal, gate: g}
	var err error
	f.owner, err = connector.New(g, j, f.guard, f.clock, f.launch)
	if err != nil {
		t.Fatal(err)
	}
	f.root.owner, f.root.journal = f.owner, j
	f.guard.check = func() {
		if !g.held {
			t.Fatal("verification guard entered outside owner gate")
		}
	}
	return verificationFixture{fixture: f, gate: g, io: j}
}

func (f verificationFixture) observation() port.ConnectorVerification {
	return port.ConnectorVerification{Host: f.launch.Host,
		Binding:         port.TaskBinding{Identity: f.launch.Admission.Identity, ParticipantID: f.launch.Participant.ParticipantID, TurnID: f.launch.TurnCorrelation},
		ChallengeDigest: f.launch.VerificationChallenge, WorkspaceID: "work", CallID: "go-list-call", EntryCount: 2}
}

func verificationActive(t *testing.T) verificationFixture {
	t.Helper()
	f := newVerificationFixture(t)
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func verificationBegin(t *testing.T, f verificationFixture) {
	t.Helper()
	v := f.observation()
	if err := f.owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID); err != nil {
		t.Fatal(err)
	}
}

func verificationAbsent(t *testing.T, s *connector.Service) {
	t.Helper()
	v, err := s.CurrentVerification(ctx)
	if err != nil || v != nil {
		t.Fatalf("want absent verification, got %+v, %v", v, err)
	}
}

func verificationRefused(t *testing.T, s *connector.Service, c context.Context) {
	t.Helper()
	v, err := s.CurrentVerification(c)
	if v != nil {
		t.Fatal("refused verification disclosed", v)
	}
	refused(t, err)
}

type verificationLister struct {
	calls int
	err   error
}

func (*verificationLister) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	return nil, errors.New("unused pure fixture")
}
func (l *verificationLister) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	l.calls++
	if l.err != nil {
		return nil, l.err
	}
	return &port.ListResponse{Entries: []string{"fixture-a", "fixture-b"}, Truncated: true}, nil
}

func TestConnectorVerificationExactProof(t *testing.T) {
	f := verificationActive(t)
	verificationAbsent(t, f.owner)
	if err := f.owner.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge); err != nil {
		t.Fatal(err)
	}
	verificationBegin(t, f)
	f.root.compose(t)
	l, err := f.root.issuer.Admit(ctx, authority.List)
	if err != nil {
		t.Fatal(err)
	}
	b := l.Binding()
	list := &verificationLister{}
	w := workspace.New(l, list, f.clock)
	result, err := w.List(ctx, workspace.ListRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch,
		ParticipantID: b.ParticipantID, TurnID: b.TurnID, WorkspaceID: "work", RelativePath: "README.md", CallID: "go-list-call"})
	if err != nil || result == nil || list.calls != 1 {
		t.Fatal("pure Go List did not finish", result, err)
	}
	observed := f.observation()
	observed.EntryCount, observed.Truncated = uint32(len(result.Entries)), result.Truncated
	snapshots := f.io.snapshots
	if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, observed); err != nil {
		t.Fatal(err)
	}
	v, err := f.owner.CurrentVerification(ctx)
	if err != nil || v == nil || *v != observed {
		t.Fatal("exact Go identity changed", v, err)
	}
	if f.io.snapshots != snapshots+2 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 || list.calls != 1 || f.gate.held {
		t.Fatal("verification skipped current journal, replayed List or leaked the owner gate")
	}
}

func TestConnectorVerificationCrossedFields(t *testing.T) {
	for _, test := range []struct {
		name string
		edit func(*port.ConnectorVerification)
	}{
		{"profile", func(v *port.ConnectorVerification) { v.Host.ProfileID += "-other" }},
		{"backend", func(v *port.ConnectorVerification) { v.Host.BackendGeneration += "-other" }},
		{"build", func(v *port.ConnectorVerification) { v.Host.BuildID += "-other" }},
		{"runtime", func(v *port.ConnectorVerification) { v.Host.RuntimeID += "-other" }},
		{"launch digest", func(v *port.ConnectorVerification) { v.Host.LaunchDigest += "-other" }},
		{"connector generation", func(v *port.ConnectorVerification) { v.Host.ConnectorGeneration++ }},
		{"owner", func(v *port.ConnectorVerification) { v.Binding.OwnerID += "-other" }},
		{"session", func(v *port.ConnectorVerification) { v.Binding.SessionID += "-other" }},
		{"task", func(v *port.ConnectorVerification) { v.Binding.TaskID += "-other" }},
		{"epoch", func(v *port.ConnectorVerification) { v.Binding.TaskEpoch++ }},
		{"participant", func(v *port.ConnectorVerification) { v.Binding.ParticipantID += "-other" }},
		{"turn", func(v *port.ConnectorVerification) { v.Binding.TurnID += "-other" }},
		{"digest", func(v *port.ConnectorVerification) { v.ChallengeDigest[0]++ }},
		{"zero digest", func(v *port.ConnectorVerification) { v.ChallengeDigest = [32]byte{} }},
		{"workspace", func(v *port.ConnectorVerification) { v.WorkspaceID = "unknown" }},
		{"approval without admission", func(v *port.ConnectorVerification) { v.WorkspaceID = "approved-only" }},
		{"empty workspace", func(v *port.ConnectorVerification) { v.WorkspaceID = "" }},
		{"empty call", func(v *port.ConnectorVerification) { v.CallID = "" }},
		{"count", func(v *port.ConnectorVerification) { v.EntryCount = 501 }},
		{"maximum count", func(v *port.ConnectorVerification) { v.EntryCount = ^uint32(0) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := verificationActive(t)
			verificationBegin(t, f)
			v := f.observation()
			test.edit(&v)
			refused(t, f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, v))
			verificationRefused(t, f.owner, ctx)
			if f.io.snapshots == 0 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
				t.Fatal("invalid observation skipped current journal or changed publication")
			}
			if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, f.observation()); err != nil {
				t.Fatal("consumer refusal revoked current owner", err)
			}
		})
	}
	for _, digest := range [][32]byte{{}, {2, 9}} {
		f := verificationActive(t)
		verificationBegin(t, f)
		refused(t, f.owner.RecordVerification(ctx, digest, f.observation()))
		verificationRefused(t, f.owner, ctx)
	}
	// Matching supplied/observed values cannot replace the constructor challenge.
	f := verificationActive(t)
	verificationBegin(t, f)
	v := f.observation()
	v.ChallengeDigest[0]++
	refused(t, f.owner.RecordVerification(ctx, v.ChallengeDigest, v))
	verificationRefused(t, f.owner, ctx)
}

func TestConnectorVerificationCountBoundaries(t *testing.T) {
	for _, count := range []uint32{0, 500} {
		for _, truncated := range []bool{false, true} {
			f := verificationActive(t)
			verificationBegin(t, f)
			v := f.observation()
			v.EntryCount, v.Truncated = count, truncated
			if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, v); err != nil {
				t.Fatal(err)
			}
			out, err := f.owner.CurrentVerification(ctx)
			if err != nil || out == nil || *out != v {
				t.Fatal(out, err)
			}
		}
	}
}

func TestConnectorVerificationImmutableCopyAndDuplicate(t *testing.T) {
	f := verificationActive(t)
	verificationBegin(t, f)
	original := f.observation()
	v := original
	if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, v); err != nil {
		t.Fatal(err)
	}
	v.Host.RuntimeID = "changed-input"
	f.launch.VerificationChallenge[0]++
	f.launch.Admission.Workspaces[0].WorkspaceID = "changed-constructor"
	f.launch.Approval.Workspaces[0].WorkspaceID = "changed-constructor"
	out, err := f.owner.CurrentVerification(ctx)
	if err != nil || out == nil || *out != original {
		t.Fatal("constructor/input aliased", out, err)
	}
	out.Binding.TurnID, out.CallID = "changed-output", "changed-output"
	out.ChallengeDigest[0]++
	out.EntryCount++
	out.Truncated = !out.Truncated
	for i := 0; i < 2; i++ {
		refused(t, f.owner.BeginVerification(ctx, original.ChallengeDigest, original.WorkspaceID, original.CallID))
		if err := f.owner.RecordVerification(ctx, original.ChallengeDigest, original); err != nil {
			t.Fatal("exact duplicate refused", err)
		}
		copy, err := f.owner.CurrentVerification(ctx)
		if err != nil || copy == nil || *copy != original || copy == out {
			t.Fatal("retained value aliased/replaced", copy, err)
		}
	}
	for _, edit := range []func(*port.ConnectorVerification){
		func(v *port.ConnectorVerification) { v.CallID = "competing-call" },
		func(v *port.ConnectorVerification) { v.EntryCount++ },
		func(v *port.ConnectorVerification) { v.Truncated = !v.Truncated },
		func(v *port.ConnectorVerification) { v.WorkspaceID = "other" },
	} {
		other := original
		edit(&other)
		refused(t, f.owner.RecordVerification(ctx, original.ChallengeDigest, other))
	}
	out, err = f.owner.CurrentVerification(ctx)
	if err != nil || out == nil || *out != original || f.io.snapshots == 0 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
		t.Fatal("duplicate/conflict changed proof or skipped current journal", out, err)
	}
}

func TestConnectorVerificationNilAndCancellation(t *testing.T) {
	var missing *connector.Service
	refused(t, missing.CheckVerificationChallenge(ctx, [32]byte{1}))
	refused(t, missing.BeginVerification(ctx, [32]byte{1}, "work", "call"))
	refused(t, missing.RecordVerification(ctx, [32]byte{1}, port.ConnectorVerification{}))
	verificationRefused(t, missing, ctx)
	for _, kind := range []string{"nil", "cancelled", "during guard"} {
		t.Run(kind, func(t *testing.T) {
			f := verificationActive(t)
			c, cancel := context.WithCancel(ctx)
			defer cancel()
			switch kind {
			case "nil":
				c = nil
			case "cancelled":
				cancel()
			default:
				f.guard.check = cancel
			}
			refused(t, f.owner.BeginVerification(c, f.launch.VerificationChallenge, "work", "go-list-call"))
			refused(t, f.owner.RecordVerification(c, f.launch.VerificationChallenge, f.observation()))
			refused(t, f.owner.CheckVerificationChallenge(c, f.launch.VerificationChallenge))
			verificationRefused(t, f.owner, c)
			f.guard.check = nil
			verificationAbsent(t, f.owner)
			verificationBegin(t, f)
			refused(t, f.owner.RecordVerification(c, f.launch.VerificationChallenge, f.observation()))
			verificationRefused(t, f.owner, ctx)
			refused(t, f.owner.BeginVerification(ctx, f.launch.VerificationChallenge, "work", "go-list-call"))
			if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, f.observation()); err != nil {
				t.Fatal("cancelled observation revoked live owner", err)
			}
			verificationRefused(t, f.owner, c)
		})
	}
}

func TestConnectorVerificationLateWithdrawnUnavailableAndExpired(t *testing.T) {
	for _, retained := range []bool{false, true} {
		for _, kind := range []string{"withdrawn", "host lost", "guard unavailable", "approval expired"} {
			t.Run(kind+"/"+map[bool]string{false: "unobserved", true: "retained"}[retained], func(t *testing.T) {
				f := verificationActive(t)
				verificationBegin(t, f)
				v := f.observation()
				if retained {
					if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
						t.Fatal(err)
					}
				}
				switch kind {
				case "withdrawn":
					if err := f.owner.Withdraw(ctx); err != nil {
						t.Fatal(err)
					}
				case "host lost":
					f.guard.current = false
				case "guard unavailable":
					f.guard.err = errors.New("fixture unavailable")
				case "approval expired":
					f.clock.advance(time.Hour)
				}
				refused(t, f.owner.RecordVerification(ctx, v.ChallengeDigest, v))
				refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
				refused(t, f.owner.CheckVerificationChallenge(ctx, v.ChallengeDigest))
				verificationRefused(t, f.owner, ctx)
				if kind == "host lost" || kind == "guard unavailable" {
					f.guard.current, f.guard.err = true, nil
					verificationRefused(t, f.owner, ctx)
					refused(t, f.owner.RecordVerification(ctx, v.ChallengeDigest, v))
				}
			})
		}
	}
}

func TestConnectorVerificationPendingUnsupportedAndReconstructedOwner(t *testing.T) {
	f := newVerificationFixture(t)
	verificationAbsent(t, f.owner)
	refused(t, f.owner.BeginVerification(ctx, f.launch.VerificationChallenge, "work", "go-list-call"))
	refused(t, f.owner.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge))
	refused(t, f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, f.observation()))
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	verificationBegin(t, f)
	if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, f.observation()); err != nil {
		t.Fatal(err)
	}
	other, err := connector.New(&verificationGate{}, f.io, f.guard, f.clock, f.launch)
	if err != nil {
		t.Fatal(err)
	}
	f.guard.check = nil
	verificationAbsent(t, other)
	refused(t, other.BeginVerification(ctx, f.launch.VerificationChallenge, "work", "go-list-call"))
	refused(t, other.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge))
	refused(t, other.RecordVerification(ctx, f.launch.VerificationChallenge, f.observation()))
	refused(t, other.Publish(ctx))
	verificationRefused(t, other, ctx)

	legacy := newFixture(t)
	if err := legacy.owner.Publish(ctx); err != nil {
		t.Fatal("zero-challenge legacy publication changed", err)
	}
	verificationAbsent(t, legacy.owner)
	refused(t, legacy.owner.BeginVerification(ctx, [32]byte{}, "work", "go-list-call"))
	refused(t, legacy.owner.CheckVerificationChallenge(ctx, [32]byte{}))
	refused(t, legacy.owner.RecordVerification(ctx, [32]byte{}, port.ConnectorVerification{}))
	if _, err := legacy.owner.Reconnect(ctx); err != nil {
		t.Fatal("zero-challenge legacy reconnect changed", err)
	}
}

func TestConnectorVerificationChallengePreflight(t *testing.T) {
	f := verificationActive(t)
	list := &verificationLister{}
	for _, digest := range [][32]byte{{}, {2, 9}} {
		// Root's pure preflight fixture never reaches List with a wrong digest.
		if err := f.owner.CheckVerificationChallenge(ctx, digest); err == nil {
			_, _ = list.List(ctx, port.ListRequest{})
			t.Fatal("wrong challenge admitted List")
		} else {
			refused(t, err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := f.owner.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge); err != nil {
			t.Fatal("exact challenge refused", err)
		}
		verificationAbsent(t, f.owner)
	}
	if list.calls != 0 || f.io.snapshots != 6 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 || f.gate.held {
		t.Fatal("preflight recorded proof, missed journal checks or leaked gate")
	}
	verificationBegin(t, f)
	if err := f.owner.RecordVerification(ctx, f.launch.VerificationChallenge, f.observation()); err != nil {
		t.Fatal(err)
	}
	if err := f.owner.CheckVerificationChallenge(ctx, f.launch.VerificationChallenge); err != nil {
		t.Fatal("retained observation changed preflight", err)
	}
}

func TestConnectorVerificationPublishingAndLateCompletion(t *testing.T) {
	f := newVerificationFixture(t)
	v := f.observation()
	f.journal.publishHook = func() {
		verificationAbsent(t, f.owner)
		refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
		refused(t, f.owner.CheckVerificationChallenge(ctx, v.ChallengeDigest))
		refused(t, f.owner.RecordVerification(ctx, v.ChallengeDigest, v))
		// Pure synchronous fixture: withdrawal precedes the late publication result.
		refused(t, f.owner.Withdraw(ctx))
	}
	refused(t, f.owner.Publish(ctx))
	if f.journal.p == nil {
		t.Fatal("fixture did not complete a late publication")
	}
	verificationRefused(t, f.owner, ctx)
	refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
	refused(t, f.owner.CheckVerificationChallenge(ctx, v.ChallengeDigest))
	refused(t, f.owner.RecordVerification(ctx, v.ChallengeDigest, v))
	if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 1 || f.io.snapshots == 0 {
		t.Fatal("late completion replayed effects or skipped current journal")
	}
}

func TestConnectorVerificationBrokenGuard(t *testing.T) {
	for _, operation := range []string{"check", "begin", "record", "current"} {
		for _, kind := range []string{"silent", "double", "swallowed", "error after callback"} {
			t.Run(operation+"/"+kind, func(t *testing.T) {
				f := newVerificationFixture(t)
				broken := false
				g := guardFunc(func(_ context.Context, _ port.ConnectorHost, cb func(bool) error) error {
					if !f.gate.held {
						t.Fatal("guard entered without owner gate")
					}
					if !broken {
						return cb(true)
					}
					switch kind {
					case "silent":
						return nil
					case "double":
						_ = cb(true)
						_ = cb(true)
						return nil
					case "swallowed":
						_ = cb(false)
						return nil
					default:
						_ = cb(true)
						return errors.New("fixture guard failed after callback")
					}
				})
				s, err := connector.New(f.gate, f.io, g, f.clock, f.launch)
				if err != nil {
					t.Fatal(err)
				}
				if err := s.Publish(ctx); err != nil {
					t.Fatal(err)
				}
				v := f.observation()
				if operation == "record" || operation == "current" {
					if err := s.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID); err != nil {
						t.Fatal(err)
					}
				}
				if operation == "current" {
					if err := s.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
						t.Fatal(err)
					}
				}
				broken = true
				switch operation {
				case "check":
					refused(t, s.CheckVerificationChallenge(ctx, v.ChallengeDigest))
				case "begin":
					refused(t, s.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
				case "record":
					refused(t, s.RecordVerification(ctx, v.ChallengeDigest, v))
				default:
					verificationRefused(t, s, ctx)
				}
				broken = false
				verificationRefused(t, s, ctx)
				refused(t, s.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
				refused(t, s.CheckVerificationChallenge(ctx, v.ChallengeDigest))
				refused(t, s.RecordVerification(ctx, v.ChallengeDigest, v))
				if f.io.snapshots == 0 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 || f.gate.held {
					t.Fatal("broken guard disclosed proof, replayed effects or leaked gate")
				}
			})
		}
	}
}

func TestConnectorVerificationBeginRejectsWithoutConsuming(t *testing.T) {
	for _, test := range []struct {
		name      string
		digest    [32]byte
		workspace string
		call      string
	}{
		{"zero challenge", [32]byte{}, "work", "call"},
		{"wrong challenge", [32]byte{2, 9}, "work", "call"},
		{"empty workspace", [32]byte{1, 9}, "", "call"},
		{"unknown workspace", [32]byte{1, 9}, "unknown", "call"},
		{"unadmitted workspace", [32]byte{1, 9}, "approved-only", "call"},
		{"empty call", [32]byte{1, 9}, "work", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := verificationActive(t)
			refused(t, f.owner.BeginVerification(ctx, test.digest, test.workspace, test.call))
			verificationAbsent(t, f.owner)
			verificationBegin(t, f)
			verificationRefused(t, f.owner, ctx)
			if f.io.snapshots == 0 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 || f.gate.held {
				t.Fatal("Begin skipped current journal or leaked the owner gate")
			}
		})
	}
}

func TestConnectorVerificationAttemptCannotReplay(t *testing.T) {
	for _, kind := range []string{"pending", "known failure", "lost outcome"} {
		t.Run(kind, func(t *testing.T) {
			f := verificationActive(t)
			v := f.observation()
			verificationBegin(t, f)
			verificationRefused(t, f.owner, ctx)
			list := &verificationLister{}
			if kind != "pending" {
				if kind == "known failure" {
					list.err = authority.Fail("WORKSPACE_HELPER_FAILED", "pure-fixture")
				} else {
					list.err = errors.New("pure fixture lost List outcome")
				}
				f.root.compose(t)
				l, err := f.root.issuer.Admit(ctx, authority.List)
				if err != nil {
					t.Fatal(err)
				}
				b := l.Binding()
				w := workspace.New(l, list, f.clock)
				out, err := w.List(ctx, workspace.ListRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch,
					ParticipantID: b.ParticipantID, TurnID: b.TurnID, WorkspaceID: v.WorkspaceID, RelativePath: "README.md", CallID: v.CallID})
				if out != nil || err == nil || list.calls != 1 {
					t.Fatal("fixture did not produce the first failed List", out, err, list.calls)
				}
			}
			out, err := f.owner.CurrentVerification(ctx)
			var unavailable *authority.Failure
			if out != nil || !errors.As(err, &unavailable) || unavailable.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || unavailable.Retry != "never" {
				t.Fatal("unfinished attempt was not classified unavailable without retry", out, err)
			}
			verificationRenew(f, 72*time.Hour) // Known renewal cannot clear any failed or unknown attempt.
			calls, snapshots := list.calls, f.io.snapshots
			for _, next := range []struct{ workspace, call string }{{v.WorkspaceID, v.CallID}, {"other", v.CallID}, {v.WorkspaceID, "next-call"}} {
				verificationRefused(t, f.owner, ctx)
				// A successful challenge check observes identity; it cannot reopen Begin.
				if err := f.owner.CheckVerificationChallenge(ctx, v.ChallengeDigest); err != nil {
					t.Fatal(err)
				}
				refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, next.workspace, next.call))
			}
			verificationRefused(t, f.owner, ctx)
			if list.calls != calls || f.io.snapshots != snapshots+10 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 || f.gate.held {
				t.Fatal("pending/failed attempt replayed List or missed current journal checks")
			}
		})
	}
}

func TestConnectorVerificationRecordRequiresMatchingBegin(t *testing.T) {
	f := verificationActive(t)
	v := f.observation()
	refused(t, f.owner.RecordVerification(ctx, v.ChallengeDigest, v))
	verificationAbsent(t, f.owner)
	verificationBegin(t, f)
	for _, edit := range []func(*port.ConnectorVerification){
		func(out *port.ConnectorVerification) { out.WorkspaceID = "other" },
		func(out *port.ConnectorVerification) { out.CallID = "another-call" },
	} {
		other := v
		edit(&other)
		refused(t, f.owner.RecordVerification(ctx, other.ChallengeDigest, other))
		verificationRefused(t, f.owner, ctx)
		refused(t, f.owner.BeginVerification(ctx, other.ChallengeDigest, other.WorkspaceID, other.CallID))
	}
	// Only the original attempt's successful evidence may complete it. Observing
	// it rechecks current authority and cannot authorize another Begin.
	for i := 0; i < 2; i++ {
		if err := f.owner.RecordVerification(ctx, v.ChallengeDigest, v); err != nil {
			t.Fatal(err)
		}
		out, err := f.owner.CurrentVerification(ctx)
		if err != nil || out == nil || *out != v {
			t.Fatal("matching completed proof changed", out, err)
		}
		refused(t, f.owner.BeginVerification(ctx, v.ChallengeDigest, v.WorkspaceID, v.CallID))
	}
	if f.io.snapshots == 0 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 || f.gate.held {
		t.Fatal("Record or duplicate Begin skipped current journal or replayed effects")
	}
}
