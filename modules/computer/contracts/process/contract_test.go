package process

import (
	"errors"
	"reflect"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestBoundaryDTOsContainNoExecutionOrAuthoritySelector(t *testing.T) {
	for _, value := range []any{StartRequest{}, ReadRequest{}, CancelRequest{}} {
		shape := reflect.TypeOf(value)
		for i := 0; i < shape.NumField(); i++ {
			switch shape.Field(i).Name {
			case "Executable", "Args", "Environment", "Root", "TaskID", "ParticipantID", "Generation", "Lease", "Deadline":
				t.Fatal("request can select execution/authority", shape)
			}
		}
	}
	if _, err := New(nil); err == nil {
		t.Fatal("nil owner accepted")
	}
}
func TestUnknownRefusedAndNativeDetailsRemainDistinct(t *testing.T) {
	for _, input := range []struct {
		err           error
		code, outcome string
	}{
		{&processsvc.Failure{Code: "PROCESS_OUTCOME_UNKNOWN", Unknown: true}, "PROCESS_OUTCOME_UNKNOWN", "outcome_unknown"},
		{&processsvc.Failure{Code: "PROCESS_NATIVE_REFUSED"}, "PROCESS_NATIVE_REFUSED", "refused"},
		{authority.Fail("AUTHORITY_EXPIRED", "task-grant"), "AUTHORITY_EXPIRED", "refused"},
		{authority.Fail("raw /private/owned-path", "host"), "PROCESS_UNAVAILABLE", "outcome_unknown"},
		{errors.New("raw host detail /private/owned-path"), "PROCESS_UNAVAILABLE", "outcome_unknown"},
	} {
		err := failure(input.err)
		var out *Failure
		if !errors.As(err, &out) || out.Code != input.code || out.Outcome != input.outcome || out.Retry != "never" {
			t.Fatal(out)
		}
	}
}
