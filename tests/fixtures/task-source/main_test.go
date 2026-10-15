package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	source "github.com/legrch/farol/modules/task/contracts/currentsource"
)

func TestRealContractClassifiesInvalidAndSentinelSeparately(t *testing.T) {
	input := `{"settings":"{","nowMillis":0}` + "\n" + `{"settings":"{\"status\":\"settings-invalid\"}","nowMillis":0}` + "\n"
	var output bytes.Buffer
	if err := serve(strings.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "{\"error\":\"TASK_CURRENT_SOURCE_INVALID\"}\n{\"status\":\"absent\"}\n" {
		t.Fatalf("wrong original replies: %s", output.String())
	}
}
func TestRealContractUnavailableIsNotAbsence(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out, err := compose().Resolve(ctx, source.Request{Settings: []byte(`{"status":"settings-invalid"}`)})
	if out != nil || err == nil || err.Error() != "TASK_CURRENT_SOURCE_UNAVAILABLE" {
		t.Fatalf("unavailable hidden as absence: %+v %v", out, err)
	}
}
func TestFixtureBoundsLineInput(t *testing.T) {
	if err := serve(strings.NewReader(strings.Repeat(" ", 2<<20)), &bytes.Buffer{}); err == nil {
		t.Fatal("unbounded fixture line")
	}
}
