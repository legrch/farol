package boot

import (
	"context"
	"errors"
	"testing"
	"time"

	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestShellCheckPreservesUnknownCancellation(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellCancel)
	if err != nil {
		t.Fatal(err)
	}
	native.cancelErr = errors.New("synthetic lost acknowledgement")
	result := check.check(context.Background())
	if result.Status != "unknown" || result.Operation != "check-process" || result.Handle != native.Handle() || result.CancelOperation != "check-cancel" || native.spawns != 1 || native.cancels != 1 || journal.reserves != 1 {
		t.Fatal("lost original unknown", result)
	}
	native.cancelErr = nil
	_ = check.check(context.Background())
	if native.spawns != 1 || native.cancels != 1 || journal.reserves != 1 {
		t.Fatal("unknown operation repeated")
	}
}

func TestSelfTestRunShellKeepsOrdinaryAdmissionsFenced(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	ledger := s.mutations
	ledger.stageBaseline, ledger.stageOwner, ledger.stageLifetime = true, &computerStageOwner{}, context.Background()
	const id = "00000000-0000-4000-8000-000000000001"
	run, err := ledger.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	ledger.operations[id] = &settingsMutationOperation{workspace: "work", path: mutation.ScratchPath(id), stageScratch: true, scratchCreated: true, settled: true, scratch: &mutationsvc.OwnerService{}, selfTestRun: run}
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellCancel)
	if err != nil {
		t.Fatal(err)
	}
	native.cancelErr = errors.New("synthetic lost acknowledgement")
	result := run.checkShellForRun(context.Background(), check)
	if result.Status != "unknown" || result.Handle != native.Handle() || native.spawns != 1 || native.cancels != 1 || journal.reserves != 1 {
		t.Fatalf("result %#v", result)
	}
	if repeat := run.checkShellForRun(context.Background(), check); repeat.Status != "fail" || native.spawns != 1 || native.cancels != 1 {
		t.Fatal("unknown shell repeated", repeat)
	}
	if out, err := s.startProcess(context.Background(), s.current, "other-process", "other-call", native.selectLaunch); err == nil || out != nil || native.spawns != 1 {
		t.Fatal("ordinary shell crossed retained run fence")
	}
	ledger.mu.Lock()
	process := ledger.operations["check-process"]
	eligible := process != nil && stagingPriorEligible(process)
	ledger.mu.Unlock()
	if process == nil || eligible {
		t.Fatal("unknown process cannot settle cleanup")
	}
}

func TestSelfTestRunShellRefusesBeforeScratchCreation(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	ledger := s.mutations
	ledger.stageBaseline, ledger.stageOwner, ledger.stageLifetime = true, &computerStageOwner{}, context.Background()
	const id = "00000000-0000-4000-8000-000000000001"
	run, err := ledger.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellQuick)
	if err != nil {
		t.Fatal(err)
	}
	result := run.checkShellForRun(context.Background(), check)
	if result.Status != "fail" || native.spawns != 0 || journal.reserves != 0 {
		t.Fatal("shell admitted without scratch", result)
	}
	if err := run.abandonUnstarted(); err != nil {
		t.Fatal(err)
	}
}

func TestSelfTestRunCannotAuthorizeAnotherShellScope(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	ledger := s.mutations
	ledger.stageBaseline, ledger.stageOwner, ledger.stageLifetime = true, &computerStageOwner{}, context.Background()
	const id = "00000000-0000-4000-8000-000000000001"
	run, err := ledger.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	ledger.mu.Lock()
	run.active = true
	ledger.mu.Unlock()
	for _, request := range []connectorShellRequest{
		{WorkspaceID: "other", RelativeCwd: ".", Command: "pwd"},
		{WorkspaceID: "work", RelativeCwd: "other", Command: "pwd"},
		{WorkspaceID: "work", RelativeCwd: ".", Command: "pwd", Write: true},
	} {
		out, err := s.startQualifiedShellForRun(context.Background(), s.current, s.current.opened.Execution, "other-process", "call", request, native.selectShell, run)
		if err == nil || out != nil || native.spawns != 0 || journal.reserves != 0 {
			t.Fatal("other scope admitted", request)
		}
	}
	ledger.mu.Lock()
	run.active = false
	ledger.mu.Unlock()
	if err := run.abandonUnstarted(); err != nil {
		t.Fatal(err)
	}
}

func TestSelfTestShellCheckDeadlineIsUnknown(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellQuick)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	result := check.check(ctx)
	if result.Status != "unknown" || result.Code != "PROCESS_OUTCOME_UNKNOWN" || result.Handle != native.Handle() || native.spawns != 1 || journal.reserves != 1 {
		t.Fatal("deadline promoted", result)
	}
}

func TestSelfTestShellCheckReadFailureDoesNotSettleStartedProcess(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "check-process", "check-call", "check-cancel", selfTestShellQuick)
	if err != nil {
		t.Fatal(err)
	}
	native.readErr = errors.New("synthetic read refusal")
	result := check.check(context.Background())
	if result.Status != "unknown" || result.Handle != native.Handle() || native.spawns != 1 || journal.reserves != 1 {
		t.Fatal("read failure misclassified", result)
	}
}

func TestSelfTestGitVersionUsesOneReadOnlyConfinedCommand(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	check, err := newSelfTestShell(s, s.current, "work", "git-check", "git-call", "git-unused-cancel", selfTestShellGitVersion)
	if err != nil {
		t.Fatal(err)
	}
	started, err := check.start(context.Background())
	if err != nil || started == nil || native.spawns != 1 || journal.reserves != 1 || len(native.requests) != 1 {
		t.Fatal("Git check did not start once", started, err, native.spawns, journal.reserves)
	}
	request := native.requests[0]
	if request.Command != "git --version" || request.Write || request.WorkspaceID != "work" || request.RelativeCwd != "." {
		t.Fatal("Git check widened its scope", request)
	}
	if _, err := check.start(context.Background()); err == nil || native.spawns != 1 {
		t.Fatal("original Git check was repeated", err)
	}
}

func TestSelfTestGitVersionOutputIsBoundedAndNotRepositoryProof(t *testing.T) {
	for _, value := range []string{"git version 2.45.0\n", "git version 2.39.3 (Apple Git-145)\n"} {
		if !validSelfTestGitVersion([]byte(value)) {
			t.Fatal("valid version refused", value)
		}
	}
	for _, value := range []string{"", "git version \n", "git version unknown\n", "git version 2\nprivate\n", "git version 2\x00\n", "git version 2"} {
		if validSelfTestGitVersion([]byte(value)) {
			t.Fatal("invalid version accepted", value)
		}
	}
	tooLong := append([]byte("git version 2"), make([]byte, 512)...)
	tooLong = append(tooLong, '\n')
	if validSelfTestGitVersion(tooLong) || validSelfTestGitVersion([]byte{'g', 'i', 't', ' ', 'v', 'e', 'r', 's', 'i', 'o', 'n', ' ', '2', 0xff, '\n'}) {
		t.Fatal("oversized or malformed output accepted")
	}
}
