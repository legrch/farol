//go:build darwin

package boot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

type scratchCustodyCloseFailure struct{ port.ScratchDirectoryCustody }

// The test injects a connector journal terminal after native file publication.
// It exercises the real profile, journal, cleanup owner and filesystem, but
// does not qualify live connector execution or Shell.
func TestNativeScratchFileCleanupJoinsJournalAndCustody(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || created.Receipt == nil {
		t.Fatal("create", created, err)
	}
	owner := runtime.mutations.computer
	creationID := state.Identity{Scope: state.ScopeOwnerSettings, OperationID: id, OwnerID: owner.ownerID, ProfileID: owner.peer.ProfileId, ComputerID: owner.computerID}
	creation, err := runtime.mutations.dependencies.repository.Load(context.Background(), creationID)
	if err != nil {
		t.Fatal(err)
	}
	cleanup, err := state.NewScratchCleanup(creation)
	if err != nil {
		t.Fatal(err)
	}
	var rootStat unix.Stat_t
	if err := unix.Lstat(workspace, &rootStat); err != nil {
		t.Fatal(err)
	}
	root := port.Root{Path: workspace, Device: strconv.FormatUint(uint64(rootStat.Dev), 10), Inode: strconv.FormatUint(rootStat.Ino, 10)}
	native, ok := runtime.mutations.dependencies.native.(port.ScratchBoundMutableWorkspace)
	if !ok {
		t.Fatal("scratch native unavailable")
	}
	path := created.Scratch.Leaf + "/check.txt"
	receipt, err := native.MutateScratch(context.Background(), port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: ws, Root: workspace, ApprovedRoot: root}, Operation: state.Write{RelativePath: path, Content: selfTestFileBefore}, ScratchDirectoryHold: run.scratchCustody, HoldScratchFile: true, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, fn func() error) error { return fn() }}, cleanup.Binding())
	if err != nil || receipt == nil || receipt.ScratchFileHold == nil {
		t.Fatal("file publication", receipt, err)
	}
	t.Cleanup(func() {
		if run.fixtureCustody != nil {
			_ = run.fixtureCustody.Close()
		}
	})
	fileID := state.Identity{Scope: state.ScopeConnector, OperationID: "test-file-op", OwnerID: owner.ownerID, ProfileID: owner.peer.ProfileId, ComputerID: owner.computerID}
	b := state.Binding{Identity: fileID, ComputerGeneration: created.ComputerGeneration, WorkspaceID: ws, RelativePath: path, RequestDigest: strings.Repeat("b", 64), Connector: state.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2, SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", CallID: "call", TaskEpoch: 3, Generation: 4, Operation: state.WriteKind}}
	prepared, err := state.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	admission, err := runtime.mutations.dependencies.repository.Admit(context.Background(), prepared)
	if err != nil || admission.Status != port.MutationAdmitted {
		t.Fatal("admit file", err)
	}
	terminal, err := prepared.Complete(state.Receipt{Operation: state.WriteKind, RelativePath: path, Bytes: receipt.Bytes, AfterSHA256: receipt.AfterSHA256})
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.mutations.dependencies.repository.Save(context.Background(), terminal); err != nil {
		t.Fatal(err)
	}
	run.fixtureWriteStarted, run.fixtureCustody, run.fixtureFileIdentity, run.fixtureFileHash, run.fixtureOperation = true, receipt.ScratchFileHold, receipt.ScratchFile, receipt.AfterSHA256, fileID.OperationID
	loaded, err := runtime.mutations.dependencies.repository.Load(context.Background(), fileID)
	if err != nil || loaded == nil {
		t.Fatal("load file", err)
	}
	witness, err := state.NewScratchFileInventory(creation, loaded, receipt.ScratchFile)
	if err != nil || witness == nil {
		t.Fatal("file witness", err)
	}
	if _, ok := runtime.mutations.dependencies.native.(port.ScratchFileCleanupWorkspace); !ok {
		t.Fatalf("missing file cleanup port: %T", runtime.mutations.dependencies.native)
	}
	if _, ok := runtime.mutations.dependencies.repository.(port.ScratchFileCleanupRepository); !ok {
		t.Fatalf("missing file cleanup repository: %T", runtime.mutations.dependencies.repository)
	}
	cleaned, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication)
	if err != nil || cleaned == nil || cleaned.Phase != "completed" || cleaned.Publication != "durable" || runtime.mutations.selfTestRun != nil {
		t.Fatal("cleanup", cleaned, err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, created.Scratch.Leaf)); !os.IsNotExist(err) {
		t.Fatal("scratch remains", err)
	}
	if observed, err := runtime.mutations.dependencies.repository.Load(context.Background(), fileID); err != nil || observed == nil || observed.Phase() != state.Completed || observed.Receipt().AfterSHA256 != receipt.AfterSHA256 {
		t.Fatal("original history changed", err)
	}
	if _, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication); err == nil {
		t.Fatal("cleanup repeated")
	}
}

