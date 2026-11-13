package id

import (
	"strings"
	"testing"
	"unicode/utf8"
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

// retired is the predicate that eighteen chat packages carried as private
// copies before Valid replaced them (rune loop form).
func retired(s string) bool {
	if len(s) < 1 || len(s) > 120 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r <= 32 || r == 127 {
			return false
		}
	}
	return true
}

// retiredIndexFunc is the same predicate as written with strings.IndexFunc.
func retiredIndexFunc(s string) bool {
	return len(s) > 0 && len(s) <= 120 && utf8.ValidString(s) && strings.IndexFunc(s, func(r rune) bool { return r <= 32 || r == 127 }) < 0
}

func TestValidMatchesRetiredCopies(t *testing.T) {
	corpus := []string{"", "a", strings.Repeat("a", 119), strings.Repeat("a", 120), strings.Repeat("a", 121), strings.Repeat("é", 60), strings.Repeat("é", 61), "\xff", "a\xffb"}
	for r := rune(0); r < 0x300; r++ {
		corpus = append(corpus, "x"+string(r)+"y", string(r))
	}
	for _, r := range []rune{0x2028, 0x2029, 0xfeff, 0xffff, 0x10000, 0x10ffff} {
		corpus = append(corpus, "x"+string(r)+"y")
	}
	for _, s := range corpus {
		if got, want := Valid(s), retired(s); got != want {
			t.Fatalf("Valid(%q) = %v, retired loop = %v", s, got, want)
		}
		if got, want := Valid(s), retiredIndexFunc(s); got != want {
			t.Fatalf("Valid(%q) = %v, retired IndexFunc = %v", s, got, want)
		}
	}
}
