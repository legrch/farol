package process

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Results, owners, clocks and physical roots are explicit in-memory doubles.
// There is no Service, Child, admission, repository, native IO or process here.
func retainedFixture(stdout, stderr []byte) (TerminalResult, *connectorReadDouble, *execution, *observedWorkspace, *clock) {
	c := &clock{now: time.UnixMilli(1900000060000)}
	binding := port.TaskBinding{Identity: authority.Identity{OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7}, ParticipantID: "participant", TurnID: "turn"}
	root := authority.RootIdentity{Device: "1", Inode: "2"}
	policy := authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "code", Root: "/workspace/code", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read}, Commands: authority.NoCommands, Network: authority.NoNetwork, ExpiresAt: c.now.Add(authority.OrdinaryExecutionLifetime)}
	original := &execution{binding: binding,
		p: authority.Participant{ParticipantID: binding.ParticipantID, Role: authority.Main, MutationOwnership: authority.NoOwnership, Grant: authority.Grant{Identity: binding.Identity, AuthorityID: "original-admission", ComputerID: "computer", ComputerGeneration: 4, Policy: policy}},
		a: authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 4, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "code", Root: "/workspace/code", RootIdentity: root, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Read}, Commands: authority.NoCommands, Network: authority.NoNetwork, ExpiresAt: policy.ExpiresAt}}
	current, read := connectorReadSelectionDouble(c, original)
	code := 4
	result := TerminalResult{Scope: connectorScopeDouble(),
		Intent: Intent{OperationID: "original-operation", Binding: binding, Deadline: c.now.Add(-time.Minute), Seal: Seal{Digest: strings.Repeat("a", 64), WorkspaceID: "code", Root: "/workspace/code", Cwd: "/workspace/code/subdir", RootIdentity: root}},
		Observation: Observation{Handle: "retained-handle", Root: RootExited, Waited: true, ExitCode: &code, GroupCleanup: CleanupConfirmed, DescendantCleanup: CleanupConfirmed, OutputDrained: true,
			Stdout: stdout, Stderr: stderr, StdoutNext: uint64(len(stdout)), StderrNext: uint64(len(stderr)), StdoutBytes: uint64(len(stdout)), StderrBytes: uint64(len(stderr)),
			OutputLimitReached: true, CancelRequested: true, TimedOut: true, AuthorityLost: true}}
	workspace := &observedWorkspace{value: &ObservedWorkspace{WorkspaceID: "code", Root: "/workspace/code", RootIdentity: root}, e: read}
	return result, current, read, workspace, c
}

func TestRetainedObserverCopiedBoundedWindows(t *testing.T) {
	for _, size := range []int{0, 1, WindowBytes, WindowBytes + 1, MaximumOutput} {
		for _, stream := range []string{"stdout", "stderr", "both"} {
			t.Run(stream+"/"+strconv.Itoa(size), func(t *testing.T) {
				stdout, stderr := bytes.Repeat([]byte{0xff}, size), []byte(nil)
				if stream == "stderr" {
					stdout, stderr = nil, stdout
				} else if stream == "both" {
					stdout, stderr = stdout[:size/2], bytes.Repeat([]byte{0}, size-size/2)
				}
				result, current, _, workspace, c := retainedFixture(stdout, stderr)
				before := result.Clone()
				o, err := NewRetainedObserver(result, current, workspace, c)
				if err != nil || workspace.calls != 0 {
					t.Fatal("constructor performed observation or refused valid value", err)
				}
				request := ReadRequest{Handle: result.Observation.Handle}
				var gotOut, gotErr []byte
				for {
					out, err := o.Read(context.Background(), request)
					if err != nil || out == nil || out.State != Terminal || !validObservation(&out.Observation, request.Handle, Window{request.StdoutOffset, request.StderrOffset}) || !sameTerminalFacts(before.Observation, out.Observation) {
						t.Fatal("invalid retained window", out, err)
					}
					gotOut, gotErr = append(gotOut, out.Observation.Stdout...), append(gotErr, out.Observation.Stderr...)
					if out.Observation.StdoutNext == uint64(len(stdout)) && out.Observation.StderrNext == uint64(len(stderr)) {
						break
					}
					request.StdoutOffset, request.StderrOffset = out.Observation.StdoutNext, out.Observation.StderrNext
				}
				if !bytes.Equal(gotOut, stdout) || !bytes.Equal(gotErr, stderr) || !reflect.DeepEqual(result, before) {
					t.Fatal("read changed original value or lost bytes")
				}
				out, err := o.Read(context.Background(), ReadRequest{Handle: request.Handle, StdoutOffset: uint64(len(stdout)), StderrOffset: uint64(len(stderr))})
				if err != nil || len(out.Observation.Stdout)+len(out.Observation.Stderr) != 0 {
					t.Fatal("EOF window refused", err)
				}
			})
		}
	}
}