func (f scratchCustodyCloseFailure) Close() error {
	return errors.Join(f.ScratchDirectoryCustody.Close(), errors.New("synthetic close failure"))
}

// Actual native profile, owner approval, journal, staging descriptor and
// filesystem publication in a disposable fixture. No Shell, UI or provider.
func TestNativeScratchOwnerPublishesOnceAndObservesAfterReopen(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	runtime.mutations.recoveryReserved = true
	runtime.mutations.computer.effects.Lock()
	refused := make(chan bool, 1)
	go func() {
		result, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication)
		refused <- err != nil && result == nil
	}()
	select {
	case ok := <-refused:
		runtime.mutations.computer.effects.Unlock()
		if !ok || runtime.mutations.operations[id] != nil {
			t.Fatal("recovery reservation admitted scratch")
		}
	case <-time.After(time.Second):
		runtime.mutations.computer.effects.Unlock()
		<-refused
		t.Fatal("scratch waited on recovery effects")
	}
	runtime.mutations.recoveryReserved = false
	// A prior unconfirmed attempt must not admit another filesystem effect.
	runtime.mutations.operations["earlier"] = &settingsMutationOperation{stageScratch: true, pending: true}
	if result, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || result != nil || runtime.mutations.operations[id] != nil {
		t.Fatal("unconfirmed previous operation admitted a scratch attempt")
	}
	delete(runtime.mutations.operations, "earlier") // Only the test's synthetic ledger entry.
	result, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication)
	if err != nil || result == nil || result.Phase != string(state.Completed) || result.Publication != "durable" || result.Receipt == nil || !result.Receipt.Directory.Valid() {
		t.Fatalf("scratch: %#v %v ledger-entries=%d scratch-admitted=%v", result, err, len(runtime.mutations.operations), runtime.mutations.operations[id] != nil)
	}
	if _, err := os.Stat(filepath.Join(workspace, result.Scratch.Leaf)); err != nil {
		t.Fatal(err)
	}
	if repeated, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || repeated != nil {
		t.Fatal("original operation repeated")
	}
	if _, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, "another-workspace", result.ComputerGeneration); err == nil {
		t.Fatal("observation accepted a different workspace")
	}
	if _, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration+1); err == nil {
		t.Fatal("observation accepted a different generation")
	}
	observed, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || observed.Phase != result.Phase || observed.Scratch != result.Scratch || observed.Receipt.Directory != result.Receipt.Directory {
		t.Fatalf("original observation: %#v %v", observed, err)
	}
	terminal := preparedTerminal(t, runtime)
	if err := recordNativeTerminal(context.Background(), launch.Profile, terminal, func(_ wire.CoreRetirementAcknowledged) error { return nil }); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode = "open"
	launch.HostLifetimeID, launch.ChildLaunchID = "host-2", "child-2"
	launch.PreviousHostDrainConfirmed = true
	next, err := NewNativeRuntime(context.Background(), launch, "generation-2")
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	observed, err = next.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || observed.Phase != result.Phase || observed.Scratch != result.Scratch || observed.Receipt.Directory != result.Receipt.Directory {
		t.Fatalf("reopened observation: %#v %v", observed, err)
	}
	if repeated, err := next.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || repeated != nil {
		t.Fatal("reopened runtime repeated the original operation")
	}
	after, err := next.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || after == nil || after.Scratch != result.Scratch || after.Receipt == nil || after.Receipt.Directory != result.Receipt.Directory {
		t.Fatalf("original record changed after refused replay: %#v %v", after, err)
	}
}

