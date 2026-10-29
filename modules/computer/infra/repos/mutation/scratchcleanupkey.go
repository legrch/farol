package mutation

import (
	"crypto/sha256"
	"encoding/hex"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// scratchCleanupKey has a disjoint hash namespace and is selected solely by
// the original creation identity. It is correlation, not cleanup authority.
func scratchCleanupKey(id domain.Identity) (string, error) {
	if !domain.ValidIdentity(id) || id.Scope != domain.ScopeOwnerSettings || !domain.ScratchLeaf(domain.ScratchPath(id.OperationID)) {
		return "", failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	raw := `["owner-selftest-cleanup-v1",` + quoteJS(id.OperationID) + "," + quoteJS(id.OwnerID) + "," + quoteJS(id.ProfileID) + "," + quoteJS(id.ComputerID) + "]"
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:]) + ".json", nil
}
