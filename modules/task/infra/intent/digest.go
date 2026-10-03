// Package intent supplies the stable persisted-intention fingerprint.
package intent

import (
	"crypto/sha256"
	"encoding/hex"
)

// Fingerprint retains neither canonical intention bytes nor prompt content.
func Fingerprint(canonical []byte) string {
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}