// A whole-run reservation stays held after the native creation receipt. This
// fixture contains no Shell and is removed only by its disposable test owner.
func TestNativeScratchRetainsWholeRunFenceAfterPublication(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := runtime.mutations.createSelfTestScratch(context.Background(), id, ws, publication); err == nil || out != nil {
		t.Fatal("unbound creator crossed the run fence")
	}
	result, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || result == nil || result.Phase != string(state.Completed) || result.Publication != "durable" {
		t.Fatal("bound native scratch failed", result, err)
	}
	if err := run.abandonUnstarted(); err == nil {
		t.Fatal("published scratch was released without cleanup")
	}
	if runtime.mutations.selfTestRun != run || runtime.mutations.stagePending {
		t.Fatal("whole-run fence ended with staging")
	}
	observed, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, ws, result.ComputerGeneration)
	if err != nil || observed == nil || observed.Scratch != result.Scratch || observed.Receipt == nil || result.Receipt == nil || observed.Receipt.Directory != result.Receipt.Directory {
		t.Fatal("bound run lost original result", observed, err)
	}
}

// This exercises the private run, real journal and native empty-directory
// cleanup. It does not claim Shell, ChatGPT or packaged-runtime coverage.
func TestNativeScratchRunCleansOnceAndReleasesFence(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || created.Phase != "completed" || created.Publication != "durable" || created.Receipt == nil {
		t.Fatalf("create %#v %v", created, err)
	}
	custody := run.scratchCustody
	if custody == nil || custody.Check(created.Receipt.Directory) != nil {
		t.Fatal("original custody missing")
	}
	cleaned, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication)
	if err != nil || cleaned == nil || cleaned.Phase != "completed" || cleaned.Publication != "durable" {
		t.Fatalf("cleanup %#v %v", cleaned, err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, created.Scratch.Leaf)); !os.IsNotExist(err) {
		t.Fatal("directory not removed", err)
	}
	if runtime.mutations.selfTestRun != nil {
		t.Fatal("completed cleanup retained run fence")
	}
	if custody.Check(created.Receipt.Directory) == nil {
		t.Fatal("completed cleanup leaked original descriptor")
	}
	if repeated, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication); err == nil || repeated != nil {
		t.Fatal("cleanup repeated")
	}
	observed, err := runtime.mutations.observeSelfTestScratch(context.Background(), id, ws, created.ComputerGeneration)
	if err != nil || observed == nil || observed.Phase != "completed" || observed.Receipt == nil || observed.Receipt.Directory != created.Receipt.Directory {
		t.Fatalf("creation history changed %#v %v", observed, err)
	}
}

func TestNativeScratchShutdownClosesHeldDirectoryWithoutDeleting(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || created.Receipt == nil {
		t.Fatal("create", err)
	}
	custody := run.scratchCustody
	if custody == nil || custody.Check(created.Receipt.Directory) != nil {
		t.Fatal("missing custody")
	}
	runtime.mutations.closeSelfTestStageAdmission()
	runtime.mutations.waitSelfTestStage()
	if err := runtime.mutations.closeSelfTestCustody(); err != nil {
		t.Fatal(err)
	}
	if custody.Check(created.Receipt.Directory) == nil {
		t.Fatal("shutdown retained descriptor")
	}
	if _, err := os.Lstat(filepath.Join(workspace, created.Scratch.Leaf)); err != nil {
		t.Fatal("shutdown removed fixture", err)
	}
	if runtime.mutations.selfTestRun != run {
		t.Fatal("shutdown erased historical run")
	}
}

