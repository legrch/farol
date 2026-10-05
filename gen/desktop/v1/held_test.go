package desktop

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHeldControlSchemaPreservesExactIdentityAndBarrierBounds(t *testing.T) {
	i := ComputerHeldIdentity{BuildId: "build", ProfileId: "profile", BackendGeneration: "backend", OperationId: "operation", SealSha256: strings.Repeat("a", 64), AnchorLifetimeId: "anchor", ChildLaunchId: "held", Deadline: "2026-10-05T19:00:00.123456789Z"}
	for _, value := range []uint32{0, 1, 2, 3, 4294967295} {
		in := ComputerHeldBarrier{Identity: i, Barrier: value}
		raw, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		if (Validate("ComputerHeldBarrier", raw) == nil) != (value == 1 || value == 2) {
			t.Fatal("barrier bound changed", value)
		}
		if value == 1 || value == 2 {
			var out ComputerHeldBarrier
			if json.Unmarshal(raw, &out) != nil || out != in {
				t.Fatal("identity changed across typed decode")
			}
		}
	}
	if !KnownMethod("computer.process.held.ready") || RequiresOperationID("computer.process.held.ready") || !RequiresOperationID("computer.process.held.release") || KnownMethod("computer.process.held.exec") {
		t.Fatal("held effect classification changed")
	}
}
