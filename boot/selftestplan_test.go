package boot

import (
	"context"
	"errors"
	"testing"

	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
)

type plannedSelfTest struct {
	calls          []string
	failAt, status string
}

type blockingSelfTest struct {
	*plannedSelfTest
	entered, release chan struct{}
}

type plannedSelfTestV2 struct {
	*plannedSelfTest
	ids           selfTestIDs
	cleanupStatus string
}

func (p *plannedSelfTestV2) workspaceIDs() selfTestIDs { return p.ids }
func (p *plannedSelfTestV2) workspaceCheck(_ context.Context, name, operation string) selfTestStep {
	out := p.step(name)
	out.Operation = operation
	return out
}
func (p *plannedSelfTestV2) cleanup(context.Context) selfTestStep {
	out := p.step("cleanup")
	if p.cleanupStatus != "" {
		out.Status = p.cleanupStatus
	}
	return out
}

func (p *blockingSelfTest) create(ctx context.Context) selfTestStep {
	close(p.entered)
	<-p.release
	return p.plannedSelfTest.create(ctx)
}

func (p *plannedSelfTest) step(name string) selfTestStep {
	p.calls = append(p.calls, name)
	status := "pass"
	if name == p.failAt {
		status = p.status
	}
	return selfTestStep{Name: name, Status: status, Operation: name + "-original"}
}
func (p *plannedSelfTest) create(context.Context) selfTestStep  { return p.step("scratch") }
func (p *plannedSelfTest) write(context.Context) selfTestStep   { return p.step("write") }
func (p *plannedSelfTest) edit(context.Context) selfTestStep    { return p.step("edit") }
func (p *plannedSelfTest) observe(context.Context) selfTestStep { return p.step("mutation read") }
func (p *plannedSelfTest) cleanup(context.Context) selfTestStep { return p.step("cleanup") }
func (p *plannedSelfTest) shell(_ context.Context, kind selfTestShellKind) selfTestStep {
	if kind == selfTestShellQuick {
		return p.step("shell")
	}
	if kind == selfTestShellGitVersion {
		return p.step("git availability")
	}
	return p.step("shell cancel")
}

func TestSelfTestV4RunsGitAvailabilityOnceAndDoesNotClaimHooks(t *testing.T) {
	ids, ok := selfTestIDsV4("00000000-0000-4000-8000-000000000001")
	if !ok {
		t.Fatal("invalid v4 identities")
	}
	duplicate := ids
	duplicate.gitVersionCall = ids.gitVersion
	if duplicate.valid() {
		t.Fatal("Git identities overlap")
	}
	for _, status := range []string{"pass", "fail", "unknown"} {
		p := &plannedSelfTestV2{plannedSelfTest: &plannedSelfTest{failAt: "git availability", status: status}, ids: ids}
		out := runSelfTestPlanV4(context.Background(), p)
		if len(p.calls) != 14 || p.calls[10] != "cleanup" || p.calls[13] != "git availability" || out.Steps[13].Status != status {
			t.Fatal("Git check order or outcome incorrect", status, out, p.calls)
		}
		if status == "pass" && (out.Status != "partial" || len(out.Steps) != 15 || out.Steps[14].Status != "not_tested") {
			t.Fatal("Git availability promoted to hooks proof", out)
		}
		if status != "pass" && (out.Status != map[string]string{"fail": "fail", "unknown": "unknown"}[status] || len(out.Steps) != 14) {
			t.Fatal("Git failure or unknown was hidden", out)
		}
	}
}

