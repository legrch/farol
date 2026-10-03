// Package intent provides the injected canonical intent digest, without IO.
package intent

import (
	"crypto/sha256"
	"encoding/hex"
)

type SHA256 struct{}

func (SHA256) Digest(input []byte) (string, error) {
	digest := sha256.Sum256(input)
	return hex.EncodeToString(digest[:]), nil
}
