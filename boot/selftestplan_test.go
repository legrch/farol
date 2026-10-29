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
	return p.step("shell cancel")
}

func TestSelfTestPlanRunsCleanupBeforeShellAndStopsUnknown(t *testing.T) {
	for _, name := range []string{"", "scratch", "write", "edit", "mutation read", "cleanup", "shell", "shell cancel"} {
		p := &plannedSelfTest{failAt: name, status: "unknown"}
		out := runSelfTestPlan(context.Background(), p)
		if name == "" {
			if out.Status != "pass" || len(p.calls) != 7 || p.calls[4] != "cleanup" || p.calls[5] != "shell" {
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
	if first.Status != "pass" || len(owner.calls) != 7 {
		t.Fatal("original incomplete", first)
	}
	first.Steps[0].Status = "tampered"
	again := execution.execute(context.Background())
	if again.Status != "pass" || again.Steps[0].Status != "pass" || len(owner.calls) != 7 {
		t.Fatal("replayed or aliased", again)
	}
}
