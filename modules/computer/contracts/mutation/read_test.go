package mutation

import (
	"context"
	"errors"
	"testing"
)

func TestMutationContractReadCannotDispatchOrAcknowledge(t *testing.T) {
	c, _, store, native, r := contractFixture(t)
	out, err := c.Read(context.Background(), r)
	var failure *Failure
	if out != nil || !errors.As(err, &failure) || failure.Code != "COMPUTER_MUTATION_OPERATION_NOT_FOUND" || native.calls != 0 || store.admit != 0 || store.save != 0 {
		t.Fatalf("%#v %v", out, err)
	}
	_, err = c.Execute(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	r.CallID = "read"
	out, err = c.Read(context.Background(), r)
	if err != nil || out.Phase != "completed" || out.CallID != "read" || native.calls != 1 || store.admit != 1 || store.save != 1 {
		t.Fatalf("%#v %v", out, err)
	}
}
