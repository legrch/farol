package mutation

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// All storage, clocks and child producers here are private memory doubles.
// No native filesystem, native process, provider or production constructor runs.
func processFixture() (*Repository, *memory, processsvc.ConnectorReservationScope, processsvc.Intent) {
	r, m, _ := fixture()
	s := processsvc.ConnectorReservationScope{Host: port.ConnectorHost{ProfileID: "profile", BackendGeneration: "backend", BuildID: "build", RuntimeID: "runtime", LaunchDigest: strings.Repeat("b", 64), ConnectorGeneration: 2}, OwnerID: "owner", ComputerID: "computer", CallID: "call", ComputerGeneration: 7, Generation: 4}
	i := processsvc.Intent{OperationID: "op", Binding: port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 3}, ParticipantID: "participant", TurnID: "turn"}, Seal: processsvc.Seal{Digest: strings.Repeat("a", 64), WorkspaceID: "work", Root: "/workspace/code", Cwd: "/workspace/code/sub", RootIdentity: authority.RootIdentity{Device: "12", Inode: "34"}}, Deadline: time.Unix(1900000000, 123456789)}
	return r, m, s, i
}
func processAdapter(t *testing.T, r *Repository, s processsvc.ConnectorReservationScope) processsvc.Reservation {
	t.Helper()
	a, err := r.ConnectorProcessReservation(s)
	if err != nil || a == nil {
		t.Fatal("adapter", err)
	}
	return a
}
func processReceipt(t *testing.T, a processsvc.Reservation, i processsvc.Intent, status processsvc.ReservationStatus) {
	t.Helper()
	out, err := a.Reserve(context.Background(), i)
	if err != nil || out == nil || out.Status != status || out.Intent.OperationID != i.OperationID || out.Intent.Binding != i.Binding || out.Intent.Seal != i.Seal || !out.Intent.Deadline.Equal(i.Deadline) {
		t.Fatalf("receipt: %#v %v", out, err)
	}
}
func TestConnectorProcessFreshDuplicateAndRetainedLifetime(t *testing.T) {
	r, m, s, i := processFixture()
	a := processAdapter(t, r, s)
	if m.checks+m.reads+m.creates+m.replaces != 0 {
		t.Fatal("constructor IO")
	}
	// Caller replacement of the scalar DTO cannot replace the selected scope.
	original := s
	s.Host.LaunchDigest = strings.Repeat("c", 64)
	s.CallID = "changed"
	out, err := a.Reserve(context.Background(), i)
	if err != nil || out.Status != processsvc.Reserved || out.Intent != i {
		t.Fatal("fresh receipt did not retain exact original intent", out, err)
	}
	out.Intent.Seal.Root = "/changed"
	processReceipt(t, a, i, processsvc.Existing)
	processReceipt(t, processAdapter(t, r, original), i, processsvc.Existing)
	if err = r.Close(); err != nil {
		t.Fatal(err)
	}
	// Retained bytes with an independent injected lifetime: no native reopen proof.
	processReceipt(t, processAdapter(t, newRepository(m), original), i, processsvc.Existing)
	if m.creates != 1 || m.replaces != 0 || len(m.files) != 1 {
		t.Fatal("retained operation repeated")
	}
}
func TestConnectorProcessConcurrentAdaptersOnePermit(t *testing.T) {
	r, m, s, i := processFixture()
	out := make(chan processsvc.ReservationStatus, 32)
	errs := make(chan error, 32)
	var wg sync.WaitGroup
	for range 32 {
		a := processAdapter(t, r, s)
		wg.Go(func() {
			receipt, err := a.Reserve(context.Background(), i)
			errs <- err
			if receipt != nil {
				out <- receipt.Status
			}
		})
	}
	wg.Wait()
	close(out)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	fresh, existing := 0, 0
	for status := range out {
		if status == processsvc.Reserved {
			fresh++
		} else if status == processsvc.Existing {
			existing++
		}
	}
	if fresh != 1 || existing != 31 || m.creates != 1 || m.replaces != 0 {
		t.Fatal("concurrency minted permits", fresh, existing)
	}
}

