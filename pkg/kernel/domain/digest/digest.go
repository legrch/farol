// Package digest holds the one predicate for a hex-encoded SHA-256 value.
package digest

// size is the encoded length of a SHA-256 digest.
const size = 64

// Valid reports whether s is exactly 64 lowercase hexadecimal ASCII bytes.
// The empty string, uppercase hex, any other byte and any other length are
// invalid.
func Valid(s string) bool {
	if len(s) != size {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
