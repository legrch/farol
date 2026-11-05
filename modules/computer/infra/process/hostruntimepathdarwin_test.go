//go:build darwin

package process

import (
	"context"
	"testing"
)

func TestHostRuntimeUserPathSyntaxIsClosed(t *testing.T) {
	for _, tc := range []struct {
		path  string
		valid bool
	}{
		{"/opt/homebrew/bin:/usr/bin", true},
		{"/opt/homebrew/bin:/opt/homebrew/bin", true},
		{"", false},
		{"/opt/homebrew/bin:", false},
		{".:/usr/bin", false},
		{"/usr/../bin", false},
		{"/usr/bin\x00:/bin", false},
	} {
		if validHostSearchPath(tc.path) != tc.valid {
			t.Fatalf("PATH syntax verdict mismatch: %q", tc.path)
		}
	}
}

func TestHostRuntimeTerminalUsesInheritedUserPath(t *testing.T) {
	t.Setenv("TERM", "xterm-256color")
	t.Setenv("TERM_PROGRAM", "TestTerminal")
	t.Setenv("PATH", "/owner/first:/usr/bin")
	selected, err := CaptureUserExecutablePath(context.Background())
	if err != nil || selected != "/owner/first:/usr/bin" {
		t.Fatalf("Terminal PATH was replaced: %q %v", selected, err)
	}
}
