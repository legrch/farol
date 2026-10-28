package boot

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Real connector/host guard/execution issuer/process owners. Persistence,
// physical workspace and child are explicit in-memory doubles. The positive
// fixture selects a Shell ceiling directly; Open without a producer strips it.
// No child, filesystem, socket, provider, native qualification or MCP is used.
type connectorProcessJournalDouble struct {
	*chatMutationJournal
	scope       processsvc.ConnectorReservationScope
	intent      processsvc.Intent
	selections  int
	reserves    int
	reserveFail bool
}

func (j *connectorProcessJournalDouble) ConnectorProcessReservation(scope processsvc.ConnectorReservationScope) (processsvc.Reservation, error) {
	j.selections++
	j.scope = scope
	return j, nil
}

func (j *connectorProcessJournalDouble) Reserve(_ context.Context, intent processsvc.Intent) (*processsvc.ReservationReceipt, error) {
	j.reserves++
	j.intent = intent
	if j.reserveFail {
		return nil, errors.New("controlled lost reservation ACK")
	}
	return &processsvc.ReservationReceipt{Status: processsvc.Reserved, Intent: intent}, nil
}

type connectorProcessNativeDouble struct {
	s             *computerConnector
	journal       *connectorProcessJournalDouble
	seal          processsvc.Seal
	selects       int
	spawns        int
	reads         int
	probes        int
	beforeSpawn   func()
	afterSpawn    func()
	afterRead     func()
	afterProbe    func()
	readErr       error
	terminal      bool
	supervisor    processsvc.SupervisorState
	groupGone     bool
	completed     chan struct{}
	completionErr error
	stdoutData    []byte
	stderrData    []byte
}

