//go:build darwin

package boot

import (
	"bytes"
	"context"
	"strings"
	"testing"

	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
)

// The continuation is the desktop's answer to the ready ACK alone. This table
// pins that decision without a child process: a valid refused frame is a real
// terminal answer, and writing a continuation after it races the helper's pipe
// closure.
func TestClosedHelperShouldContinueOnlyAfterTheExactReadyFrame(t *testing.T) {
	requestBytes := closedHelperJSON(t, closedHelperRequestFixture())
	ready := closedHelperReadyFrame(t, requestBytes)
	refused := wantRefusedFrame(t, requestBytes, "app_missing")

	other := closedHelperRequestFixture()
	other["operationId"] = strings.Repeat("2", 32)
	wrongOperation := closedHelperReadyFrame(t, closedHelperJSON(t, other))
	if bytes.Equal(ready, wrongOperation) {
		t.Fatal("fixture does not distinguish operation IDs")
	}

	cases := []struct {
		name string
		ack  []byte
		want bool
	}{
		{"exact ready frame", ready, true},
		{"exact refused frame", refused, false},
		{"empty", nil, false},
		{"malformed", []byte(`{"schema":`), false},
		{"oversized", bytes.Repeat([]byte("x"), 4097), false},
		{"ready frame with trailing byte", append(append([]byte(nil), ready...), '\n'), false},
		{"ready frame for another operation", wrongOperation, false},
		{"wrong kind", bytes.Replace(ready, []byte(protocolapp.ClosedPredecessorReady), []byte(protocolapp.Refused), 1), false},
	}
	for _, c := range cases {
		if got := closedHelperShouldContinue(requestBytes, c.ack); got != c.want {
			t.Errorf("%s: continue = %v, want %v", c.name, got, c.want)
		}
	}
	if closedHelperShouldContinue([]byte(`not a request`), ready) {
		t.Error("an unbindable request released the helper")
	}
}

func closedHelperReadyFrame(t *testing.T, requestBytes []byte) []byte {
	t.Helper()
	protocol, err := protocolapp.Bind(context.Background(), requestBytes, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	ready, err := protocol.BuildHandoff(context.Background(), protocolapp.ClosedPredecessorReady, nil)
	if err != nil {
		t.Fatal(err)
	}
	return ready
}
