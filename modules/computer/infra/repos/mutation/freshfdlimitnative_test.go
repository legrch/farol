//go:build darwin

package mutation

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// Run the resource limit in a child so the test never changes the parent
// process or the owner's application. This verifies refusal and preservation,
// not that a low-limit host can start with this much history.
func TestFreshInventoryLowDescriptorLimitPreservesHistory(t *testing.T) {
	const childFlag = "FAROL_TEST_FRESH_LOW_FD_CHILD"
	if os.Getenv(childFlag) == "1" {
		var limit unix.Rlimit
		if err := unix.Getrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
			t.Fatal(err)
		}
		if limit.Max < 128 {
			t.Skip("host hard descriptor limit is below the test limit")
		}
		limit.Cur = 128
		if err := unix.Setrlimit(unix.RLIMIT_NOFILE, &limit); err != nil {
			t.Fatal(err)
		}
		selection, entries := freshHistoryBoundaryFixture(t, 256)
		root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
		before := settledNativeSnapshot(t, root.Path)
		r, err := New(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		unknown, inspectErr := r.InspectFreshProcesses(context.Background(), selection)
		closeErr := r.Close()
		if inspectErr == nil || unknown || closeErr != nil {
			t.Fatalf("limited inventory must refuse: unknown=%v inspect=%v close=%v", unknown, inspectErr, closeErr)
		}
		settledNativePreserved(t, root.Path, before)
		return
	}
	cmd := exec.Command(os.Args[0], "-test.v", "-test.run=^TestFreshInventoryLowDescriptorLimitPreservesHistory$")
	cmd.Env = append(os.Environ(), childFlag+"=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("low descriptor child failed: %v\n%s", err, output)
	}
	if strings.Contains(string(output), "--- SKIP:") {
		t.Skip("child could not exercise its descriptor limit")
	}
	if !strings.Contains(string(output), "--- PASS: TestFreshInventoryLowDescriptorLimitPreservesHistory") {
		t.Fatalf("child did not report the expected test result: %s", output)
	}
}
