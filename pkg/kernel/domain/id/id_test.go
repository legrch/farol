package id

import (
	"strings"
	"testing"
)

func TestValid(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"short", "a", true},
		{"typical", "profile-1.backend/2:x", true},
		{"max length", strings.Repeat("a", 120), true},
		{"multibyte", "é", true},
		{"emoji", "\U0001F600", true},
		{"c1 control", "a\u0085b", true},
		{"line separator", "a b", true},
		{"tilde", "a~b", true},
		{"empty", "", false},
		{"over max", strings.Repeat("a", 121), false},
		{"max bytes by multibyte over", strings.Repeat("é", 61), false},
		{"space", "a b", false},
		{"leading space", " a", false},
		{"trailing space", "a ", false},
		{"nul", "a\x00b", false},
		{"newline", "a\nb", false},
		{"tab", "a\tb", false},
		{"unit separator", "a\x1fb", false},
		{"delete", "a\x7fb", false},
		{"invalid utf8", "a\xffb", false},
		{"lone continuation", "\x80", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Valid(c.in); got != c.want {
				t.Fatalf("Valid(%q) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
