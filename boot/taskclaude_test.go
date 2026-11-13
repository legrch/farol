package boot

// CPU composition: real Task Owner/Service, admission peer, Computer execution
// lease/Service/contract, process peer and Claude Host/parser. Native preparation,
// child output, reservations, route qualification and persistence are controlled
// in-memory boundaries. No CLI, subprocess, filesystem or account is qualified.
import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	execution "github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	admissionpeer "github.com/legrch/farol/modules/computer/infra/peer/admission"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	claude "github.com/legrch/farol/modules/task/infra/clients/claude"
)

const taskClaudeSession = "12345678-1234-1234-1234-123456789abc"
const taskClaudeInit = `{"type":"system","subtype":"init","session_id":"12345678-1234-1234-1234-123456789abc","cwd":"/fixture/writer","model":"selected-runtime-model","permissionMode":"default"}` + "\n"
const taskClaudeDelta = `{"type":"assistant","session_id":"12345678-1234-1234-1234-123456789abc","message":{"content":[{"type":"text","text":"Useful partial"},{"type":"thinking","thinking":"PRIVATE_REASONING"}]}}` + "\n"
const taskClaudeFinal = `{"type":"result","subtype":"success","session_id":"12345678-1234-1234-1234-123456789abc","is_error":false,"permission_denials":[],"result":"Retained Claude result"}` + "\n"

type taskClaudeAccess struct {
	*accessrepo.Repository
	calls int
	fail  bool
}

func (a *taskClaudeAccess) WithSnapshot(ctx context.Context, id string, f func(computerport.AccessSnapshot) error) error {
	a.calls++
	if a.fail {
		return errors.New("controlled access unknown")
	}
	return a.Repository.WithSnapshot(ctx, id, f)
}

type taskClaudeNative struct {
	operation, message                                  string
	resume                                              bool
	t                                                   *testing.T
	scope                                               processsvc.Scope
	invocation                                          processsvc.Invocation
	prepares, reservations, starts, reads               int
	frames                                              []string
	offset                                              uint64
	deadline                                            time.Time
	beforeSpawn                                         func()
	unknownStart, unknownReservation, unverifiedCleanup bool
}