func (n *connectorProcessNativeDouble) WaitForCompletion(ctx context.Context) error {
	select {
	case <-n.completed:
		return n.completionErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (n *connectorProcessNativeDouble) selectLaunch(_ context.Context, lease *execution.Lease) (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
	n.selects++
	if lease == nil {
		return nil, nil, errors.New("missing original lease")
	}
	return n, n, nil
}

func (n *connectorProcessNativeDouble) Seal() processsvc.Seal { return n.seal }
func (n *connectorProcessNativeDouble) Handle() string        { return "retained-child" }
func (n *connectorProcessNativeDouble) Spawn(ctx context.Context, request processsvc.SpawnRequest) (processsvc.Child, error) {
	if n.journal.reserves != 1 || !request.Deadline.Equal(n.journal.intent.Deadline) {
		return nil, &processsvc.NativeFailure{Unknown: true}
	}
	if n.beforeSpawn != nil {
		n.beforeSpawn()
	}
	if err := request.Check(ctx); err != nil {
		return nil, &processsvc.NativeFailure{}
	}
	n.spawns++
	if n.afterSpawn != nil {
		n.afterSpawn()
	}
	return n, nil
}

func (n *connectorProcessNativeDouble) unlocked() bool {
	if !n.s.mutations.mu.TryLock() {
		return false
	}
	n.s.mutations.mu.Unlock()
	if n.s.current != nil {
		if !n.s.current.guard.mu.TryLock() {
			return false
		}
		n.s.current.guard.mu.Unlock()
	}
	return true
}

func (n *connectorProcessNativeDouble) ObserveWorkspace(context.Context) (*processsvc.ObservedWorkspace, error) {
	if !n.unlocked() {
		return nil, errors.New("probe under owner lock")
	}
	n.probes++
	if n.afterProbe != nil {
		n.afterProbe()
	}
	return &processsvc.ObservedWorkspace{WorkspaceID: n.seal.WorkspaceID, Root: n.seal.Root, RootIdentity: n.seal.RootIdentity}, nil
}

func (n *connectorProcessNativeDouble) Read(_ context.Context, window processsvc.Window) (*processsvc.Observation, error) {
	if !n.unlocked() {
		return nil, errors.New("read under owner lock")
	}
	n.reads++
	if n.afterRead != nil {
		n.afterRead()
	}
	if n.readErr != nil {
		return nil, n.readErr
	}
	stdout, stderr := n.stdoutData, n.stderrData
	if stdout == nil {
		stdout = []byte("saved")
	}
	if stderr == nil {
		stderr = []byte("err")
	}
	out := &processsvc.Observation{Handle: n.Handle(), Root: processsvc.RootRunning, GroupCleanup: processsvc.CleanupPending, DescendantCleanup: processsvc.CleanupPending,
		Stdout: stdout, Stderr: stderr, StdoutOffset: window.StdoutOffset, StderrOffset: window.StderrOffset,
		StdoutNext: window.StdoutOffset + uint64(len(stdout)), StderrNext: window.StderrOffset + uint64(len(stderr)), StdoutBytes: window.StdoutOffset + uint64(len(stdout)), StderrBytes: window.StderrOffset + uint64(len(stderr))}
	if n.terminal {
		code := 7
		out.Root, out.Waited, out.ExitCode = processsvc.RootExited, true, &code
		out.GroupCleanup, out.DescendantCleanup, out.OutputDrained = processsvc.CleanupConfirmed, processsvc.CleanupConfirmed, true
	}
	if n.supervisor != "" {
		out.Supervisor = n.supervisor
		out.GroupCleanup, out.DescendantCleanup = processsvc.CleanupUnverified, processsvc.CleanupUnverified
		if n.groupGone {
			out.GroupCleanup = processsvc.CleanupConfirmed
		}
	}
	return out, nil
}

func (n *connectorProcessNativeDouble) Cancel(context.Context) (*processsvc.CancelReceipt, error) {
	return nil, errors.New("observation must never cancel")
}

func connectorProcessFixture(t *testing.T) (*computerConnector, *connectorJournalFixture, *connectorProcessJournalDouble, *connectorProcessNativeDouble, wire.ComputerConnectorOpen) {
	t.Helper()
	s, access, _, _, input := newConnectorFixture(t)
	access.approval.Capabilities = []authority.Capability{authority.List, authority.Read, authority.Shell}
	access.approval.Commands = authority.WorkspaceCommands
	access.approval.Workspaces[0].ShellVerified = true
	access.PutApproval(access.approval)
	s.root.publication.approval = access.approval.Clone()
	deps, journal, _ := chatMutationDependencies()
	j := &connectorProcessJournalDouble{chatMutationJournal: journal}
	deps.repository = j
	var err error
	s.mutations, err = settingsMutationIngress(s.root, deps)
	if err != nil {
		t.Fatal(err)
	}
	n := &connectorProcessNativeDouble{s: s, journal: j, completed: make(chan struct{}), seal: processsvc.Seal{Digest: strings.Repeat("a", 64), WorkspaceID: "work", Root: "/disposable", Cwd: "/disposable", RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}
	t.Cleanup(func() {
		s.cancel()
		s.mutations.mu.Lock()
		var waits []<-chan struct{}
		for _, operation := range s.mutations.operations {
			if operation.process != nil && operation.process.collectionDone != nil {
				waits = append(waits, operation.process.collectionDone)
			}
		}
		s.mutations.mu.Unlock()
		for _, done := range waits {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("controlled completion waiter did not close")
			}
		}
	})
	selectConnectorProcessSlot(t, s, access, input, "original")
	return s, access, j, n, input
}

// Controlled trusted launch, independent of Open's conditional producer gate.
// Real connector publication and current host gates still run.
func selectConnectorProcessSlot(t *testing.T, s *computerConnector, access *connectorJournalFixture, input wire.ComputerConnectorOpen, suffix string) {
	t.Helper()
	if s.current != nil {
		if err := s.closeSlot(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	a := access.approval.Clone()
	generation, _ := strconv.ParseUint(input.ConnectorGeneration, 10, 64)
	host := port.ConnectorHost{ProfileID: s.root.peer.ProfileId, BackendGeneration: s.root.peer.BackendGeneration, BuildID: BuildID, RuntimeID: input.RuntimeId, ConnectorGeneration: generation, LaunchDigest: input.LaunchDigest}
	guard := &connectorHostGuard{root: s.root, lifetime: s.lifetime, host: host, publication: input.Publication, fence: s.root.guard.revision}
	launch := port.ConnectorLaunch{Host: host, Approval: a, TurnCorrelation: "turn-" + suffix,
		Admission: authority.Admission{Identity: authority.Identity{OwnerID: a.OwnerID, SessionID: "session-" + suffix, TaskID: "task-" + suffix, TaskEpoch: 1},
			AuthorityID: "admission-" + suffix, ComputerID: a.ComputerID, ComputerGeneration: a.Generation,
			Policy: authority.Policy{FilePolicy: a.FilePolicy, Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/disposable", Mode: authority.Subtree, Access: authority.ReadAccess}}, Capabilities: a.Capabilities, Network: a.Network, Commands: a.Commands, ExpiresAt: a.ExpiresAt}},
		Participant: authority.ParticipantAdmission{ParticipantID: "participant-" + suffix, Role: authority.Main, MutationOwnership: authority.NoOwnership}}
	owner, err := connectorsvc.New(&sync.Mutex{}, access, guard, s.clock, launch)
	if err != nil {
		t.Fatal(err)
	}
	if err = owner.Publish(context.Background()); err != nil {
		t.Fatal(err)
	}
	ceiling, err := owner.ExecutionCeiling(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	route, err := computerRoute(access, owner, execution.Ceiling{Participant: ceiling.Participant, Approval: ceiling.Approval}, s.root.native, s.clock)
	if err != nil {
		t.Fatal(err)
	}
	s.current = &connectorSlot{guard: guard, owner: owner, route: route, opened: wire.ComputerConnectorOpened{Execution: wire.ComputerConnectorExecution{Generation: "1"}}}
}

func startConnectorProcessFixture(t *testing.T, s *computerConnector, n *connectorProcessNativeDouble) *processct.StartResponse {
	t.Helper()
	out, err := s.startProcess(context.Background(), s.current, "process-operation", "process-call", n.selectLaunch)
	if err != nil || out == nil || out.Handle != n.Handle() {
		t.Fatal(out, err)
	}
	return out
}

func TestConnectorProcessRootReconnectKeepsOneOriginal(t *testing.T) {
	s, access, journal, native, input := connectorProcessFixture(t)
	firstSlot := s.current
	start := startConnectorProcessFixture(t, s, native)
	original, scope := journal.intent, journal.scope
	if original.Binding.SessionID != "session-original" || scope.Host != firstSlot.guard.host || scope.CallID != "process-call" || scope.Generation != 1 || scope.ComputerGeneration != 3 || journal.reserves != 1 || native.spawns != 1 {
		t.Fatal("wrong original selection", original, scope)
	}
	if out, err := s.startProcess(context.Background(), s.current, "process-operation", "another-call", native.selectLaunch); out != nil || err == nil || native.selects != 1 {
		t.Fatal("duplicate selected a replacement")
	}
	access.clock.now = access.clock.now.Add(16 * time.Second)
	input.RuntimeId, input.ConnectorGeneration = "new-runtime", "9007199254740994"
	selectConnectorProcessSlot(t, s, access, input, "reconnected")
	native.terminal = true
	out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle})
	if err != nil || out == nil || out.State != processct.Terminal || out.StdoutBase64 != "c2F2ZWQ=" || out.StderrBase64 != "ZXJy" || out.ExitCode == nil || *out.ExitCode != 7 {
		t.Fatal("retained observation refused", out, err)
	}
	if journal.intent != original || journal.scope != scope || journal.selections != 1 || journal.reserves != 1 || native.selects != 1 || native.spawns != 1 || native.probes != 2 {
		t.Fatal("reconnect renewed intent or repeated an effect")
	}
	if out, err := s.observeProcess(context.Background(), firstSlot, start.OperationID, processct.ReadRequest{Handle: start.Handle}); out != nil || err == nil {
		t.Fatal("old slot disclosed")
	}
	if s.mutations.freezeForRetirement() == nil {
		t.Fatal("memory terminal became durable retirement proof")
	}
	if len(s.mutations.operations) != 1 || journal.loads != 0 || journal.saves != 0 {
		t.Fatal("second registry or cold result lookup")
	}
}

func TestConnectorProcessRootFailsClosedAcrossCurrentBoundaries(t *testing.T) {
	for _, fault := range []string{"withdraw-before", "withdraw-probe", "withdraw-child", "unknown-before", "unknown-child", "publication", "generation", "foreign-profile", "changed-root", "wrong-handle", "no-record", "file-record"} {
		t.Run(fault, func(t *testing.T) {
			s, access, journal, native, _ := connectorProcessFixture(t)
			start := startConnectorProcessFixture(t, s, native)
			withdraw := func() { s.current.guard.close() }
			switch fault {
			case "withdraw-before":
				withdraw()
			case "withdraw-probe":
				native.afterProbe = withdraw
			case "withdraw-child":
				native.afterRead = withdraw
			case "unknown-before":
				s.root.unknown = true
			case "unknown-child":
				native.afterRead = func() { s.root.unknown = true }
			case "publication":
				s.root.publication.receipt.SettingsRevision = "99"
			case "generation":
				access.approval.Generation++
				access.PutApproval(access.approval)
			case "foreign-profile":
				s.root.peer.ProfileId = "other"
			case "changed-root":
				native.seal.RootIdentity.Inode = "9"
			case "wrong-handle":
				start.Handle = "other-child"
			case "no-record":
				start.OperationID = "absent"
			case "file-record":
				s.mutations.operations["file"] = &settingsMutationOperation{connectorScope: true, settled: true}
				start.OperationID = "file"
			}
			out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle})
			if out != nil || err == nil || native.spawns != 1 || journal.reserves != 1 || journal.loads != 0 {
				t.Fatal("current boundary disclosed or re-executed", out, err)
			}
			if fault != "withdraw-child" && fault != "unknown-child" && native.reads != 0 {
				t.Fatal("invalid current state reached child IO")
			}
		})
	}
}

func TestConnectorProcessRootUnknownAndMutationOwnersStaySeparate(t *testing.T) {
	s, _, journal, native, _ := connectorProcessFixture(t)
	start := startConnectorProcessFixture(t, s, native)
	native.readErr = &processsvc.NativeFailure{Unknown: true}
	if out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle}); out != nil || err == nil {
		t.Fatal("unknown child became success")
	}
	native.readErr, native.terminal = nil, true
	out, err := s.observeProcess(context.Background(), s.current, start.OperationID, processct.ReadRequest{Handle: start.Handle})
	if err != nil {
		var failure *processct.Failure
		if out != nil || !errors.As(err, &failure) || failure.Code != "PROCESS_OUTCOME_UNKNOWN" || failure.Outcome != "outcome_unknown" || failure.Retry != "never" {
			t.Fatal("unexpected unknown outcome", out, err)
		}
	} else if out == nil || out.State != processct.Unknown {
		t.Fatal("unknown was cleared", out, err)
	}
	if out, err := s.observeMutation(context.Background(), s.current, start.OperationID, mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"}); out != nil || err == nil || journal.loads != 0 {
		t.Fatal("file observer adopted process reservation")
	}
	if s.mutations.freezeForRetirement() == nil || native.spawns != 1 {
		t.Fatal("unknown retired or re-executed")
	}
}

func TestConnectorProcessRootOriginalReservationAndPendingFreeze(t *testing.T) {
	for _, mode := range []string{"lost-reservation", "withdraw-before-spawn", "freeze-during-selection"} {
		t.Run(mode, func(t *testing.T) {
			s, _, journal, native, _ := connectorProcessFixture(t)
			selectLaunch := native.selectLaunch
			switch mode {
			case "lost-reservation":
				journal.reserveFail = true
			case "withdraw-before-spawn":
				native.beforeSpawn = func() { s.current.guard.close() }
			case "freeze-during-selection":
				selectLaunch = func(ctx context.Context, lease *execution.Lease) (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
					if s.mutations.freezeForRetirement() == nil {
						t.Fatal("pending selection retired")
					}
					return native.selectLaunch(ctx, lease)
				}
			}
			out, err := s.startProcess(context.Background(), s.current, "process-operation", "call", selectLaunch)
			if out != nil || err == nil || native.spawns != 0 || s.mutations.freezeForRetirement() == nil {
				t.Fatal("lost/refused boundary executed or retired", out, err)
			}
			if _, err := s.startProcess(context.Background(), s.current, "process-operation", "another-call", selectLaunch); err == nil || native.selects != 1 {
				t.Fatal("original selection repeated")
			}
		})
	}
}

func TestConnectorProcessRootNormalOpenStillRefusesShell(t *testing.T) {
	s, _, journal, native, input := connectorProcessFixture(t)
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(context.Background(), "normal-open", input); err != nil {
		t.Fatal(err)
	}
	if out, err := s.startProcess(context.Background(), s.current, "normal-process", "call", native.selectLaunch); out != nil || err == nil || native.selects != 0 || journal.reserves != 0 {
		t.Fatal("source composition enabled unqualified Shell", out, err)
	}
	if s.mutations.freezeForRetirement() != nil {
		t.Fatal("pure pre-start refusal blocked retirement")
	}
}

// Synthetic messages deliberately carry secret-like content. These cases prove
// the closed code boundary, not any native or live-provider behavior.
func connectorPreparationCases() []struct {
	name          string
	err           error
	code, outcome string
} {
	return []struct {
		name          string
		err           error
		code, outcome string
	}{
		{"policy", fmt.Errorf("synthetic token=fixture-private /private/fixture: %w", connectorProcessRefusal("PROCESS_PREPARATION_POLICY_MISMATCH")), "PROCESS_PREPARATION_POLICY_MISMATCH", "refused"},
		{"workspace", &processsvc.Failure{Code: "PROCESS_PREPARATION_WORKSPACE_STALE"}, "PROCESS_PREPARATION_WORKSPACE_STALE", "refused"},
		{"scope", connectorProcessRefusal("PROCESS_PREPARATION_SCOPE_REFUSED"), "PROCESS_PREPARATION_SCOPE_REFUSED", "refused"},
		{"changed-policy", connectorProcessRefusal("PROCESS_PREPARATION_AUTHORIZATION_CHANGED"), "PROCESS_PREPARATION_AUTHORIZATION_CHANGED", "refused"},
		{"deadline", fmt.Errorf("synthetic token=fixture-private: %w", context.DeadlineExceeded), "PROCESS_PREPARATION_DEADLINE", "refused"},
		{"cancelled", context.Canceled, "PROCESS_CANCELLED", "refused"},
		{"authorization", authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "/private/fixture token=fixture-private"), "AUTHORITY_COMPUTER_MISMATCH", "refused"},
		{"native-refused", &processsvc.Failure{Code: "PROCESS_NATIVE_REFUSED"}, "PROCESS_NATIVE_REFUSED", "refused"},
		{"unknown", &processct.Failure{Code: "PROCESS_PREPARATION_UNKNOWN", Outcome: "outcome_unknown", Retry: "automatic"}, "PROCESS_PREPARATION_UNKNOWN", "outcome_unknown"},
		{"native-unknown", &processsvc.NativeFailure{Unknown: true}, "PROCESS_OUTCOME_UNKNOWN", "outcome_unknown"},
		{"native-filesystem", &processsvc.NativeFailure{FilesystemUnsupported: true}, "PROCESS_FILESYSTEM_UNSUPPORTED", "refused"},
		{"unknown-filesystem", &processsvc.NativeFailure{Unknown: true, FilesystemUnsupported: true}, "PROCESS_OUTCOME_UNKNOWN", "outcome_unknown"},
		{"raw-secret", errors.New("synthetic token=fixture-private command=private /private/fixture"), "PROCESS_PREPARATION_UNAVAILABLE", "refused"},
		{"contract-secret", &processct.Failure{Code: "SECRET_TOKEN_FIXTURE_PRIVATE", Outcome: "refused", Retry: "automatic"}, "PROCESS_PREPARATION_UNAVAILABLE", "refused"},
		{"service-secret", &processsvc.Failure{Code: "/private/fixture token=fixture-private"}, "PROCESS_PREPARATION_UNAVAILABLE", "refused"},
		{"authority-secret", authority.Fail("SECRET_TOKEN_FIXTURE_PRIVATE", "computer-policy"), "PROCESS_PREPARATION_UNAVAILABLE", "refused"},
		{"unlisted-unknown", &processsvc.Failure{Code: "SECRET_TOKEN_FIXTURE_PRIVATE", Unknown: true}, "PROCESS_OUTCOME_UNKNOWN", "outcome_unknown"},
	}
}

