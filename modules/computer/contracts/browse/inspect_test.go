package browse

import "testing"

func TestInspectWritableFlagIsNilUnlessTrue(t *testing.T) {
	var none *InspectResponse
	if none.WritableFlag() != nil || (&InspectResponse{}).WritableFlag() != nil {
		t.Fatal("flag set when not writable")
	}
	if got := (&InspectResponse{WritableByOthers: true}).WritableFlag(); got == nil || !*got {
		t.Fatal("flag missing when writable")
	}
}
