// Package id holds the one predicate for an opaque identifier.
package id

import (
	"strings"
	"unicode/utf8"
)

// size is the longest accepted identifier in bytes.
const size = 120

// Valid reports whether s is an opaque identifier: 1 to 120 bytes of valid
// UTF-8 with no rune at or below U+0020 and no U+007F. Other control runes,
// such as C1 controls, are accepted; a caller that must reject them keeps its
// own stricter check.
func Valid(s string) bool {
	if len(s) < 1 || len(s) > size || !utf8.ValidString(s) {
		return false
	}
	return strings.IndexFunc(s, func(r rune) bool { return r <= 32 || r == 127 }) < 0
}