func TestNativeScratchCleanupRefusesLostCustody(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || run.scratchCustody == nil {
		t.Fatal("create", err)
	}
	if err := run.scratchCustody.Close(); err != nil {
		t.Fatal(err)
	}
	if out, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication); err == nil || out != nil {
		t.Fatal("closed custody authorized cleanup", out, err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, created.Scratch.Leaf)); err != nil {
		t.Fatal("lost custody removed fixture", err)
	}
	if runtime.mutations.selfTestRun != run {
		t.Fatal("lost custody released fence")
	}
}

func TestNativeScratchCleanupPersistsUnknownWhenCustodyCloseFails(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || run.scratchCustody == nil {
		t.Fatal("create", err)
	}
	run.scratchCustody = scratchCustodyCloseFailure{run.scratchCustody}
	out, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication)
	if err != nil || out == nil || out.Phase != "outcome_unknown" || out.Publication != "durable" {
		t.Fatalf("close failure lost %#v %v", out, err)
	}
	identity := state.Identity{Scope: state.ScopeOwnerSettings, OperationID: id, OwnerID: runtime.mutations.computer.ownerID, ProfileID: runtime.mutations.computer.peer.ProfileId, ComputerID: runtime.mutations.computer.computerID}
	creation, err := runtime.mutations.dependencies.repository.Load(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := state.NewScratchCleanup(creation)
	if err != nil {
		t.Fatal(err)
	}
	journal := runtime.mutations.dependencies.repository.(port.ScratchCleanupRepository)
	stored, err := journal.LoadScratchCleanup(context.Background(), prepared.Binding())
	if err != nil || stored == nil || stored.Phase() != state.OutcomeUnknown {
		t.Fatal("unknown not retained in journal", stored, err)
	}
	if runtime.mutations.selfTestRun != run {
		t.Fatal("unknown cleanup released run")
	}
	if repeated, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication); err == nil || repeated != nil {
		t.Fatal("unknown cleanup repeated")
	}
	if run.scratchCustody != nil {
		t.Fatal("uncertain close remained eligible for retry")
	}
}

func TestNativeScratchRunRetainsUnexpectedContentsAndFence(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || created.Phase != "completed" {
		t.Fatalf("create %#v %v", created, err)
	}
	file := filepath.Join(workspace, created.Scratch.Leaf, "unexpected")
	if err := os.WriteFile(file, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	cleaned, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication)
	if err != nil || cleaned == nil || cleaned.Phase != "failed" {
		t.Fatalf("cleanup %#v %v", cleaned, err)
	}
	if data, err := os.ReadFile(file); err != nil || string(data) != "preserve" {
		t.Fatal("unexpected data changed", err)
	}
	if runtime.mutations.selfTestRun != run {
		t.Fatal("unconfirmed cleanup released run fence")
	}
	if repeated, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication); err == nil || repeated != nil {
		t.Fatal("unconfirmed cleanup repeated")
	}
}