func TestRetainedObserverFreshLifetimeAndImmutableCopies(t *testing.T) {
	result, current, _, workspace, c := retainedFixture([]byte("stdout"), []byte("stderr"))
	before := result.Clone()
	if result.Intent.Binding == current.Binding() || result.Scope.Host == current.ConnectorScope().Host || result.Scope.ComputerGeneration == current.ConnectorScope().ComputerGeneration || c.now.Before(result.Intent.Deadline) {
		t.Fatal("fixture lacks independent fresh lifetime")
	}
	o, err := NewRetainedObserver(result, current, workspace, c)
	if err != nil {
		t.Fatal(err)
	}
	result.Scope.Host.ProfileID = "replacement"
	result.Intent.Binding.OwnerID = "replacement"
	result.Intent.Seal.RootIdentity.Inode = "replacement"
	result.Observation.Stdout[0], result.Observation.Stderr[0], *result.Observation.ExitCode = 0, 0, 99
	for i := 0; i < 2; i++ {
		out, err := o.Read(context.Background(), ReadRequest{Handle: before.Observation.Handle})
		if err != nil || !reflect.DeepEqual(out.Observation, before.Observation) {
			t.Fatal("caller or response mutation reached retained value", out, err)
		}
		out.Observation.Stdout[0], out.Observation.Stderr[0], *out.Observation.ExitCode = 1, 1, 88
	}
	shape := reflect.TypeOf(o)
	if shape.NumMethod() != 1 || shape.Method(0).Name != "Read" {
		t.Fatal("retained reader exposes effects")
	}
}

type retainedConcurrentAuthority struct {
	ConnectorObservationAuthority
	gate sync.Mutex
}

func (a *retainedConcurrentAuthority) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	a.gate.Lock()
	defer a.gate.Unlock()
	return a.ConnectorObservationAuthority.WithSnapshot(ctx, id, inspect)
}

type retainedPhysicalValue ObservedWorkspace

func (w retainedPhysicalValue) ObserveWorkspace(context.Context) (*ObservedWorkspace, error) {
	copy := ObservedWorkspace(w)
	return &copy, nil
}

func TestRetainedObserverConcurrentReadsNeverShareOutput(t *testing.T) {
	result, current, _, workspace, c := retainedFixture([]byte("out"), []byte("err"))
	// The current owner serializes its snapshots; physical observation is a
	// separate immutable double, outside that owner gate and with no child.
	o, err := NewRetainedObserver(result, &retainedConcurrentAuthority{ConnectorObservationAuthority: current}, retainedPhysicalValue(*workspace.value), c)
	if err != nil {
		t.Fatal(err)
	}
	var readers sync.WaitGroup
	for i := 0; i < 16; i++ {
		readers.Go(func() {
			for n := 0; n < 4; n++ {
				out, err := o.Read(context.Background(), ReadRequest{Handle: result.Observation.Handle})
				if err != nil || out == nil || !reflect.DeepEqual(out.Observation, result.Observation) {
					t.Error("concurrent retained output changed", err)
					return
				}
				out.Observation.Stdout[0], out.Observation.Stderr[0], *out.Observation.ExitCode = 0, 0, 0
			}
		})
	}
	readers.Wait()
}

func TestRetainedObserverPreservesSignalMetadata(t *testing.T) {
	result, current, _, workspace, c := retainedFixture(nil, nil)
	result.Observation.ExitCode, result.Observation.ExitSignal = nil, 15
	o, err := NewRetainedObserver(result, current, workspace, c)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := o.Read(context.Background(), ReadRequest{Handle: result.Observation.Handle}); err != nil || out == nil || !reflect.DeepEqual(out.Observation, result.Observation) {
		t.Fatal("retained signal facts changed", out, err)
	}
}