func TestSelfTestPlanRunsCleanupBeforeShellAndStopsUnknown(t *testing.T) {
	for _, name := range []string{"", "scratch", "write", "edit", "mutation read", "cleanup", "shell", "shell cancel"} {
		p := &plannedSelfTest{failAt: name, status: "unknown"}
		out := runSelfTestPlan(context.Background(), p)
		if name == "" {
			if out.Status != "partial" || len(out.Steps) != 9 || len(p.calls) != 7 || p.calls[4] != "cleanup" || p.calls[5] != "shell" {
				t.Fatal("wrong success order", out, p.calls)
			}
			continue
		}
		if out.Status != "unknown" || len(p.calls) == 0 || p.calls[len(p.calls)-1] != name || out.Steps[len(out.Steps)-1].Operation != name+"-original" {
			t.Fatal("unknown lost or repeated", name, out, p.calls)
		}
	}
	p := &plannedSelfTest{failAt: "write", status: "fail"}
	if out := runSelfTestPlan(context.Background(), p); out.Status != "fail" || len(p.calls) != 2 {
		t.Fatal("refusal continued", out)
	}
}

func TestSelfTestV2CleansOnceAfterKnownReadFailure(t *testing.T) {
	ids, _ := selfTestIDsV2("00000000-0000-4000-8000-000000000001")
	for _, name := range []string{"catalogue", "bootstrap", "list", "read", "search"} {
		for _, cleanupStatus := range []string{"pass", "fail", "unknown"} {
			p := &plannedSelfTestV2{plannedSelfTest: &plannedSelfTest{failAt: name, status: "fail"}, ids: ids, cleanupStatus: cleanupStatus}
			out := runSelfTestPlanV2(context.Background(), p)
			want := "fail"
			if cleanupStatus == "unknown" {
				want = "unknown"
			}
			if out.Status != want || len(out.Steps) != 10 || p.calls[len(p.calls)-1] != "cleanup" || out.Steps[9].Status != cleanupStatus {
				t.Fatal("failed read did not retain and clean", name, cleanupStatus, out, p.calls)
			}
		}
		p := &plannedSelfTestV2{plannedSelfTest: &plannedSelfTest{failAt: name, status: "unknown"}, ids: ids}
		out := runSelfTestPlanV2(context.Background(), p)
		if out.Status != "unknown" || p.calls[len(p.calls)-1] != name {
			t.Fatal("unknown was repeated or cleaned", name, out, p.calls)
		}
	}
}

func TestSelfTestV3DirectoryCheckPrecedesCleanupAndRetainsUnknown(t *testing.T) {
	ids, ok := selfTestIDsV3("00000000-0000-4000-8000-000000000001")
	if !ok || ids.directorySearch != ids.run+"-st3-directory-search" {
		t.Fatal("invalid v3 IDs", ids)
	}
	duplicate := ids
	duplicate.directorySearch = duplicate.write
	if duplicate.valid() {
		t.Fatal("directory identity aliases a mutation")
	}
	for _, status := range []string{"pass", "fail", "unknown"} {
		p := &plannedSelfTestV2{plannedSelfTest: &plannedSelfTest{failAt: "directory search", status: status}, ids: ids}
		out := runSelfTestPlanV3(context.Background(), p)
		if out.Steps[9].Name != "directory search" || out.Steps[9].Operation != ids.directorySearch || out.Steps[9].Status != status {
			t.Fatal("directory check lost", status, out)
		}
		switch status {
		case "pass":
			if out.Status != "partial" || len(out.Steps) != 14 || p.calls[10] != "cleanup" || out.Steps[13].Status != "not_tested" {
				t.Fatal("wrong v3 success ordering", out, p.calls)
			}
		case "fail":
			if out.Status != "fail" || len(out.Steps) != 11 || p.calls[len(p.calls)-1] != "cleanup" {
				t.Fatal("known failure did not clean once", out, p.calls)
			}
		case "unknown":
			if out.Status != "unknown" || len(out.Steps) != 10 || p.calls[len(p.calls)-1] != "directory search" {
				t.Fatal("unknown check repeated or cleaned", out, p.calls)
			}
		}
	}
}

