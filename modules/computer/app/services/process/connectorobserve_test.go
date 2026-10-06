package process

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	executionsvc "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// All authorities, physical observations, reservations and children in this
// file are labelled in-memory doubles. No native IO/qualification, spawned
// process, signals, provider or durable repository is exercised.
type connectorReadDouble struct {
	ObservationAuthority
	selected ConnectorReadScope
}

func (d *connectorReadDouble) ConnectorScope() ConnectorReadScope { return d.selected }

func connectorScopeDouble() ConnectorReservationScope {
	return ConnectorReservationScope{Host: port.ConnectorHost{ProfileID: "profile", BackendGeneration: "backend", BuildID: "build", RuntimeID: "runtime", LaunchDigest: strings.Repeat("b", 64), ConnectorGeneration: 2},
		OwnerID: "owner", ComputerID: "computer", CallID: "original-call", ComputerGeneration: 4, Generation: 7}
}

func connectorPreparedDouble(t *testing.T) (*Service, *preparerDouble, *clock, *execution, *reservation, PrepareRequest) {
	t.Helper()
	_, builder, c, original, r, request := prepareSetup(t)
	scope := connectorScopeDouble()
	s, err := NewForConnectorInvocation("operation", scope, original, builder, r, &sync.Mutex{}, c)
	if err != nil {
		t.Fatal(err)
	}
	// Constructor copied original correlation before any preparation/effect.
	scope.Host.ProfileID = "caller-replacement"
	if s.connector.Host.ProfileID != "profile" || builder.calls != 0 || r.calls != 0 {
		t.Fatal("constructor did IO or retained mutable input")
	}
	if _, err := s.Prepare(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	start(t, s)
	return s, builder, c, original, r, request
}

func connectorReadSelectionDouble(c *clock, original *execution) (*connectorReadDouble, *execution) {
	read := readAuthority(c, original)
	read.binding.SessionID = "reconnected-session"
	read.binding.TaskID = "reconnected-work"
	read.binding.TaskEpoch++
	read.binding.ParticipantID = "reconnected-participant"
	read.binding.TurnID = "reconnected-turn"
	read.p.ParticipantID = read.binding.ParticipantID
	read.p.Grant.Identity = read.binding.Identity
	read.p.Grant.AuthorityID = "reconnected-admission"
	read.p.Grant.ComputerGeneration = 9
	read.a.Generation = 9
	host := connectorScopeDouble().Host
	host.BackendGeneration = "later-backend"
	host.BuildID = "later-build"
	host.RuntimeID = "later-runtime"
	host.LaunchDigest = strings.Repeat("c", 64)
	host.ConnectorGeneration = 12
	return &connectorReadDouble{ObservationAuthority: read, selected: ConnectorReadScope{host, "owner", "computer", 9}}, read
}

func TestConnectorObserveRetainsSelectedChildAcrossIndependentReadLifetime(t *testing.T) {
	s, builder, c, original, r, _ := connectorPreparedDouble(t)
	intent, invocation, origin, child := s.intent, s.invocation.Clone(), *s.connector, s.child
	c.now = intent.Deadline.Add(time.Millisecond)
	selection, access := connectorReadSelectionDouble(c, original)
	// Use the real existing issuer's Admit(Read) with a labelled current admission
	// double, so the new correlation is an admitted READ lease, not a new executor.
	admission := &observationAdmission{binding: access.binding}
	issuer, err := executionsvc.New(access, admission, c, executionsvc.Ceiling{Participant: access.p.Clone(), Approval: access.a.Clone()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := issuer.Admit(context.Background(), authority.Read)
	if err != nil {
		t.Fatal(err)
	}
	selection.ObservationAuthority = lease
	workspace := workspaceFixture(s, access)
	o, err := s.ConnectorObserver(selection, workspace)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := s.Observer(lease, workspace); out != nil || err == nil {
		t.Fatal("Task/Chat observer accepted a rebind")
	}
	if out, err := s.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil {
		t.Fatal("execution expiry was reset")
	}
	builder.selected.child.afterRead = func() {
		if access.inCallback || original.inCallback {
			t.Fatal("child IO under authority owner")
		}
		gate := s.gate.(*sync.Mutex)
		if !gate.TryLock() {
			t.Fatal("child IO under app gate")
		}
		gate.Unlock()
	}
	workspace.before = func() {
		gate := s.gate.(*sync.Mutex)
		if !gate.TryLock() {
			t.Fatal("physical observation under app gate")
		}
		gate.Unlock()
	}
	out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
	if err != nil || out.State != Running || workspace.calls != 2 || builder.selected.child.reads != 1 {
		t.Fatal(out, err)
	}
	if !sameIntent(intent, s.intent) || !sameInvocation(invocation, *s.invocation) || *s.connector != origin || s.child != child ||
		!builder.selected.deadline.Equal(intent.Deadline) || builder.calls != 1 || builder.selected.calls != 1 || r.calls != 1 || builder.selected.child.cancels != 0 {
		t.Fatal("read changed original intent, provenance, child or effects")
	}
	shape := reflect.TypeOf(o)
	if shape.NumMethod() != 1 || shape.Method(0).Name != "Read" {
		t.Fatal("observer exposes effects")
	}
	admission.withdrawn = true
	if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil || builder.selected.child.reads != 1 {
		t.Fatal("withdrawn current issuer read the child")
	}
}

func TestConnectorObserveRejectsForeignSelectionWithoutIO(t *testing.T) {
	for _, mode := range []string{"owner", "profile", "computer", "missing-original", "invalid-host", "unbounded-read"} {
		t.Run(mode, func(t *testing.T) {
			s, builder, c, original, _, _ := connectorPreparedDouble(t)
			c.now = s.intent.Deadline
			selection, read := connectorReadSelectionDouble(c, original)
			workspace := workspaceFixture(s, read)
			switch mode {
			case "owner":
				selection.selected.OwnerID = "foreign"
			case "profile":
				selection.selected.Host.ProfileID = "foreign"
			case "computer":
				selection.selected.ComputerID = "foreign"
			case "missing-original":
				s, _, _, _, _ = setup(t)
			case "invalid-host":
				selection.selected.Host.ConnectorGeneration = 0
			case "unbounded-read":
				read.deadline = c.now.Add(time.Hour)
			}
			if out, err := s.ConnectorObserver(selection, workspace); out != nil || err == nil || workspace.calls != 0 || builder.selected.child.reads != 0 {
				t.Fatal("foreign or retrospective selection accepted", out, err)
			}
		})
	}
}

func TestConnectorObserveCurrentDenialsFenceProbeChildAndDisclosure(t *testing.T) {
	for _, mode := range []string{"owner", "computer", "stale-generation", "generation-pair", "root", "physical-root", "cwd", "no-read", "withdrawn", "uncertain", "zero", "twice", "binding-drift", "scope-drift", "deadline-drift", "expired", "denied-during-probe", "denied-during-child", "expired-during-child", "profile-during-child", "generation-during-child", "physical-root-after-child", "late-denial"} {
		t.Run(mode, func(t *testing.T) {
			s, builder, c, original, r, _ := connectorPreparedDouble(t)
			c.now = s.intent.Deadline
			selection, read := connectorReadSelectionDouble(c, original)
			workspace := workspaceFixture(s, read)
			o, err := s.ConnectorObserver(selection, workspace)
			if err != nil {
				t.Fatal(err)
			}
			wantReads, wantProbes := 0, 0
			switch mode {
			case "owner":
				read.p.Grant.OwnerID = "foreign"
			case "computer":
				read.a.ComputerID = "foreign"
				read.p.Grant.ComputerID = "foreign"
			case "stale-generation":
				read.p.Grant.ComputerGeneration--
				read.a.Generation--
			case "generation-pair":
				read.a.Generation++
			case "root":
				read.a.Workspaces[0].RootIdentity.Inode = "3"
			case "physical-root":
				workspace.value.RootIdentity.Inode = "3"
				wantProbes = 1
			case "cwd":
				read.p.Grant.Workspaces[0].Root = "/workspace/code/elsewhere"
			case "no-read":
				read.p.Grant.Capabilities = nil
			case "withdrawn":
				read.revoked = true
			case "uncertain":
				read.rawError = errors.New("private shared state uncertain")
			case "zero":
				read.count = -1
			case "twice":
				read.count = 2
			case "binding-drift":
				read.binding.TurnID = "stale-turn"
			case "scope-drift":
				selection.selected.Host.ConnectorGeneration--
			case "deadline-drift":
				read.deadline = read.deadline.Add(time.Second)
			case "expired":
				c.now = read.deadline
			case "denied-during-probe":
				workspace.before = func() { read.revoked = true }
				wantProbes = 1
			case "denied-during-child":
				builder.selected.child.afterRead = func() { read.revoked = true }
				wantReads, wantProbes = 1, 1
			case "expired-during-child":
				builder.selected.child.afterRead = func() { c.now = read.deadline }
				wantReads, wantProbes = 1, 1
			case "profile-during-child":
				builder.selected.child.afterRead = func() { selection.selected.Host.ProfileID = "foreign" }
				wantReads, wantProbes = 1, 1
			case "generation-during-child":
				builder.selected.child.afterRead = func() { read.a.Generation++; read.p.Grant.ComputerGeneration++ }
				wantReads, wantProbes = 1, 1
			case "physical-root-after-child":
				builder.selected.child.afterRead = func() { workspace.value.RootIdentity.Inode = "replacement" }
				wantReads, wantProbes = 1, 2
			case "late-denial":
				// Model a port that calls inspect, then reports a late owner refusal
				// only during final disclosure; prepared output must not escape.
				selection.ObservationAuthority = &connectorLateDeniedDouble{execution: read}
				wantReads, wantProbes = 1, 2
			}
			out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"})
			if out != nil || err == nil || workspace.calls != wantProbes || builder.selected.child.reads != wantReads || builder.calls != 1 || builder.selected.calls != 1 || r.calls != 1 || builder.selected.child.cancels != 0 {
				t.Fatal("denial disclosed/read/replayed", out, err, workspace.calls, builder.selected.child.reads)
			}
			if strings.Contains(err.Error(), "private") {
				t.Fatal("private boundary detail leaked")
			}
		})
	}
}

type connectorLateDeniedDouble struct {
	*execution
	calls int
}

func (d *connectorLateDeniedDouble) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	d.calls++
	if err := d.execution.WithSnapshot(ctx, id, inspect); err != nil {
		return err
	}
	if d.calls == 4 {
		return errors.New("private late current-state denial")
	}
	return nil
}

func TestConnectorObserveMissingRetainedChildAndUnknownNeverRearm(t *testing.T) {
	s, builder, c, original, r, _ := connectorPreparedDouble(t)
	c.now = s.intent.Deadline
	selection, read := connectorReadSelectionDouble(c, original)
	o, err := s.ConnectorObserver(selection, workspaceFixture(s, read))
	if err != nil {
		t.Fatal(err)
	}
	builder.selected.child.readError = &NativeFailure{Unknown: true}
	if out, err := o.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil {
		t.Fatal(out)
	} else {
		unknown(t, err)
	}
	builder.selected.child.readError = nil
	code := 0
	builder.selected.child.observation = Observation{Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed, OutputDrained: true}
	// A later independently selected READ owner cannot clear shared uncertainty.
	selection.selected.Host.ConnectorGeneration++
	fresh, err := s.ConnectorObserver(selection, workspaceFixture(s, read))
	if err != nil {
		t.Fatal(err)
	}
	if out, err := fresh.Read(context.Background(), ReadRequest{Handle: "owned-child"}); err != nil || out.State != Unknown {
		t.Fatal("unknown upgraded", out, err)
	}
	// A new service with original constructor provenance still has no retained child.
	cold, err := NewForConnector("operation", *s.connector, original, builder.selected, r, &sync.Mutex{}, c)
	if err != nil {
		t.Fatal(err)
	}
	coldRead, err := cold.ConnectorObserver(selection, workspaceFixture(s, read))
	if err != nil {
		t.Fatal(err)
	}
	if out, err := coldRead.Read(context.Background(), ReadRequest{Handle: "owned-child"}); out != nil || err == nil {
		t.Fatal("cold service restored a child")
	}
	if builder.calls != 1 || builder.selected.calls != 1 || r.calls != 1 || builder.selected.child.cancels != 0 {
		t.Fatal("observation rearmed an effect")
	}
}

func TestConnectorConstructorBindsOriginalComputerBeforeEffects(t *testing.T) {
	for _, invocation := range []bool{false, true} {
		for _, mode := range []string{"owner", "computer", "generation", "invalid-scope"} {
			t.Run(mode+map[bool]string{true: "-invocation", false: "-prepared"}[invocation], func(t *testing.T) {
				_, builder, c, original, r, request := prepareSetup(t)
				selected := connectorScopeDouble()
				switch mode {
				case "owner":
					selected.OwnerID = "foreign"
				case "computer":
					original.p.Grant.ComputerID = "foreign"
					original.a.ComputerID = "foreign"
				case "generation":
					original.p.Grant.ComputerGeneration++
					original.a.Generation++
				case "invalid-scope":
					selected.Host.LaunchDigest = "bad"
				}
				var s *Service
				var err error
				if invocation {
					s, err = NewForConnectorInvocation("operation", selected, original, builder, r, &sync.Mutex{}, c)
				} else {
					s, err = NewForConnector("operation", selected, original, builder.selected, r, &sync.Mutex{}, c)
				}
				if err == nil {
					if invocation {
						_, err = s.Prepare(context.Background(), request)
					} else {
						_, err = s.Start(context.Background(), StartRequest{"operation"})
					}
				}
				if err == nil || builder.calls != 0 || builder.selected.calls != 0 || r.calls != 0 {
					t.Fatal("crossed original selection reached an effect")
				}
			})
		}
	}
}