func TestRetainedObserverRejectsInvalidConstructorWithoutObservation(t *testing.T) {
	for _, fault := range []string{"owner", "binding-owner", "profile", "computer", "invalid-host", "invalid-binding", "epoch", "expired", "extended", "zero-time", "zero-deadline", "nil-authority", "nil-workspace", "nil-clock", "partial", "cleanup", "missing-handle", "oversized-data", "oversized-combined", "offset", "count", "missing-exit", "root", "cwd", "physical-identity", "old-result"} {
		t.Run(fault, func(t *testing.T) {
			result, selected, read, workspace, c := retainedFixture([]byte("out"), []byte("err"))
			var current ConnectorObservationAuthority = selected
			var physical ObservationWorkspace = workspace
			var timing port.Clock = c
			switch fault {
			case "owner":
				selected.selected.OwnerID = "foreign"
			case "binding-owner":
				read.binding.OwnerID = "foreign"
			case "profile":
				selected.selected.Host.ProfileID = "foreign"
			case "computer":
				selected.selected.ComputerID = "foreign"
			case "invalid-host":
				selected.selected.Host.ConnectorGeneration = 0
			case "invalid-binding":
				read.binding.TurnID = ""
			case "epoch":
				read.binding.TaskEpoch = 9007199254740992
			case "expired":
				read.deadline = c.now
			case "extended":
				read.deadline = c.now.Add(authority.OrdinaryExecutionLifetime + time.Millisecond)
			case "zero-time":
				c.now = time.Time{}
			case "zero-deadline":
				read.deadline = time.Time{}
			case "nil-authority":
				current = nil
			case "nil-workspace":
				physical = nil
			case "nil-clock":
				timing = nil
			case "partial":
				result.Observation.OutputDrained = false
			case "cleanup":
				result.Observation.GroupCleanup = CleanupUnverified
			case "missing-handle":
				result.Observation.Handle = ""
			case "oversized-data":
				result.Observation.Stdout = make([]byte, MaximumOutput+1)
			case "oversized-combined":
				result.Observation.Stdout, result.Observation.Stderr = make([]byte, MaximumOutput), []byte{0}
			case "offset":
				result.Observation.StdoutOffset = 1
			case "count":
				result.Observation.StderrBytes++
			case "missing-exit":
				result.Observation.ExitCode = nil
			case "root":
				result.Intent.Seal.Root = "/elsewhere"
			case "cwd":
				result.Intent.Seal.Cwd = "/elsewhere"
			case "physical-identity":
				result.Intent.Seal.RootIdentity.Inode = "unknown"
			case "old-result":
				result.Observation.Root = RootRunning
			}
			if out, err := NewRetainedObserver(result, current, physical, timing); out != nil || err == nil || workspace.calls != 0 {
				t.Fatal("invalid constructor observed or returned reader", out, err)
			}
		})
	}
}

func TestRetainedObserverRejectsHandleAndOffsetsBeforePhysical(t *testing.T) {
	result, current, _, workspace, c := retainedFixture([]byte("out"), []byte("err"))
	o, err := NewRetainedObserver(result, current, workspace, c)
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []ReadRequest{{}, {Handle: "foreign"}, {Handle: result.Observation.Handle, StdoutOffset: 4}, {Handle: result.Observation.Handle, StderrOffset: 4}, {Handle: result.Observation.Handle, StdoutOffset: MaximumOutput + 1}, {Handle: result.Observation.Handle, StderrOffset: ^uint64(0)}} {
		if out, err := o.Read(context.Background(), request); out != nil || err == nil || workspace.calls != 0 {
			t.Fatal("invalid request disclosed or observed", out, err)
		}
	}
	if out, err := o.Read(nil, ReadRequest{Handle: result.Observation.Handle}); out != nil || err == nil {
		t.Fatal("nil context accepted")
	}
	var absent *RetainedObserver
	if out, err := absent.Read(context.Background(), ReadRequest{}); out != nil || err == nil {
		t.Fatal("nil observer accepted")
	}
}

func TestRetainedObserverCurrentDenialsBeforeAndDuringPhysical(t *testing.T) {
	for _, fault := range []string{"withdrawal", "owner", "approval-owner", "computer", "generation-pair", "stale-generation", "no-read", "approval-no-read", "grant-expiry", "approval-expiry", "binding-drift", "scope-drift", "deadline-drift", "expired", "workspace", "root", "identity", "cwd", "excluded", "raw-error", "zero", "twice", "swallowed-denial"} {
		for _, phase := range []string{"preflight", "physical"} {
			t.Run(fault+"/"+phase, func(t *testing.T) {
				result, current, read, workspace, c := retainedFixture([]byte("out"), []byte("err"))
				o, err := NewRetainedObserver(result, current, workspace, c)
				if err != nil {
					t.Fatal(err)
				}
				change := func() {
					switch fault {
					case "withdrawal":
						read.revoked = true
					case "owner":
						read.p.Grant.OwnerID = "foreign"
					case "approval-owner":
						read.a.OwnerID = "foreign"
					case "computer":
						read.p.Grant.ComputerID, read.a.ComputerID = "foreign", "foreign"
					case "generation-pair":
						read.a.Generation++
					case "stale-generation":
						read.p.Grant.ComputerGeneration--
						read.a.Generation--
					case "no-read":
						read.p.Grant.Capabilities = nil
					case "approval-no-read":
						read.a.Capabilities = nil
					case "grant-expiry":
						read.p.Grant.ExpiresAt = c.now
					case "approval-expiry":
						read.a.ExpiresAt = c.now
					case "binding-drift":
						read.binding.TurnID = "stale"
					case "scope-drift":
						current.selected.Host.ConnectorGeneration++
					case "deadline-drift":
						read.deadline = read.deadline.Add(time.Millisecond)
					case "expired":
						c.now = read.deadline
					case "workspace":
						read.a.Workspaces[0].WorkspaceID = "foreign"
					case "root":
						read.a.Workspaces[0].Root = "/workspace"
					case "identity":
						read.a.Workspaces[0].RootIdentity.Inode = "3"
					case "cwd":
						read.p.Grant.Workspaces[0].Root = "/workspace/code/elsewhere"
					case "excluded":
						read.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "code", Path: result.Intent.Seal.Cwd}}
					case "raw-error":
						read.rawError = errors.New("private owner failure")
					case "zero":
						read.count = -1
					case "twice":
						read.count = 2
					case "swallowed-denial":
						read.revoked = true
						current.ObservationAuthority = swallowedObservation{read}
					}
				}
				wantPhysical := 0
				if phase == "preflight" {
					change()
				} else {
					workspace.before = change
					wantPhysical = 1
				}
				out, err := o.Read(context.Background(), ReadRequest{Handle: result.Observation.Handle})
				if out != nil || err == nil || workspace.calls != wantPhysical || strings.Contains(err.Error(), "private") {
					t.Fatal("current denial disclosed or observed unexpectedly", out, err, workspace.calls)
				}
			})
		}
	}
}

