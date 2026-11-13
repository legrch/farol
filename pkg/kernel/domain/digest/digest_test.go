package digest

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestValid(t *testing.T) {
	sum := sha256.Sum256([]byte("farol"))
	real := hex.EncodeToString(sum[:])
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"real digest", real, true},
		{"all zero", strings.Repeat("0", 64), true},
		{"all nine", strings.Repeat("9", 64), true},
		{"all a", strings.Repeat("a", 64), true},
		{"all f", strings.Repeat("f", 64), true},
		{"empty", "", false},
		{"one short", strings.Repeat("a", 63), false},
		{"one long", strings.Repeat("a", 65), false},
		{"double", strings.Repeat("a", 128), false},
		{"uppercase", strings.ToUpper(real), false},
		{"one uppercase", "A" + strings.Repeat("a", 63), false},
		{"first past f", "g" + strings.Repeat("a", 63), false},
		{"last past f", strings.Repeat("a", 63) + "g", false},
		{"byte before zero", "/" + strings.Repeat("a", 63), false},
		{"byte after nine", ":" + strings.Repeat("a", 63), false},
		{"byte before a", "`" + strings.Repeat("a", 63), false},
		{"hex prefix", "0x" + strings.Repeat("a", 62), false},
		{"trailing newline", strings.Repeat("a", 63) + "\n", false},
		{"leading space", " " + strings.Repeat("a", 63), false},
		{"embedded nul", strings.Repeat("a", 31) + "\x00" + strings.Repeat("a", 32), false},
		{"multibyte at 64 bytes", strings.Repeat("a", 61) + "é", false},
		{"invalid utf8 at 64 bytes", strings.Repeat("a", 63) + "\xff", false},
		{"sha256 prefix", "sha256:" + real, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Valid(c.in); got != c.want {
				t.Fatalf("Valid(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