// The fixture creates the test file and injects its observed identity; it
// exercises the real cleanup owner, not the connector's publication path.
func TestNativeScratchRunRetainsFileWithoutCustodyProof(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || created.Phase != "completed" {
		t.Fatalf("create %#v %v", created, err)
	}
	file := filepath.Join(workspace, created.Scratch.Leaf, "check.txt")
	if err := os.WriteFile(file, []byte(selfTestFileAfter), 0600); err != nil {
		t.Fatal(err)
	}
	var stat unix.Stat_t
	if err := unix.Lstat(file, &stat); err != nil {
		t.Fatal(err)
	}
	runtime.mutations.mu.Lock()
	run.fixtureFileIdentity = state.DirectoryIdentity{Device: strconv.FormatUint(uint64(stat.Dev), 10), Inode: strconv.FormatUint(stat.Ino, 10)}
	run.fixtureFileHash = selfTestFileHash(selfTestFileAfter)
	runtime.mutations.mu.Unlock()
	cleaned, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication)
	if err == nil || cleaned != nil {
		t.Fatalf("cleanup %#v %v", cleaned, err)
	}
	if _, err := os.Lstat(file); err != nil {
		t.Fatal("fixture not retained", err)
	}
	if runtime.mutations.selfTestRun != run || run.cleanupStarted {
		t.Fatal("unqualified cleanup released fence")
	}
	identity := state.Identity{Scope: state.ScopeOwnerSettings, OperationID: id, OwnerID: runtime.mutations.computer.ownerID, ProfileID: runtime.mutations.computer.peer.ProfileId, ComputerID: runtime.mutations.computer.computerID}
	creation, err := runtime.mutations.dependencies.repository.Load(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := state.NewScratchCleanup(creation)
	if err != nil {
		t.Fatal(err)
	}
	journal, ok := runtime.mutations.dependencies.repository.(port.ScratchCleanupRepository)
	if !ok {
		t.Fatal("cleanup journal unavailable")
	}
	stored, err := journal.LoadScratchCleanup(context.Background(), prepared.Binding())
	if err != nil || stored != nil {
		t.Fatal("nonempty fixture admitted empty cleanup", stored, err)
	}
}

func TestNativeScratchRunRetainsFixtureForUnverifiedTestDescendants(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || created.Phase != "completed" {
		t.Fatalf("create %#v %v", created, err)
	}
	runtime.mutations.mu.Lock()
	runtime.mutations.operations["synthetic-test-process"] = &settingsMutationOperation{settled: true, selfTestRun: run, process: &connectorProcessOperation{publication: "durable", result: &processsvc.TerminalResult{Intent: processsvc.Intent{Seal: processsvc.Seal{Write: false}}, Observation: processsvc.Observation{GroupCleanup: processsvc.CleanupConfirmed, DescendantCleanup: processsvc.CleanupUnverified}}}}
	runtime.mutations.mu.Unlock()
	cleaned, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication)
	if err == nil || cleaned != nil {
		t.Fatal("cleanup accepted unverified test descendant", cleaned, err)
	}
	if _, err := os.Lstat(filepath.Join(workspace, created.Scratch.Leaf)); err != nil {
		t.Fatal("fixture removed", err)
	}
	if runtime.mutations.selfTestRun != run || run.cleanupStarted {
		t.Fatal("refused eligibility consumed or released the run")
	}
}

func TestNativeScratchRunCloseJoinsCleanupPreflight(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	created, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
	if err != nil || created == nil || created.Phase != "completed" {
		t.Fatalf("create %#v %v", created, err)
	}
	runtime.ingress.effects.Lock()
	returned := make(chan error, 1)
	go func() {
		_, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication)
		returned <- err
	}()
	deadline := time.After(time.Second)
	for {
		runtime.mutations.mu.Lock()
		active := run.active
		runtime.mutations.mu.Unlock()
		if active {
			break
		}
		select {
		case <-deadline:
			runtime.ingress.effects.Unlock()
			<-returned
			t.Fatal("cleanup preflight did not start")
		case <-time.After(time.Millisecond):
		}
	}
	runtime.mutations.closeSelfTestStageAdmission()
	joined := make(chan struct{})
	go func() { runtime.mutations.waitSelfTestStage(); close(joined) }()
	select {
	case <-joined:
		runtime.ingress.effects.Unlock()
		<-returned
		t.Fatal("close did not join cleanup")
	case <-time.After(20 * time.Millisecond):
	}
	runtime.ingress.effects.Unlock()
	if err := <-returned; err == nil {
		t.Fatal("cancelled cleanup proceeded")
	}
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("close did not join cleanup return")
	}
	if _, err := os.Lstat(filepath.Join(workspace, created.Scratch.Leaf)); err != nil {
		t.Fatal("cancelled cleanup changed directory", err)
	}
	if runtime.mutations.selfTestRun != run {
		t.Fatal("cancelled cleanup released fence")
	}
	if repeated, err := runtime.mutations.cleanupSelfTestScratchForRun(context.Background(), run, publication); err == nil || repeated != nil {
		t.Fatal("cancelled cleanup repeated")
	}
}

