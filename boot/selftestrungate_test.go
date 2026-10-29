package boot

import (
	"context"
	"errors"
	"testing"
	"time"

	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func runGateFixture() *SettingsMutationIngress {
	return &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: context.Background(), operations: make(map[string]*settingsMutationOperation)}
}

func TestSelfTestRunFenceReservesBeforeEffectsAndAbandonsOnlyUnstarted(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	s := runGateFixture()
	run, err := s.beginSelfTestRun(context.Background(), id, "work")
	if err != nil || run == nil || !s.scratchAdmissionPendingLocked() {
		t.Fatal("run did not reserve its fence", err)
	}
	if second, err := s.beginSelfTestRun(context.Background(), id, "work"); err == nil || second != nil {
		t.Fatal("concurrent run admitted")
	}
	if err := run.abandonUnstarted(); err != nil || s.scratchAdmissionPendingLocked() {
		t.Fatal("unstarted run did not release", err)
	}
	if err := run.abandonUnstarted(); err == nil {
		t.Fatal("stale token released a run")
	}
}

func TestSelfTestRunBindsOriginalStageAndRetainsAdmittedAttempt(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	s := runGateFixture()
	run, err := s.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	record := &settingsMutationOperation{workspace: "work", path: mutation.ScratchPath(id), pending: true, stageScratch: true}
	s.operations[id] = record
	if lease, err := s.beginSelfTestStageForWorkspace(context.Background(), id, "work"); err == nil || lease != nil {
		t.Fatal("stage accepted without the original token")
	}
	record.selfTestRun = run
	lease, err := s.beginSelfTestStageForWorkspace(context.Background(), id, "work")
	if err != nil {
		t.Fatal("original stage refused", err)
	}
	lease.release()
	if err := run.abandonUnstarted(); err == nil || !s.scratchAdmissionPendingLocked() {
		t.Fatal("admitted operation lost its fence")
	}
	var unknown *mutationct.Failure
	if err := s.freezeForRetirement(); !errors.As(err, &unknown) || unknown.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
		t.Fatal("retirement hid the unfinished run", err)
	}
}

func TestSelfTestRunFenceRejectsOrdinaryAdmissions(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	connector, _, journal, native, _ := connectorMutationFixture(t)
	ledger := connector.mutations
	ledger.stageBaseline, ledger.stageOwner, ledger.stageLifetime = true, &computerStageOwner{}, context.Background()
	run, err := ledger.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	if out, err := connector.mutate(context.Background(), connector.current, "write", "call", connectorWriteFixture()); err == nil || out != nil || journal.admits != 0 || native.calls != 0 {
		t.Fatal("ordinary mutation crossed run fence", out, err)
	}
	if err := run.abandonUnstarted(); err != nil {
		t.Fatal(err)
	}
	process, processJournal, processNative, _ := processWireFixture(t)
	ledger = process.mutations
	ledger.stageBaseline, ledger.stageOwner, ledger.stageLifetime = true, &computerStageOwner{}, context.Background()
	run, err = ledger.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	if out, err := process.startProcess(context.Background(), process.current, "process", "call", processNative.selectLaunch); err == nil || out != nil || processJournal.reserves != 0 || processNative.selects != 0 {
		t.Fatal("ordinary shell crossed run fence", out, err)
	}
	if err := run.abandonUnstarted(); err != nil {
		t.Fatal(err)
	}
}

func TestSelfTestRunCancellationAbandonsOnlyBeforeAdmission(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	s := runGateFixture()
	ctx, cancel := context.WithCancel(context.Background())
	run, err := s.beginSelfTestRun(ctx, id, "work")
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-run.released:
	case <-time.After(time.Second):
		t.Fatal("unstarted cancelled run retained its fence")
	}
	s.mu.Lock()
	retained := s.selfTestRun
	s.mu.Unlock()
	if retained != nil {
		t.Fatal("cancelled unstarted run was not released")
	}
}

func TestSelfTestRunRetirementDistinguishesUnstartedAndActive(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	s := runGateFixture()
	run, err := s.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.freezeForRetirement(); err != nil || s.selfTestRun != nil {
		t.Fatal("unstarted run produced an unknown outcome", err)
	}
	select {
	case <-run.released:
	default:
		t.Fatal("unstarted run was not released")
	}
	s = runGateFixture()
	run, err = s.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	run.active = true
	run.callDone = make(chan struct{})
	s.mu.Unlock()
	var unknown *mutationct.Failure
	if err := s.freezeForRetirement(); !errors.As(err, &unknown) || unknown.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || s.selfTestRun != run {
		t.Fatal("active call was treated as unstarted", err)
	}
}

func TestSelfTestRunCloseJoinsAttemptBeforeStageBegins(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	s := runGateFixture()
	run, err := s.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	attemptDone := make(chan struct{})
	s.operations[id] = &settingsMutationOperation{workspace: "work", path: mutation.ScratchPath(id), pending: true, stageScratch: true, selfTestRun: run, scratchDone: attemptDone}
	s.mu.Unlock()
	s.closeSelfTestStageAdmission()
	joined := make(chan struct{})
	go func() { s.waitSelfTestStage(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("close returned before the admitted attempt")
	case <-time.After(20 * time.Millisecond):
	}
	close(attemptDone)
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("close did not join completed attempt")
	}
	if !s.scratchAdmissionPendingLocked() {
		t.Fatal("cancelled admitted run lost its fence")
	}
}

func TestStageCloseJoinsStandaloneScratchBeforeStageBegins(t *testing.T) {
	s := runGateFixture()
	done := make(chan struct{})
	s.operations["original"] = &settingsMutationOperation{pending: true, stageScratch: true, scratchDone: done}
	s.closeSelfTestStageAdmission()
	joined := make(chan struct{})
	go func() { s.waitSelfTestStage(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("close returned before the original standalone scratch attempt")
	case <-time.After(20 * time.Millisecond):
	}
	close(done)
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("close did not join standalone scratch")
	}
}
