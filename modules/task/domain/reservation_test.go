package task

import (
	"strings"
	"testing"
)

// CPU-only path policy regression; no physical path or native API is inspected.
func TestReservationPureCanonicalPOSIXPaths(t *testing.T) {
	for _, s := range []string{"/fixture/writer", "/fixture/é", "/" + strings.Repeat("a", 255)} {
		if !nativePath(s) {
			t.Fatalf("canonical rejected: %q", s)
		}
	}
	for _, s := range []string{"", "/", "relative", "/a/", "/a//b", "/a/./b", "/a/../b", "/a\x00b", "/a\nb", "/a\tb", "/a\rb", "/a\x7fb", "/" + strings.Repeat("a", 256), "/bad" + string([]byte{255})} {
		if nativePath(s) {
			t.Fatalf("noncanonical accepted: %q", s)
		}
	}
}