func (n *taskClaudeNative) Scope() processsvc.Scope { return n.scope }
func (n *taskClaudeNative) Prepare(_ context.Context, v processsvc.Invocation) (processsvc.Selected, error) {
	n.prepares++
	flag := "--session-id"
	if n.resume {
		flag = "--resume"
	}
	want := []string{"--print", "--output-format", "stream-json", "--verbose", flag, taskClaudeSession, "--model", "selected-runtime-model", "--permission-mode", "default", "--permission-prompts", "none", "--effort", "high"}
	if n.prepares != 1 || v.RuntimeID != "controlled-cli" || v.SessionID != taskClaudeSession || v.ModelID != "selected-runtime-model" || v.AdmissionID != "authority" || !reflect.DeepEqual(v.Arguments, want) || string(v.Input) != n.message+"\n" {
		n.t.Fatal("foreign or duplicate invocation", v)
	}
	n.invocation = v.Clone()
	return n, nil
}
func (n *taskClaudeNative) Invocation() processsvc.Invocation { return n.invocation.Clone() }
func (n *taskClaudeNative) Seal() processsvc.Seal {
	return processsvc.Seal{Digest: strings.Repeat("a", 64), WorkspaceID: n.scope.WorkspaceID, Root: n.scope.Root, Cwd: n.scope.Cwd, RootIdentity: n.scope.RootIdentity}
}
func (n *taskClaudeNative) Reserve(_ context.Context, i processsvc.Intent) (*processsvc.ReservationReceipt, error) {
	n.reservations++
	if n.reservations != 1 || i.OperationID != n.operation || i.Seal != n.Seal() {
		n.t.Fatal("foreign or duplicate reservation", i)
	}
	if n.unknownReservation {
		return nil, errors.New("controlled publication unknown")
	}
	return &processsvc.ReservationReceipt{Status: processsvc.Reserved, Intent: i}, nil
}
func (n *taskClaudeNative) Spawn(ctx context.Context, q processsvc.SpawnRequest) (processsvc.Child, error) {
	n.deadline = q.Deadline
	if n.beforeSpawn != nil {
		n.beforeSpawn()
	}
	if err := q.Check(ctx); err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	n.starts++
	if n.starts != 1 {
		n.t.Fatal("duplicate child")
	}
	if n.unknownStart {
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	return n, nil
}
func (n *taskClaudeNative) Handle() string { return "controlled-child-" + n.operation }
func (n *taskClaudeNative) Read(_ context.Context, w processsvc.Window) (*processsvc.Observation, error) {
	if w.StdoutOffset != n.offset || w.StderrOffset != 0 || n.reads >= len(n.frames) {
		n.t.Fatal("foreign or extra read", w, n.reads)
	}
	data := []byte(n.frames[n.reads])
	n.reads++
	n.offset += uint64(len(data))
	o := &processsvc.Observation{Handle: n.Handle(), Root: processsvc.RootRunning, GroupCleanup: processsvc.CleanupPending, DescendantCleanup: processsvc.CleanupPending, Stdout: data, StdoutOffset: w.StdoutOffset, StdoutNext: n.offset, StdoutBytes: n.offset}
	if n.reads == len(n.frames) {
		zero := 0
		o.Root = processsvc.RootExited
		o.Waited = true
		o.ExitCode = &zero
		o.OutputDrained = true
		o.GroupCleanup = processsvc.CleanupConfirmed
		o.DescendantCleanup = processsvc.CleanupConfirmed
		if n.unverifiedCleanup {
			o.DescendantCleanup = processsvc.CleanupUnverified
		}
	}
	return o, nil
}
func (n *taskClaudeNative) Cancel(context.Context) (*processsvc.CancelReceipt, error) {
	n.t.Fatal("unqualified signal attempted")
	return nil, errors.New("unavailable")
}

type taskClaudeFixture struct {
	t                  *testing.T
	task               *taskRuntimeTestFixture
	clock              *computerClockFixture
	access             *taskClaudeAccess
	native             *taskClaudeNative
	inputs             TaskRuntimeInputs
	ingress            *TaskIngress
	outputs            []string
	qualificationCalls int
	qualificationError error
}

func taskClaudeSetup(t *testing.T) *taskClaudeFixture {
	t.Helper()
	f := &taskClaudeFixture{t: t, task: taskRuntimeTestNewFixture(t, task.Claude), clock: &computerClockFixture{now: time.UnixMilli(1900000000000)}, access: &taskClaudeAccess{Repository: accessrepo.New()}}
	f.selectInvocation("create-1", false)
	return f
}

func (f *taskClaudeFixture) selectInvocation(operation string, resume bool) {
	t := f.t
	b := f.task.route.Selection()
	identity := authority.Identity{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch}
	policy := authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "writer", Root: "/fixture/writer", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands, Network: authority.NoNetwork, ExpiresAt: f.clock.Now().Add(12 * time.Hour)}
	approval := authority.Approval{OwnerID: b.OwnerID, ComputerID: "computer", Generation: 1, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "writer", Root: "/fixture/writer", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "3"}, ShellVerified: true}}, Capabilities: policy.Capabilities, Commands: policy.Commands, Network: policy.Network, ExpiresAt: policy.ExpiresAt}
	grant, err := authority.Derive(approval, authority.Admission{Identity: identity, AuthorityID: "authority", ComputerID: "computer", ComputerGeneration: 1, Policy: policy}, f.clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	participant, err := authority.Create(*grant, authority.ParticipantAdmission{ParticipantID: b.ParticipantID, Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if err != nil {
		t.Fatal(err)
	}
	f.access.PutApproval(approval)
	f.access.PutParticipant(*participant)
	peer, err := admissionpeer.NewTask(f.task.runtime.Admission())
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := execution.New(f.access, peer, f.clock, execution.Ceiling{Participant: *participant, Approval: approval})
	if err != nil {
		t.Fatal(err)
	}
	message := "initial"
	final := taskClaudeFinal
	if resume {
		message = "followup"
		final = strings.Replace(taskClaudeFinal, "Retained Claude result", "Retained resumed result", 1)
	}
	f.native = &taskClaudeNative{t: t, operation: operation, message: message, resume: resume, scope: processsvc.Scope{RuntimeID: "controlled-cli", WorkspaceID: "writer", Root: "/fixture/writer", Cwd: "/fixture/writer", RootIdentity: approval.Workspaces[0].RootIdentity}, frames: []string{taskClaudeInit + taskClaudeDelta, final}}
	q := claude.Selection{Binding: f.task.taskRuntimeTestAuthority.binding, Scope: task.AdmissionBinding{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID}, RuntimeID: "controlled-cli", AdmissionID: "authority", SessionID: taskClaudeSession, ReportedModel: "selected-runtime-model", Efforts: []claude.EffortMapping{{Requested: "high", Argument: "high"}}, ExactResume: true}
	f.inputs = TaskRuntimeInputs{Route: f.task.route, Binding: q.Binding, Authority: f.task.taskRuntimeTestAuthority, Claude: &ClaudeTaskInputs{Selection: q, OperationID: operation, Process: &ClaudeProcessInputs{Issuer: issuer, Preparer: f.native, Reservations: f.native, Clock: f.clock, Recheck: func(_ context.Context, got claude.Selection) (task.Capabilities, error) {
		f.qualificationCalls++
		if !reflect.DeepEqual(got, q) {
			t.Fatal("qualification identity changed")
		}
		if f.qualificationError != nil {
			return task.Capabilities{}, f.qualificationError
		}
		return task.Capabilities{Create: true, Resume: true, Continue: true, Cancel: true}, nil
	}, Output: func(_ context.Context, ref task.Reference, s string) error {
		if ref.SessionID != taskClaudeSession || ref.InvocationID != operation {
			t.Fatal("uncorrelated output", ref)
		}
		f.outputs = append(f.outputs, s)
		return nil
	}}}}
	f.ingress, err = NewTaskIngress(f.inputs, controlct.Parent{ThreadID: "parent", TurnID: "parent-turn"})
	if err != nil {
		t.Fatal(err)
	}
}
func TestTaskClaudeCommonWireDefersLeaseUntilAdmission(t *testing.T) {
	f := taskClaudeSetup(t)
	p := taskWireTestConnect(t, f.ingress)
	if f.qualificationCalls != 0 || f.access.calls != 0 {
		t.Fatal("constructor performed qualification/admission")
	}
	resolved := taskWireTestData[wire.TaskResolution](t, p.call("task.resolve", "", "{}"), "TaskResolution")
	if !resolved.Capabilities.Create || !resolved.Capabilities.Resume || resolved.Capabilities.Continue || resolved.Capabilities.Cancel || f.access.calls != 0 {
		t.Fatal("unavailable controls or early admission", resolved)
	}
	f.clock.now = f.clock.now.Add(time.Hour)
	admittedAt := f.clock.Now()
	taskWireTestData[wire.TaskMutation](t, p.call("task.create", "create-1", `{"message":"initial"}`), "TaskMutation")
	progress := taskWireTestData[wire.TaskObservation](t, p.call("task.observation.read", "", `{"dispatchId":"create-1","includeResult":true}`), "TaskObservation")
	if progress.Retained || progress.Lifecycle != "running" || len(progress.Events) != 1 || progress.Events[0].Kind != "provider_started" || !reflect.DeepEqual(f.outputs, []string{"Useful partial"}) || f.native.reads != 1 || !f.native.deadline.Equal(admittedAt.Add(authority.OrdinaryExecutionLifetime)) {
		t.Fatal("output or lease ordering", progress, f.outputs, f.native.deadline)
	}
	taskWireTestData[wire.TaskStatus](t, p.call("task.observe", "", "{}"), "TaskStatus")
	result := taskWireTestData[wire.TaskDispatch](t, p.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !result.Retained || result.Text != "Retained Claude result" || result.Delivery != "not_observed" || result.Reference.SessionId == nil || *result.Reference.SessionId != taskClaudeSession {
		t.Fatal("provider report not retained", result)
	}
	// Re-reading after lease expiry serves durable Task state without reminting.
	calls, reads := f.access.calls, f.native.reads
	f.clock.now = f.clock.now.Add(time.Hour)
	again := taskWireTestData[wire.TaskDispatch](t, p.call("task.result", "", `{"dispatchId":"create-1"}`), "TaskDispatch")
	if !reflect.DeepEqual(again, result) || calls != f.access.calls || reads != f.native.reads || f.native.starts != 1 || f.native.reservations != 1 || f.native.prepares != 1 {
		t.Fatal("retained result re-executed")
	}
	frames, _ := json.Marshal(p.frames)
	if strings.Contains(string(frames), "PRIVATE_REASONING") {
		t.Fatal("private reasoning disclosed")
	}
	t.Logf("TASK_WIRE_CONTROLLED_FRAMES %s", frames)
}
func TestTaskClaudeCommonWireUnknownNeverReconstructs(t *testing.T) {
	for _, mode := range []string{"lease", "reservation", "start", "cleanup", "revoke-before-spawn", "expiry-before-spawn"} {
		t.Run(mode, func(t *testing.T) {
			f := taskClaudeSetup(t)
			p := taskWireTestConnect(t, f.ingress)
			switch mode {
			case "lease":
				f.access.fail = true
			case "reservation":
				f.native.unknownReservation = true
			case "start":
				f.native.unknownStart = true
			case "cleanup":
				f.native.unverifiedCleanup = true
			case "revoke-before-spawn":
				f.native.beforeSpawn = func() { f.access.RevokeParticipant("participant") }
			case "expiry-before-spawn":
				f.native.beforeSpawn = func() { f.clock.now = f.clock.now.Add(authority.OrdinaryExecutionLifetime) }
			}
			r := p.call("task.create", "create-1", `{"message":"initial"}`)
			if mode == "cleanup" {
				taskWireTestData[wire.TaskMutation](t, r, "TaskMutation")
				r = p.call("task.observe", "", "{}")
			}
			if r.Result == nil || r.Result.Status == "ok" {
				t.Fatal("fault became known", r)
			}
			prepares, reservations, starts, reads, access := f.native.prepares, f.native.reservations, f.native.starts, f.native.reads, f.access.calls
			f.access.fail = false
			f.clock.now = f.clock.now.Add(time.Hour)
			for _, id := range []string{"create-1", "replacement-2"} {
				r = p.call("task.create", id, `{"message":"initial"}`)
				if mode == "cleanup" && id == "create-1" {
					// Start was acknowledged before the later observation failed.
					// Exact replay may return that historical receipt without effect.
					prior := taskWireTestData[wire.TaskMutation](t, r, "TaskMutation")
					if prior.Receipt.State != "known" || prior.Receipt.Lifecycle == nil || *prior.Receipt.Lifecycle != "running" || prior.Receipt.Result != "" {
						t.Fatal("historical start became a terminal result", prior)
					}
				} else if r.Result == nil || r.Result.Status == "ok" {
					t.Fatal("unknown allowed a new effect", r)
				}
			}
			if f.native.prepares != prepares || f.native.reservations != reservations || f.native.starts != starts || f.native.reads != reads || f.access.calls != access {
				t.Fatal("fault selected another lease or process")
			}
			if (mode == "lease" || mode == "reservation" || mode == "revoke-before-spawn" || mode == "expiry-before-spawn") && f.native.starts != 0 {
				t.Fatal("refusal caused effect")
			}
		})
	}
}

func TestTaskClaudeMissingQualificationCannotReachComputer(t *testing.T) {
	for _, mode := range []string{"issuer", "preparer", "reservation", "clock", "qualifier", "qualification-refused", "revoked-after-admission"} {
		t.Run(mode, func(t *testing.T) {
			f := taskClaudeSetup(t)
			in := f.inputs
			selected := *in.Claude
			process := *selected.Process
			selected.Process, in.Claude = &process, &selected
			switch mode {
			case "issuer":
				process.Issuer = nil
			case "preparer":
				var missing *taskClaudeNative
				process.Preparer = missing
			case "reservation":
				var missing *taskClaudeNative
				process.Reservations = missing
			case "clock":
				var missing *computerClockFixture
				process.Clock = missing
			case "qualifier":
				process.Recheck = nil
			case "qualification-refused":
				f.qualificationError = task.ErrUnavailable
			case "revoked-after-admission":
				qualify := process.Recheck
				process.Recheck = func(ctx context.Context, q claude.Selection) (task.Capabilities, error) {
					f.task.journal.mu.Lock()
					admitted := f.task.journal.snapshot != nil
					f.task.journal.mu.Unlock()
					if admitted {
						return task.Capabilities{}, task.ErrUnavailable
					}
					return qualify(ctx, q)
				}
			}
			ingress, err := NewTaskIngress(in, controlct.Parent{ThreadID: "parent", TurnID: "parent-turn"})
			if mode == "qualification-refused" || mode == "revoked-after-admission" {
				if err != nil {
					t.Fatal("lazy composition qualified", err)
				}
				p := taskWireTestConnect(t, ingress)
				r := p.call("task.create", "create-1", `{"message":"initial"}`)
				if r.Result == nil || r.Result.Status == "ok" {
					t.Fatal("missing qualification enabled dispatch", r)
				}
			} else if err == nil {
				t.Fatal("missing prerequisite constructed")
			}
			if f.access.calls != 0 || f.native.prepares != 0 || f.native.reservations != 0 || f.native.starts != 0 || f.native.reads != 0 {
				t.Fatal("qualification failure reached Computer")
			}
		})
	}
}
