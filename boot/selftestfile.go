package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
)

const selfTestFileAfter = "Farol self-test verified\n"

func selfTestFileHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

// mutateFixture refuses file effects until the original directory and file
// descriptors are held continuously across publication, edit and shutdown.
// Recorded inode and digest values alone cannot establish that custody.
func (r *selfTestRunLease) mutateFixture(ctx context.Context, connector *computerConnector, slot *connectorSlot, operation, call string, edit bool) (*mutationct.ConnectorResponse, error) {
	return nil, computerUnavailable()
}
