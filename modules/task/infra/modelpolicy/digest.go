package modelpolicy

import (
	"crypto/sha256"
	"encoding/hex"
)

type SHA256Digester struct{}

func (SHA256Digester) Digest(canonical []byte) (string, error) {
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}