func TestNativeRunCloseJoinsApprovalBeforeScratchAdmission(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws)
	if err != nil {
		t.Fatal(err)
	}
	runtime.ingress.effects.Lock()
	returned := make(chan error, 1)
	go func() {
		_, err := runtime.mutations.createSelfTestScratchForRun(context.Background(), run, id, ws, publication)
		returned <- err
	}()
	deadline := time.After(time.Second)
	for {
		runtime.mutations.mu.Lock()
		active := run.active
		runtime.mutations.mu.Unlock()
		if active {
			break
		}
		select {
		case <-deadline:
			runtime.ingress.effects.Unlock()
			<-returned
			t.Fatal("scratch call did not enter its original lifetime")
		case <-time.After(time.Millisecond):
		}
	}
	runtime.mutations.closeSelfTestStageAdmission()
	joined := make(chan struct{})
	go func() { runtime.mutations.waitSelfTestStage(); close(joined) }()
	select {
	case <-joined:
		runtime.ingress.effects.Unlock()
		<-returned
		t.Fatal("close did not join the approval refresh")
	case <-time.After(20 * time.Millisecond):
	}
	runtime.ingress.effects.Unlock()
	if err := <-returned; err == nil {
		t.Fatal("cancelled run reached scratch admission")
	}
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("close did not observe the original call's return")
	}
	runtime.mutations.mu.Lock()
	record, activeRun := runtime.mutations.operations[id], runtime.mutations.selfTestRun
	runtime.mutations.mu.Unlock()
	if record != nil || activeRun != nil {
		t.Fatal("cancelled pre-admission run did not release cleanly")
	}
}

func TestNativeStandaloneScratchJoinsApprovalBeforeAdmission(t *testing.T) {
	launch, runtime := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	publication := nativeSettingsPublication(t, runtime, workspace, 1)
	const id = "00000000-0000-4000-8000-000000000005"
	const ws = "00000000-0000-4000-8000-000000000004"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtime.ingress.effects.Lock()
	returned := make(chan error, 1)
	go func() {
		_, err := runtime.mutations.createSelfTestScratch(ctx, id, ws, publication)
		returned <- err
	}()
	deadline := time.After(time.Second)
	for {
		runtime.mutations.mu.Lock()
		active := runtime.mutations.scratchPreflight != nil
		runtime.mutations.mu.Unlock()
		if active {
			break
		}
		select {
		case <-deadline:
			runtime.ingress.effects.Unlock()
			<-returned
			t.Fatal("standalone call did not reserve preflight")
		case <-time.After(time.Millisecond):
		}
	}
	if run, err := runtime.mutations.beginSelfTestRun(context.Background(), id, ws); err == nil || run != nil {
		runtime.ingress.effects.Unlock()
		<-returned
		t.Fatal("run crossed standalone preflight")
	}
	runtime.mutations.closeSelfTestStageAdmission()
	cancel()
	joined := make(chan struct{})
	go func() { runtime.mutations.waitSelfTestStage(); close(joined) }()
	select {
	case <-joined:
		runtime.ingress.effects.Unlock()
		<-returned
		t.Fatal("close did not join standalone refresh")
	case <-time.After(20 * time.Millisecond):
	}
	runtime.ingress.effects.Unlock()
	if err := <-returned; err == nil {
		t.Fatal("cancelled standalone call reached admission")
	}
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("close did not join standalone return")
	}
	runtime.mutations.mu.Lock()
	record, pending := runtime.mutations.operations[id], runtime.mutations.scratchPreflight
	runtime.mutations.mu.Unlock()
	if record != nil || pending != nil {
		t.Fatal("cancelled standalone preflight left an operation")
	}
}
