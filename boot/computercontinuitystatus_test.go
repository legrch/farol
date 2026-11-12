package boot

import (
	"context"
	"encoding/json"
	"testing"

	journal "github.com/legrch/farol/modules/computer/domain/journal"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
)

type continuityStatusStore struct {
	computerIngressStore
	state          accessrepo.TransitionState
	qualified      bool
	inspections    int
	qualifications int
}

func (f *continuityStatusStore) TransitionStatus(context.Context) (accessrepo.TransitionState, error) {
	f.inspections++
	return f.state, nil
}
func (f *continuityStatusStore) CurrentContinuityStatus(context.Context) (accessrepo.CurrentTransitionReceipt, error) {
	f.qualifications++
	if !f.qualified {
		return accessrepo.CurrentTransitionReceipt{}, computerUnavailable()
	}
	return accessrepo.CurrentTransitionReceipt{OperationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, nil
}
func TestContinuityStatusNoAuthorityOrHistoricalDeliveryClaim(t *testing.T) {
	f := &continuityStatusStore{state: accessrepo.TransitionState{Present: true, Restricted: true, Delivery: "not_recorded", Journal: journal.Journal{Entries: []journal.Entry{{Request: journal.Request{OperationID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}, Phase: journal.WithdrawIntent}}}}}
	s := &ComputerIngress{store: f}
	method := s.ownerMethods()["computer.continuity.status"]
	response, err := method.Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{}`)})
	if err != nil || response.Status != "ok" {
		t.Fatal("pending WAL not inspectable", err, response)
	}
	var v map[string]any
	if json.Unmarshal(response.Data, &v) != nil || v["restricted"] != true || v["currentQualified"] != false || v["pendingOperationId"] != "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" || v["delivery"] != "not_recorded" || f.qualifications != 0 {
		t.Fatal("pending WAL misreported", v)
	}
	for _, input := range []string{`{"operationId":"no"}`, `{"admin":true}`, `null`, `[]`} {
		denied, e := method.Handle(context.Background(), desktop.Request{Body: json.RawMessage(input)})
		if e != nil || denied.Status != "refused" {
			t.Fatalf("unexpected input %q admitted: %+v, %v", input, denied, e)
		}
	}
	f.state.Restricted = false
	f.state.Journal.Entries[0].Phase = journal.Committed
	f.qualified = false
	response, err = method.Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{}`)})
	if err != nil || response.Status != "ok" {
		t.Fatal(err)
	}
	v = nil
	if json.Unmarshal(response.Data, &v) != nil || v["currentQualified"] != false || v["restricted"] != false || v["pendingOperationId"] != nil {
		t.Fatal("historical certificate counted as live", v)
	}
	f.qualified = true
	response, err = method.Handle(context.Background(), desktop.Request{Body: json.RawMessage(`{}`)})
	if err != nil || response.Status != "ok" {
		t.Fatal(err)
	}
	v = nil
	if json.Unmarshal(response.Data, &v) != nil || v["currentQualified"] != true {
		t.Fatal("current-qualified observation", v)
	}
}
