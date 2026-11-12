package observation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/legrch/farol/modules/computer/app/port"
	observation "github.com/legrch/farol/modules/computer/domain/observation"
)

// Digester supplies deterministic observation hashing without ambient app I/O.
type Digester struct{}

var _ port.ObservationDigester = Digester{}

func (Digester) Digest(value observation.Observation) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