func TestConnectorProcessPreparationPreservesOnlyClosedCodes(t *testing.T) {
	for _, tc := range connectorPreparationCases() {
		t.Run(tc.name, func(t *testing.T) {
			s, _, journal, native, _ := connectorProcessFixture(t)
			selection := func(context.Context, *execution.Lease) (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
				return nil, nil, tc.err
			}
			out, err := s.startProcess(context.Background(), s.current, "preparation-operation", "preparation-call", selection)
			var failure *processct.Failure
			if out != nil || !errors.As(err, &failure) || failure.Code != tc.code || failure.Outcome != tc.outcome || failure.Retry != "never" || err.Error() != tc.code || journal.reserves != 0 || native.spawns != 0 {
				t.Fatal("preparation classification was lost or leaked")
			}
			if out, err := s.startProcess(context.Background(), s.current, "preparation-operation", "another-call", selection); out != nil || err == nil {
				t.Fatal("preparation failure permitted replay")
			}
			if tc.name == "native-filesystem" {
				awaitProcessCollection(t, s, "preparation-operation")
				if s.drainProcessesForRetirement(context.Background()) != nil || s.mutations.freezeForRetirement() != nil {
					t.Fatal("known pre-reservation refusal blocked clean retirement")
				}
			}
		})
	}
}
