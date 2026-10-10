package boot

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/legrch/farol/transport/desktop"
)

// Shared wire invocation for CPU and native retirement tests. Native fixtures
// retain their Darwin build constraints and explicit native-lane admission.
func retirementCall(t *testing.T, runtime *NativeRuntime, name string, body any) *desktop.Outcome {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	method := runtime.retirementMethods()[name]
	result, err := method.Handle(context.Background(), desktop.Request{OperationID: "effect-" + name, Body: raw})
	if err != nil || result == nil {
		t.Fatal(result, err)
	}
	return result
}
