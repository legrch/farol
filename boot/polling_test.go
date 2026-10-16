package boot

import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

// Actual boot mapping/owner with injected journal/endpoint; no socket or provider.
func TestPollingIsHostOnlyCurrentBoundReadWithoutPublication(t *testing.T) {
	s, j, _, endpoint, input := newConnectorFixture(t)
	opened, err := s.Open(context.Background(), "open", input)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := endpoint.methods["computer.connector.polling"]; ok {
		t.Fatal("external endpoint gained host metric input")
	}
	method := s.Methods()["computer.connector.polling"]
	call := func(in wire.ComputerConnectorPollingRequest, op string) (*desktop.Outcome, error) {
		t.Helper()
		raw, _ := json.Marshal(in)
		out, err := method.Handle(context.Background(), desktop.Request{Body: raw, OperationID: op})
		return out, err
	}
	now := s.clock.Now().UnixMilli()
	last := pollingString(uint64(now - 1000))
	cycles := "10"
	query := wire.ComputerConnectorPollingRequest{Binding: opened.Endpoint.Binding, Samples: wire.ComputerConnectorPollingSamples{Cycles: &cycles, LastSuccessMillis: &last}}
	out, err := call(query, "")
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("ComputerConnectorPollingState", out.Data) != nil {
		t.Fatal(out)
	}
	var view wire.ComputerConnectorPollingState
	if json.Unmarshal(out.Data, &view) != nil || view.State != "recent" || view.Binding != opened.Endpoint.Binding || view.AgeSeconds == nil || *view.AgeSeconds != "1" {
		t.Fatal(view)
	}
	if j.publications != 1 || j.withdrawals != 0 {
		t.Fatal("query wrote journal")
	}
	query.Binding.RuntimeId = "crossed"
	if out, err := call(query, ""); err == nil && out != nil && out.Status == "ok" {
		t.Fatal("crossed runtime accepted")
	}
	query.Binding = opened.Endpoint.Binding
	if out, err := call(query, "invented-effect"); err == nil && out != nil && out.Status == "ok" {
		t.Fatal("operation id accepted for read")
	}
}
func pollingString(number uint64) string { return *pollingDecimal(&number) }