func processChanges() map[string]func(*processsvc.ConnectorReservationScope, *processsvc.Intent) {
	return map[string]func(*processsvc.ConnectorReservationScope, *processsvc.Intent){
		"backend": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.BackendGeneration += "2" },
		"build":   func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.BuildID += "2" },
		"runtime": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.RuntimeID += "2" },
		"host-seal": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) {
			s.Host.LaunchDigest = strings.Repeat("d", 64)
		},
		"connector-generation": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.ConnectorGeneration++ },
		"computer-generation":  func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.ComputerGeneration++ },
		"generation":           func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Generation++ },
		"call":                 func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.CallID += "2" },
		"session":              func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.SessionID += "2" },
		"task":                 func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.TaskID += "2" },
		"epoch":                func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.TaskEpoch++ },
		"participant":          func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.ParticipantID += "2" },
		"turn":                 func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.TurnID += "2" },
		"seal": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Seal.Digest = strings.Repeat("e", 64)
		},
		"workspace": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.WorkspaceID += "2" },
		"root": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Seal.Root += "2"
			i.Seal.Cwd = i.Seal.Root
		},
		"cwd":    func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Cwd += "2" },
		"device": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.RootIdentity.Device = "13" },
		"inode":  func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.RootIdentity.Inode = "35" },
		"write":  func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Write = true },
		"deadline": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Deadline = i.Deadline.Add(time.Nanosecond)
		},
	}
}
func TestConnectorProcessChangedScopeIntentCannotRepeat(t *testing.T) {
	for name, change := range processChanges() {
		t.Run(name, func(t *testing.T) {
			r, m, s, i := processFixture()
			original := i
			a := processAdapter(t, r, s)
			processReceipt(t, a, i, processsvc.Reserved)
			key, _ := recordKey(processIdentity(s, i.OperationID))
			before := bytes.Clone(m.files[key])
			change(&s, &i)
			out, err := processAdapter(t, r, s).Reserve(context.Background(), i)
			code(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
			if out != nil || m.creates != 1 || m.replaces != 0 || !bytes.Equal(before, m.files[key]) || r.fenced {
				t.Fatal("conflict wrote or changed lifetime")
			}
			processReceipt(t, a, original, processsvc.Existing)
		})
	}
}
func TestConnectorProcessCrossKindStableKey(t *testing.T) {
	for _, kind := range []domain.Kind{domain.WriteKind, domain.EditKind} {
		for _, processFirst := range []bool{true, false} {
			t.Run(string(kind)+map[bool]string{true: "-process-first", false: "-mutation-first"}[processFirst], func(t *testing.T) {
				r, m, s, i := processFixture()
				_, _, state := connectorV3Fixture(t)
				b := state.Binding()
				b.Connector.Operation = kind
				state, err := domain.NewPrepared(b)
				if err != nil {
					t.Fatal(err)
				}
				key, _ := recordKey(b.Identity)
				processKey, _ := recordKey(processIdentity(s, i.OperationID))
				if key != processKey {
					t.Fatal("separate kind namespace")
				}
				a := processAdapter(t, r, s)
				if processFirst {
					processReceipt(t, a, i, processsvc.Reserved)
					out, err := r.Admit(context.Background(), state)
					code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
					if out.Record != nil || out.Status != "" {
						t.Fatal("legacy admitted v4")
					}
				} else {
					admitted(t, r, state)
					out, err := a.Reserve(context.Background(), i)
					code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
					if out != nil {
						t.Fatal("process admitted v3")
					}
				}
				if m.creates != 1 || m.replaces != 0 || len(m.files) != 1 {
					t.Fatal("cross-kind effect")
				}
			})
		}
	}
}
func TestConnectorProcessPublicationFaultFencesSameRepository(t *testing.T) {
	for _, mode := range []string{"lost-ack-invisible", "lost-ack-visible", "substitution", "valid-substitution", "missing", "cancel-create", "check-create", "readback-error", "cancel-readback", "check-readback"} {
		t.Run(mode, func(t *testing.T) {
			r, m, s, i := processFixture()
			a := processAdapter(t, r, s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "lost-ack-invisible", "lost-ack-visible":
				m.createErr = errors.New("private lost ack")
				m.visibleBeforeError = mode == "lost-ack-visible"
			case "substitution":
				m.crossed = true
			case "valid-substitution":
				m.afterCreate = func() {
					changed := i
					changed.Seal.Digest = strings.Repeat("f", 64)
					raw, _ := encodeProcess(s, changed)
					key, _ := recordKey(processIdentity(s, i.OperationID))
					m.files[key] = raw
				}
			case "missing":
				m.afterCreate = func() { key, _ := recordKey(processIdentity(s, i.OperationID)); delete(m.files, key) }
			case "cancel-create":
				m.afterCreate = cancel
			case "check-create":
				m.afterCreate = func() { m.checkErr = errors.New("private root changed") }
			case "readback-error":
				m.afterCreate = func() { m.readErr = errors.New("private readback failed") }
			case "cancel-readback":
				m.afterRead = func() {
					if m.reads == 2 {
						cancel()
					}
				}
			case "check-readback":
				m.afterRead = func() {
					if m.reads == 2 {
						m.checkErr = errors.New("private changed")
					}
				}
			}
			out, err := a.Reserve(ctx, i)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if out != nil || !r.fenced {
				t.Fatal("unknown returned permit")
			}
			checks, reads := m.checks, m.reads
			_, err = processAdapter(t, r, s).Reserve(context.Background(), i)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			_, _, ordinary := fixture()
			_, err = r.Admit(context.Background(), ordinary)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			_, err = r.Load(context.Background(), ordinary.Binding().Identity)
			code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			code(t, r.Save(context.Background(), completed(t, ordinary)), "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
			if m.creates != 1 || m.replaces != 0 || m.checks != checks || m.reads != reads {
				t.Fatal("fenced repository retried IO")
			}
		})
	}
}
func TestConnectorProcessRaceNeverMintsFreshPermit(t *testing.T) {
	for _, mode := range []string{"visible", "missing", "corrupt", "changed", "cancel", "check", "late-visible", "read-error"} {
		t.Run(mode, func(t *testing.T) {
			r, m, s, i := processFixture()
			a := processAdapter(t, r, s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			m.createErr = errExists
			m.visibleBeforeError = mode != "missing" && mode != "late-visible"
			switch mode {
			case "corrupt":
				m.crossed = true
			case "changed":
				m.afterCreate = func() {
					changed := i
					changed.Binding.TurnID += "2"
					raw, _ := encodeProcess(s, changed)
					key, _ := recordKey(processIdentity(s, i.OperationID))
					m.files[key] = raw
				}
			case "cancel":
				m.afterCreate = cancel
			case "check":
				m.afterCreate = func() { m.checkErr = errors.New("changed") }
			case "late-visible":
				m.afterRead = func() {
					if m.reads == 2 {
						raw, _ := encodeProcess(s, i)
						key, _ := recordKey(processIdentity(s, i.OperationID))
						m.files[key] = raw
					}
				}
			case "read-error":
				m.afterCreate = func() { m.readErr = errors.New("failed") }
			}
			out, err := a.Reserve(ctx, i)
			switch mode {
			case "visible":
				if err != nil || out == nil || out.Status != processsvc.Existing || r.fenced {
					t.Fatal("race became fresh", out, err)
				}
			case "changed":
				code(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
				if out != nil || r.fenced {
					t.Fatal("conflict became permit")
				}
			default:
				code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
				if out != nil || !r.fenced {
					t.Fatal("race not fenced")
				}
			}
			if m.creates != 1 || m.replaces != 0 {
				t.Fatal("race repeated")
			}
		})
	}
}
func TestConnectorProcessBeforeCreateAndClose(t *testing.T) {
	for _, mode := range []string{"nil-context", "cancelled", "check", "read", "cancel-read", "check-after-read", "close", "close-error", "malformed"} {
		t.Run(mode, func(t *testing.T) {
			r, m, s, i := processFixture()
			a := processAdapter(t, r, s)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			want := "COMPUTER_MUTATION_STORE_UNAVAILABLE"
			switch mode {
			case "nil-context":
				ctx = nil
				want = "WORKSPACE_MUTATION_CANCELLED"
			case "cancelled":
				cancel()
				want = "WORKSPACE_MUTATION_CANCELLED"
			case "check":
				m.checkErr = errors.New("private check failed")
			case "read":
				m.readErr = errors.New("private read failed")
			case "cancel-read":
				m.afterRead = cancel
				want = "WORKSPACE_MUTATION_CANCELLED"
			case "check-after-read":
				m.afterRead = func() { m.checkErr = errors.New("failed") }
			case "close", "close-error":
				if mode == "close-error" {
					m.closeErr = errors.New("private close failed")
				}
				first := r.Close()
				second := r.Close()
				if first != second || m.closes != 1 {
					t.Fatal("close did not retain result")
				}
			case "malformed":
				key, _ := recordKey(processIdentity(s, i.OperationID))
				m.files[key] = []byte("bad")
				want = "WORKSPACE_MUTATION_STATE_CORRUPT"
			}
			out, err := a.Reserve(ctx, i)
			code(t, err, want)
			if out != nil || m.creates != 0 || m.replaces != 0 || r.fenced {
				t.Fatal("pre-create refusal changed store")
			}
		})
	}
	var nilRepo *Repository
	_, _, s, _ := processFixture()
	_, err := nilRepo.ConnectorProcessReservation(s)
	code(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
}

type processTestLease struct {
	intent processsvc.Intent
	p      authority.Participant
	a      authority.Approval
}

func (e *processTestLease) Binding() port.TaskBinding { return e.intent.Binding }
func (e *processTestLease) Deadline() time.Time       { return e.intent.Deadline }
func (e *processTestLease) WithSnapshot(_ context.Context, _ string, inspect func(port.AccessSnapshot) error) error {
	p, a := e.p.Clone(), e.a.Clone()
	return inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
}

type processTestClock struct{ now time.Time }

func (c processTestClock) Now() time.Time { return c.now }

type processTestSelected struct {
	seal     processsvc.Seal
	calls    int
	err      error
	child    *processTestChild
	deadline time.Time
}

var _ processsvc.Selected = (*processTestSelected)(nil)

func (p *processTestSelected) Seal() processsvc.Seal { return p.seal }
func (p *processTestSelected) Invocation() processsvc.Invocation {
	return processsvc.Invocation{RuntimeID: "runtime", SessionID: "selected-session", ModelID: "selected-model", AdmissionID: "authority"}
}
func (p *processTestSelected) Spawn(ctx context.Context, req processsvc.SpawnRequest) (processsvc.Child, error) {
	p.calls++
	p.deadline = req.Deadline
	if err := req.Check(ctx); err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	if p.err != nil {
		return nil, p.err
	}
	return p.child, nil
}

type processTestChild struct{ reads int }

func (c *processTestChild) Handle() string { return "selected-child" }
func (c *processTestChild) Read(context.Context, processsvc.Window) (*processsvc.Observation, error) {
	c.reads++
	// Root wait without cohort proof is deliberately insufficient for terminal.
	exitCode := 0
	return &processsvc.Observation{Handle: c.Handle(), Root: processsvc.RootExited, Waited: true, ExitCode: &exitCode, OutputDrained: true, GroupCleanup: processsvc.CleanupUnverified, DescendantCleanup: processsvc.CleanupUnverified}, nil
}
func (c *processTestChild) Cancel(context.Context) (*processsvc.CancelReceipt, error) {
	return &processsvc.CancelReceipt{Handle: c.Handle(), Status: processsvc.CancelRequested}, nil
}
func processServiceFixture(i processsvc.Intent, s processsvc.ConnectorReservationScope) (*processTestLease, *processTestSelected, processTestClock) {
	policy := authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: i.Seal.WorkspaceID, Root: i.Seal.Root, Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands, Network: authority.NoNetwork, ExpiresAt: i.Deadline.Add(time.Hour)}
	e := &processTestLease{intent: i, p: authority.Participant{ParticipantID: i.Binding.ParticipantID, Role: authority.Main, MutationOwnership: authority.NoOwnership, Grant: authority.Grant{Identity: i.Binding.Identity, AuthorityID: "authority", ComputerID: s.ComputerID, ComputerGeneration: s.ComputerGeneration, Policy: policy}},
		a: authority.Approval{OwnerID: s.OwnerID, ComputerID: s.ComputerID, Generation: s.ComputerGeneration, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: i.Seal.WorkspaceID, Root: i.Seal.Root, Access: authority.ReadAccess, RootIdentity: i.Seal.RootIdentity, ShellVerified: true}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands, Network: authority.NoNetwork, ExpiresAt: policy.ExpiresAt}}
	return e, &processTestSelected{seal: i.Seal, child: &processTestChild{}}, processTestClock{i.Deadline.Add(-time.Second)}
}
func TestConnectorProcessServiceRetainedReservationCannotSpawnAgain(t *testing.T) {
	for _, mode := range []string{"started", "lost-spawn-ack", "lost-reserve-ack", "incomplete-cohort"} {
		t.Run(mode, func(t *testing.T) {
			r, m, s, i := processFixture()
			e, p, clock := processServiceFixture(i, s)
			if mode == "lost-spawn-ack" {
				p.err = &processsvc.NativeFailure{Unknown: true}
			}
			if mode == "lost-reserve-ack" {
				m.createErr = errors.New("lost ack")
				m.visibleBeforeError = true
			}
			service, err := processsvc.New(i.OperationID, e, p, processAdapter(t, r, s), &sync.Mutex{}, clock)
			if err != nil {
				t.Fatal(err)
			}
			out, first := service.Start(context.Background(), processsvc.StartRequest{OperationID: i.OperationID})
			if mode == "started" || mode == "incomplete-cohort" {
				if first != nil || out == nil || out.Handle != "selected-child" || p.calls != 1 || p.deadline != i.Deadline {
					t.Fatal("first start", out, first)
				}
				if mode == "incomplete-cohort" {
					read, err := service.Read(context.Background(), processsvc.ReadRequest{Handle: "selected-child"})
					if err != nil || read == nil || read.State != processsvc.Unknown {
						t.Fatal("reservation implied terminal", read, err)
					}
				}
			} else {
				var f *processsvc.Failure
				if out != nil || !errors.As(first, &f) || !f.Unknown {
					t.Fatal("original uncertainty lost", first)
				}
				_, second := service.Start(context.Background(), processsvc.StartRequest{OperationID: i.OperationID})
				if second != first {
					t.Fatal("original unknown forgotten")
				}
			}
			// Only known retained injected bytes are supplied to this observation.
			// This does not authorize recovering a real lost-ACK repository lifetime.
			successor := newRepository(m)
			fresh := processAdapter(t, successor, s)
			processReceipt(t, fresh, i, processsvc.Existing)
			restarted, err := processsvc.New(i.OperationID, e, p, fresh, &sync.Mutex{}, clock)
			if err != nil {
				t.Fatal(err)
			}
			out, err = restarted.Start(context.Background(), processsvc.StartRequest{OperationID: i.OperationID})
			var f *processsvc.Failure
			if out != nil || !errors.As(err, &f) || !f.Unknown || f.Code != "PROCESS_RESERVATION_UNKNOWN" {
				t.Fatal("restart minted permission", out, err)
			}
			wantCalls := 1
			if mode == "lost-reserve-ack" {
				wantCalls = 0
			}
			if p.calls != wantCalls || m.creates != 1 || m.replaces != 0 {
				t.Fatal("retained operation spawned again")
			}
		})
	}
}

func TestConnectorProcessOrdinaryFenceAlsoBlocksReservation(t *testing.T) {
	r, m, s, i := processFixture()
	_, _, state := fixture()
	m.createErr = errors.New("lost ordinary ACK")
	_, err := r.Admit(context.Background(), state)
	code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	beforeChecks, beforeReads := m.checks, m.reads
	out, err := processAdapter(t, r, s).Reserve(context.Background(), i)
	code(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if out != nil || m.creates != 1 || m.replaces != 0 || m.checks != beforeChecks || m.reads != beforeReads {
		t.Fatal("process escaped shared ordinary fence")
	}
}

func TestConnectorProcessConcurrentCrossKindHasOnePublication(t *testing.T) {
	r, m, s, i := processFixture()
	_, _, state := connectorV3Fixture(t)
	a := processAdapter(t, r, s)
	var wg sync.WaitGroup
	fresh := make(chan bool, 2)
	errs := make(chan error, 2)
	wg.Go(func() {
		out, err := a.Reserve(context.Background(), i)
		fresh <- out != nil && out.Status == processsvc.Reserved
		errs <- err
	})
	wg.Go(func() {
		out, err := r.Admit(context.Background(), state)
		fresh <- out.Status == port.MutationAdmitted
		errs <- err
	})
	wg.Wait()
	close(fresh)
	close(errs)
	permits, refused := 0, 0
	for permitted := range fresh {
		if permitted {
			permits++
		}
	}
	for err := range errs {
		if err != nil {
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
			refused++
		}
	}
	if permits != 1 || refused != 1 || m.creates != 1 || m.replaces != 0 || len(m.files) != 1 {
		t.Fatal("cross-kind race minted two permits", permits, refused)
	}
}
