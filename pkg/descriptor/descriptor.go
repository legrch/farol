// Package descriptor holds stateless file-descriptor primitives shared by
// module infrastructure: stat identity of an open descriptor, the private-file
// predicate and temporary-name minting. Atomic protocols (create, publish,
// rename, cleanup) and their refusal classification stay with each caller.
package descriptor

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
)

// Name mints a temporary entry name: prefix, size random bytes in lowercase
// hex, then suffix. A randomness failure is returned unchanged and no name is
// produced, so callers keep classifying it exactly as before. The name is
// unpredictable, not reserved: callers still create it with O_EXCL.
func Name(prefix string, size int, suffix string) (string, error) {
	if size <= 0 {
		return "", errors.New("descriptor: temporary name size must be positive")
	}
	nonce := make([]byte, size)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(nonce) + suffix, nil
}
