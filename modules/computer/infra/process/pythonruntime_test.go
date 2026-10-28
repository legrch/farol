package process

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
)

// Literal declaration/CPU policy tests, not native or installed authority.
func declaredPythonFixture(t *testing.T) (*GitRuntimeResources, []ExecutablePin) {
	t.Helper()
	raw, err := os.ReadFile("../../../../tests/fixtures/shell-platform-clt-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		GitRuntimeResources *GitRuntimeResources
		Executables         []ExecutablePin
	}
	if json.Unmarshal(raw, &d) != nil || d.GitRuntimeResources == nil || d.GitRuntimeResources.Python == nil {
		t.Fatal("Python declaration missing")
	}
	return d.GitRuntimeResources, d.Executables
}
func TestPythonRuntimeClosedPathsAndExecutableSelection(t *testing.T) {
	original, images := declaredPythonFixture(t)
	if !validGitRuntime(original, images) {
		t.Fatal("declared closure refused")
	}
	for _, kind := range []string{"external-file", "external-directory", "site-packages", "missing-image", "missing-encoding", "duplicate", "traversal", "unsorted", "zero-hash", "overflow"} {
		t.Run(kind, func(t *testing.T) {
			r := cloneGitRuntime(original)
			pins := slices.Clone(images)
			switch kind {
			case "external-file":
				r.Python.Files[0].Path = "/opt/homebrew/foreign.so"
			case "external-directory":
				r.Python.Directories[0].Path = "/Library/Developer/foreign"
			case "site-packages":
				r.Python.Files[0].Path = pythonRuntimeLibrary + "/site-packages/foreign.py"
			case "missing-image":
				pins = slices.DeleteFunc(pins, func(p ExecutablePin) bool { return p.Path == pythonRuntimeLauncher })
			case "missing-encoding":
				r.Python.Files = slices.DeleteFunc(r.Python.Files, func(p ExecutablePin) bool { return p.Path == pythonRuntimeLibrary+"/encodings/utf_8.py" })
			case "duplicate":
				r.Python.Files = append(r.Python.Files, r.Python.Files[0])
			case "traversal":
				r.Python.Directories[0].Entries = []string{"../python3"}
			case "unsorted":
				slices.Reverse(r.Python.Files)
			case "zero-hash":
				r.Python.Files[0].SHA256 = strings.Repeat("0", 64)
			case "overflow":
				r.Python.Files = make([]ExecutablePin, 129)
			}
			if validGitRuntime(r, pins) {
				t.Fatal("unauthorized closure accepted")
			}
		})
	}
	copied := cloneGitRuntime(original)
	original.Python.Files[0].SHA256 = strings.Repeat("f", 64)
	original.Python.Directories[0].Entries[0] = "changed"
	if sameGitRuntime(original, copied) || copied.Python.Directories[0].Entries[0] == "changed" {
		t.Fatal("mutable source alias retained")
	}
}
func TestPythonRuntimeCompilerPreservesLiteralAuthorityAndCommandBudget(t *testing.T) {
	r, images := declaredPythonFixture(t)
	s, command := rootScopedFixture(t)
	s.Executables = images
	s.GitRuntimeResources = r
	command.Executable, command.ExecutableSHA256 = images[0].Path, images[0].SHA256
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	wrapped := copyCommand(command)
	wrapped.Executable, wrapped.ExecutableSHA256 = seatbeltExecutable, s.MechanismSHA256
	wrapped.Args = append(append(slices.Clone(plan.arguments), command.Executable), command.Args...)
	if !validCommand(wrapped) {
		t.Fatal("finite closure exceeded unchanged native command budget")
	}
	if strings.Contains(plan.source, `(subpath "`+pythonRuntimeRoot) || strings.Contains(strings.Join(plan.arguments, "\n"), "="+pythonRuntimeRoot) ||
		!strings.Contains(plan.source, "(deny network*)") || !strings.Contains(plan.source, "(deny process-exec ") || !strings.Contains(plan.source, "farol-python-data") {
		t.Fatal("Python granted broad scope or weakened data/network confinement")
	}
	for _, f := range r.Python.Files {
		if !strings.Contains(plan.source, f.Path) {
			t.Fatal("literal data pin omitted")
		}
	}
}
