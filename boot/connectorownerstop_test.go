package boot

import (
	"context"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"testing"
	"time"
)

// Real owner/boot composition with injected endpoint, clock and journals only.
// These fixtures do not prove native endpoint closure or physical UI behavior.
func stopOwnerFixture(t *testing.T) (*computerConnector, *connectorJournalFixture, wire.ComputerConnectorOpen, wire.ComputerConnectorHealthRequest) {
	t.Helper()
	s, j, _, _, in := connectorMutationFixture(t)
	reason := "owner_stop"
	binding := s.current.opened.Endpoint.Binding
	closed, err := s.Close(context.Background(), "owner-stop", wire.ComputerConnectorClose{Binding: binding, Reason: &reason})
	if err != nil || closed == nil || closed.Recovery == nil || *closed.Recovery != "settled" {
		t.Fatal("fixture did not close original", closed, err)
	}
	return s, j, in, wire.ComputerConnectorHealthRequest{Binding: binding, ExpectedInstanceId: binding.RuntimeId}
}

func TestOwnerStoppedHealthUsesOriginalRetiredOwnerWithoutEffects(t *testing.T) {
	s, j, _, query := stopOwnerFixture(t)
	origin := s.closed
	attempts, revision, withdrawals := s.attempts, j.revision, j.withdrawals
	expiry := j.approval.ExpiresAt
	got := healthRead(t, s, query)
	if got.State != "stopped" || got.Reason != "owner_stopped" || got.LocalReady || got.ObservedAtMillis == nil || got.ValidUntilMillis == nil || got.LastPollSuccessMillis != nil || got.LastResponseAcceptedMillis != nil || got.NextRetryMillis != nil {
		t.Fatal("invalid stopped result", got)
	}
	j.clock.now = j.clock.now.Add(time.Second)
	next := healthRead(t, s, query)
	if *next.ObservedAtMillis == *got.ObservedAtMillis || s.current != nil || s.closed != origin || origin.consumed || s.attempts != attempts || j.revision != revision || j.withdrawals != withdrawals || !j.approval.ExpiresAt.Equal(expiry) || s.mutations.recoveryReserved {
		t.Fatal("negative read altered lifecycle or authority")
	}
	if _, err := origin.retiredOwner.Reconnect(context.Background()); err == nil {
		t.Fatal("negative read reactivated old authority")
	}
}

func TestOwnerStoppedHealthRefusesMissingCrossedOrObsoleteOrigin(t *testing.T) {
	for _, mode := range []string{"binding", "instance", "snapshot", "consumed", "cause", "owner", "settings", "expired", "backend-dead", "pending-operation", "unknown-operation", "missing-ledger", "cancelled", "new-open-refused", "new-open-success"} {
		t.Run(mode, func(t *testing.T) {
			s, j, in, query := stopOwnerFixture(t)
			ctx := context.Background()
			switch mode {
			case "binding":
				query.Binding.BackendGeneration = "foreign"
			case "instance":
				query.ExpectedInstanceId = "foreign"
			case "snapshot":
				query.Snapshot = healthWireQuery(uint64(s.clock.Now().UnixMilli()), query.Binding).Snapshot
			case "consumed":
				s.closed.consumed = true
			case "cause":
				s.closed.ownerStopped = false
			case "owner":
				s.closed.owner = "foreign"
			case "settings":
				_, _ = s.root.guard.deactivate()
			case "expired":
				j.clock.now = j.clock.now.Add(24 * time.Hour)
			case "backend-dead":
				s.cancel()
			case "pending-operation":
				s.mutations.operations["pending"] = &settingsMutationOperation{pending: true}
			case "unknown-operation":
				s.mutations.operations["unknown"] = &settingsMutationOperation{}
			case "missing-ledger":
				s.mutations = nil
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "new-open-refused":
				in.RuntimeId = "replacement"
				in.Publication.Fence = "999"
				if _, err := s.Open(ctx, "replacement-refused", in); err == nil {
					t.Fatal("fixture open unexpectedly passed")
				}
			case "new-open-success":
				in.RuntimeId = "replacement"
				if _, err := s.Open(ctx, "replacement", in); err != nil {
					t.Fatal(err)
				}
				defer s.Shutdown()
			}
			out, err := healthCall(t, s, ctx, query, "")
			healthRefused(t, out, err)
		})
	}
}

func TestGenericOrFailedCloseCannotProduceOwnerStoppedHealth(t *testing.T) {
	for _, mode := range []string{"generic", "endpoint-failure", "startup-unknown"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, _, _ := connectorMutationFixture(t)
			binding := s.current.opened.Endpoint.Binding
			reason := "owner_stop"
			request := wire.ComputerConnectorClose{Binding: binding, Reason: &reason}
			switch mode {
			case "generic":
				request.Reason = nil
			case "endpoint-failure":
				s.current.endpoint.(*connectorEndpointFixture).fail = true
			case "startup-unknown":
				s.current.startupUncertain = true
			}
			_, err := s.Close(context.Background(), "close", request)
			if (err != nil) != (mode != "generic") {
				t.Fatal("unexpected Close result", err)
			}
			out, readErr := healthCall(t, s, context.Background(), wire.ComputerConnectorHealthRequest{Binding: binding, ExpectedInstanceId: binding.RuntimeId}, "")
			healthRefused(t, out, readErr)
		})
	}
}