func TestRetainedObserverPhysicalRefusalsAndCancellation(t *testing.T) {
	for _, fault := range []string{"root", "workspace", "device", "inode", "missing", "failure", "cancelled-before", "cancelled-during"} {
		t.Run(fault, func(t *testing.T) {
			result, current, _, workspace, c := retainedFixture(nil, nil)
			o, err := NewRetainedObserver(result, current, workspace, c)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			wantPhysical := 1
			switch fault {
			case "root":
				workspace.value.Root = "/replacement"
			case "workspace":
				workspace.value.WorkspaceID = "replacement"
			case "device":
				workspace.value.RootIdentity.Device = "3"
			case "inode":
				workspace.value.RootIdentity.Inode = "3"
			case "missing":
				workspace.value = nil
			case "failure":
				workspace.err = errors.New("private physical failure")
			case "cancelled-before":
				cancel()
				wantPhysical = 0
			case "cancelled-during":
				workspace.before = cancel
			}
			if out, err := o.Read(ctx, ReadRequest{Handle: result.Observation.Handle}); out != nil || err == nil || workspace.calls != wantPhysical || strings.Contains(err.Error(), "private") {
				t.Fatal("physical refusal disclosed", out, err)
			}
		})
	}
}

type retainedAfterSnapshot struct {
	*execution
	calls, at int
	after     func()
	deny      bool
}

func (a *retainedAfterSnapshot) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	a.calls++
	if err := a.execution.WithSnapshot(ctx, id, inspect); err != nil {
		return err
	}
	if a.calls == a.at {
		if a.after != nil {
			a.after()
		}
		if a.deny {
			return errors.New("private late owner denial")
		}
	}
	return nil
}

func TestRetainedObserverLateSnapshotNeverDiscloses(t *testing.T) {
	for _, at := range []int{1, 2} {
		for _, fault := range []string{"denial", "deadline", "scope", "binding", "expiry", "grant-expiry", "approval-expiry"} {
			t.Run(strconv.Itoa(at)+"/"+fault, func(t *testing.T) {
				result, current, read, workspace, c := retainedFixture([]byte("out"), nil)
				late := &retainedAfterSnapshot{execution: read, at: at, deny: fault == "denial"}
				late.after = func() {
					switch fault {
					case "deadline":
						read.deadline = read.deadline.Add(time.Second)
					case "scope":
						current.selected.Host.RuntimeID = "replacement"
					case "binding":
						read.binding.TaskEpoch++
					case "expiry":
						c.now = read.deadline
					case "grant-expiry":
						read.p.Grant.ExpiresAt = c.now.Add(time.Millisecond)
						c.now = read.p.Grant.ExpiresAt
					case "approval-expiry":
						c.now = read.a.ExpiresAt
					}
				}
				if fault == "grant-expiry" {
					read.p.Grant.ExpiresAt = c.now.Add(time.Millisecond)
				}
				current.ObservationAuthority = late
				o, err := NewRetainedObserver(result, current, workspace, c)
				if err != nil {
					t.Fatal(err)
				}
				out, err := o.Read(context.Background(), ReadRequest{Handle: result.Observation.Handle})
				if out != nil || err == nil || workspace.calls != at-1 || strings.Contains(err.Error(), "private") {
					t.Fatal("late owner callback disclosed", out, err, workspace.calls)
				}
			})
		}
	}
}