func TestSelfTestUnsettledErrorNeverBecomesRefusal(t *testing.T) {
	err := &connectorMutationUnsettled{cause: &mutationct.Failure{Code: "AUTHORITY_PATH_DENIED", Retry: "never"}}
	if out := selfTestFailure("write", "op", err); out.Status != "unknown" || out.Operation != "op" {
		t.Fatal("unsettled classified as refusal", out)
	}
	if out := selfTestFailure("write", "op", errors.New("lost result")); out.Status != "unknown" {
		t.Fatal("unclassified error promoted", out)
	}
}

func TestSelfTestPlanIDsAreBoundAndDistinct(t *testing.T) {
	first, ok := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	second, okAgain := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	if !ok || !okAgain || first != second || first.write != first.run+"-st1-write" {
		t.Fatal("child IDs not deterministic", first)
	}
	if _, ok := selfTestIDsV1("invalid"); ok {
		t.Fatal("invalid parent accepted")
	}
	newIDs, valid := selfTestIDsV2(first.run)
	if !valid || newIDs.write == first.write || newIDs.catalogue != first.run+"-st2-catalogue" || newIDs.search != first.run+"-st2-search" {
		t.Fatal("version two identities crossed original plan", newIDs)
	}
	duplicate := newIDs
	duplicate.read = duplicate.write
	if duplicate.valid() {
		t.Fatal("read identity aliases an effect")
	}
	duplicate = newIDs
	duplicate.search = ""
	if duplicate.valid() {
		t.Fatal("incomplete read identities accepted")
	}
	ids := selfTestIDs{run: "00000000-0000-4000-8000-000000000001", write: "write", writeCall: "write-call", edit: "edit", editCall: "edit-call", quick: "quick", quickCall: "quick-call", quickCancel: "quick-cancel", cancel: "cancel", cancelCall: "cancel-call", cancelOperation: "cancel-op"}
	if !ids.valid() {
		t.Fatal("valid IDs refused")
	}
	ids.cancelOperation = ids.write
	if ids.valid() {
		t.Fatal("duplicate IDs accepted")
	}
	ids.cancelOperation, ids.run = "cancel-op", "not-a-scratch-uuid"
	if ids.valid() {
		t.Fatal("invalid run identity accepted")
	}
}

func TestSelfTestPlanRefusesMissingConnectorBeforeScratch(t *testing.T) {
	connector, _, journal, _ := selfTestFileFixture(t)
	plan := &connectorSelfTestPlan{connector: connector, workspace: "work", ids: selfTestIDs{run: "00000000-0000-4000-8000-000000000002", write: "write", writeCall: "write-call", edit: "edit", editCall: "edit-call", quick: "quick", quickCall: "quick-call", quickCancel: "quick-cancel", cancel: "cancel", cancelCall: "cancel-call", cancelOperation: "cancel-op"}}
	out := plan.create(context.Background())
	if out.Status != "unknown" || plan.run != nil || journal.admits != 0 {
		t.Fatal("missing slot admitted scratch", out)
	}
}

func TestSelfTestExecutionNeverRepeatsOriginalAttempt(t *testing.T) {
	owner := &blockingSelfTest{plannedSelfTest: &plannedSelfTest{}, entered: make(chan struct{}), release: make(chan struct{})}
	execution := &selfTestExecution{owner: owner}
	done := make(chan selfTestReport, 1)
	go func() { done <- execution.execute(context.Background()) }()
	<-owner.entered
	if out := execution.execute(context.Background()); out.Status != "unknown" || len(out.Steps) != 0 {
		t.Fatal("pending result invented", out)
	}
	close(owner.release)
	first := <-done
	if first.Status != "partial" || len(owner.calls) != 7 {
		t.Fatal("original incomplete", first)
	}
	first.Steps[0].Status = "tampered"
	again := execution.execute(context.Background())
	if again.Status != "partial" || again.Steps[0].Status != "pass" || len(owner.calls) != 7 {
		t.Fatal("replayed or aliased", again)
	}
}
