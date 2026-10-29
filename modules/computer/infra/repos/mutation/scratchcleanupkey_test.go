package mutation

import (
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestScratchCleanupKeyCannotBeChosenByOrdinaryOwnerOperation(t *testing.T) {
	creation := scratchPrepared(t).Binding().Identity
	key, err := scratchCleanupKey(creation)
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{creation.OperationID, "selftest-cleanup:" + creation.OperationID, "owner-selftest-cleanup-v1"} {
		other := creation
		other.OperationID = operation
		ordinary, err := recordKey(other)
		if err != nil || ordinary == key {
			t.Fatal("ordinary owner key collided with cleanup", operation, err)
		}
	}
	repeated, err := scratchCleanupKey(creation)
	if err != nil || repeated != key {
		t.Fatal("same creation produced another cleanup key", err)
	}
	creation.Scope = domain.ScopeConnector
	if _, err := scratchCleanupKey(creation); err == nil {
		t.Fatal("connector identity accepted as owner cleanup")
	}
}
