//go:build darwin

package process

import (
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
