package boot

import (
	"context"
	"encoding/json"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/transport/desktop"
)

// Drain this new session only. No predecessor receipt, ACK or Consume is minted.
func (r *NativeRuntime) freshSessionMethods() map[string]desktop.Method {
	if r.fresh == nil {
		return nil
	}
	return map[string]desktop.Method{
		"core.fresh.status": {Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			if request.OperationID != "" || wire.Validate("Empty", request.Body) != nil {
				return invalidIngress()
			}
			raw, err := json.Marshal(wire.CoreFreshStatus{InterruptedCommand: r.historicalProcessUnknown})
			return &desktop.Outcome{Status: "ok", Data: raw}, err
		}},
		"core.fresh.close": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			r.freshCloseMu.Lock()
			defer r.freshCloseMu.Unlock()
			var in wire.CoreFreshClose
			if r.freshCloseAttempted || request.OperationID == "" || chatDecode("CoreFreshClose", request, &in) != nil {
				return &desktop.Outcome{Status: "refused", Code: "FRESH_SESSION_CLOSE_REFUSED"}, nil
			}
			r.freshCloseAttempted = true
			fail := func() (*desktop.Outcome, error) {
				return &desktop.Outcome{Status: "unknown", Code: "FRESH_SESSION_DRAIN_UNCONFIRMED"}, nil
			}
			if r.fresh.verify() != nil || r.closeCodexRead() != nil || r.ingress.freezeForRetirement(ctx) != nil {
				return fail()
			}
			r.historyAuthority.close()
			if r.settingsDelivery.freezeForRetirement(ctx) != nil || r.connector.drainProcessesForRetirement(ctx) != nil || r.mutations.freezeForRetirement() != nil || r.chat.FreezeAdmissions(ctx) != nil {
				return fail()
			}
			if _, err := r.chat.Retire(ctx); err != nil {
				return fail()
			}
			if r.browser.QuiescePolling() != nil {
				return fail()
			}
			if r.settingsStore != nil && r.settingsStore.QuiescePolling() != nil {
				return fail()
			}
			if r.fresh.verify() != nil {
				return fail()
			}
			return &desktop.Outcome{Status: "ok", Data: json.RawMessage(`{"drained":true}`)}, nil
		}}}
}
