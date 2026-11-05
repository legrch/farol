package boot

import (
	"os/exec"
	"strings"
	"testing"
)

func TestGitUnavailableDiagnosticCannotExecuteSelectedPathText(t *testing.T) {
	selected := "/opt/homebrew/bin/it's-$HOME-$(exit 0)/git"
	script := gitUnavailablePreamble(selected, "HOST_RUNTIME_SHARED_WRITABLE", "/opt/homebrew/bin is group-writable") + "git"
	cmd := exec.Command("/bin/bash", "--noprofile", "--norc", "-c", script)
	output, err := cmd.CombinedOutput()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 126 {
		t.Fatalf("unqualified Git did not fail with exit 126: %v %q", err, output)
	}
	message := string(output)
	if !strings.Contains(message, selected) || !strings.Contains(message, "Farol did not select another Git") {
		t.Fatalf("diagnostic lost the exact selected path or no-fallback reason: %q", message)
	}
}
