package boot

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain"
	"github.com/legrch/farol/transport/desktop"
)

// Aggregate source fixtures only: real boot mapping and owner policy with an
// injected clock, journal and endpoint. No sockets, HTTP or native-host evidence.
func healthWireQuery(now uint64, binding wire.ComputerConnectorBinding) wire.ComputerConnectorHealthRequest {
	return wire.ComputerConnectorHealthRequest{Binding: binding, ExpectedInstanceId: "instance-health", Snapshot: &wire.ComputerConnectorHealthSnapshot{
		SnapshotAtMillis: healthTestDecimal(now), RuntimeInstanceId: "instance-health", RuntimeStartedAtMillis: healthTestDecimal(now - 200_000),
		RuntimeLifecycle: "running", Live: true, Ready: true,
		ControlPlane: &wire.ComputerConnectorControlHealth{
			Status: "ok", State: "idle", ObservedAtMillis: healthString(healthTestDecimal(now - 100_000)),
			Details: &wire.ComputerConnectorControlHealthDetails{
				LastAttemptMillis: healthString(healthTestDecimal(now - 1000)), LastSuccessMillis: healthString(healthTestDecimal(now - 1000)),
				ConsecutiveFailures: "0", CurrentPollAgeSeconds: "0.125", ConfiguredWaitSeconds: "30.25", EffectiveWaitSeconds: "31.5", DeadlineSeconds: "60.75",
			},
		},
		ResponseDelivery: &wire.ComputerConnectorDeliveryHealth{
			Status: "ok", State: "accepted", ObservedAtMillis: healthString(healthTestDecimal(now - 100_000)),
			Details: &wire.ComputerConnectorDeliveryHealthDetails{
				InProgress: "0", Attempts: "1", Retries: "0", Accepted: "1", Completed: "0", TerminalFailures: "0",
				LastAcceptedMillis: healthString(healthTestDecimal(now - 120_000)), Disposition: "accepted",
			},
		},
	}}
}
func healthTestDecimal(value uint64) string { return strconv.FormatUint(value, 10) }
func healthTestMillis(value uint64) *uint64 { return &value }
func healthTestStatus(value uint32) *uint32 { return &value }

func healthCall(t *testing.T, s *computerConnector, ctx context.Context, query wire.ComputerConnectorHealthRequest, operation string) (*desktop.Outcome, error) {
	t.Helper()
	raw, err := json.Marshal(query)
	if err != nil {
		t.Fatal(err)
	}
	method, ok := s.Methods()["computer.connector.health"]
	if !ok {
		t.Fatal("inherited health method is absent")
	}
	return method.Handle(ctx, desktop.Request{Body: raw, OperationID: operation})
}
func healthRead(t *testing.T, s *computerConnector, query wire.ComputerConnectorHealthRequest) wire.ComputerConnectorHealthState {
	t.Helper()
	out, err := healthCall(t, s, context.Background(), query, "")
	if err != nil || out == nil || out.Status != "ok" {
		t.Fatalf("health read = %+v, %v", out, err)
	}
	if err := wire.Validate("ComputerConnectorHealthState", out.Data); err != nil {
		t.Fatal("invalid health response", err)
	}
	var got wire.ComputerConnectorHealthState
	if err := json.Unmarshal(out.Data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Binding != query.Binding || got.ExpectedInstanceId != query.ExpectedInstanceId {
		t.Fatal("health response crossed request correlation")
	}
	if query.Snapshot == nil {
		if got.SampleAtMillis != nil {
			t.Fatal("missing sample acquired a timestamp")
		}
	} else if got.SampleAtMillis == nil || *got.SampleAtMillis != query.Snapshot.SnapshotAtMillis {
		t.Fatal("health response lost original sample timestamp")
	}
	return got
}
func mustHealthJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func healthRefused(t *testing.T, out *desktop.Outcome, err error) {
	t.Helper()
	if err == nil && (out == nil || out.Status == "ok") {
		t.Fatalf("expected a health refusal, got %+v, %v", out, err)
	}
}

func TestHealthIsInheritedCurrentReadWithoutJournalOrLifetimeEffects(t *testing.T) {
	s, j, native, endpoint, input := newConnectorFixture(t)
	opened, err := s.Open(context.Background(), "open", input)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := endpoint.methods["computer.connector.health"]; ok {
		t.Fatal("external endpoint exposes health input")
	}
	slot, attempts, revision, expiry := s.current, s.attempts, j.revision, j.approval.ExpiresAt
	now := uint64(s.clock.Now().UnixMilli())
	query := healthWireQuery(now, opened.Endpoint.Binding)
	got := healthRead(t, s, query)
	want := wire.ComputerConnectorHealthState{
		Binding: opened.Endpoint.Binding, ExpectedInstanceId: query.ExpectedInstanceId,
		SampleAtMillis: healthString(healthTestDecimal(now)), State: "recent_transport", Reason: "recent_poll_success", LocalReady: true,
		ObservedAtMillis: healthString(healthTestDecimal(now)), ValidUntilMillis: healthString(healthTestDecimal(now + 45_000)),
		LastPollSuccessMillis: healthString(healthTestDecimal(now - 1000)), LastResponseAcceptedMillis: healthString(healthTestDecimal(now - 120_000)),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("health = %+v; want %+v", got, want)
	}
	query.Snapshot = nil
	got = healthRead(t, s, query)
	if got.State != "unobserved" || got.Reason != "missing_snapshot" || got.LocalReady || got.ObservedAtMillis != nil || got.ValidUntilMillis != nil || got.LastPollSuccessMillis != nil || got.LastResponseAcceptedMillis != nil || got.NextRetryMillis != nil {
		t.Fatalf("missing sample retained positive facts: %+v", got)
	}
	if j.publications != 1 || j.withdrawals != 0 || j.revision != revision || !j.approval.ExpiresAt.Equal(expiry) || native.calls != 0 || endpoint.closes != 0 || len(endpoint.published) != 0 || len(s.effects) != 0 || s.current != slot || s.attempts != attempts || s.closed != nil || s.root.unknown {
		t.Fatal("health query changed journal, proof, native effects or lifetime")
	}
	if _, err := slot.owner.Reconnect(context.Background()); err != nil {
		t.Fatal("health query changed original owner", err)
	}
}

func TestHealthRejectsForeignBindingsAndOperationIDs(t *testing.T) {
	s, j, native, endpoint, input := newConnectorFixture(t)
	opened, err := s.Open(context.Background(), "open", input)
	if err != nil {
		t.Fatal(err)
	}
	revision := j.revision
	for _, field := range []string{"build", "profile", "backend", "runtime", "stale generation", "operation"} {
		t.Run(field, func(t *testing.T) {
			query := healthWireQuery(uint64(s.clock.Now().UnixMilli()), opened.Endpoint.Binding)
			operation := ""
			switch field {
			case "build":
				query.Binding.BuildId = "foreign-build"
			case "profile":
				query.Binding.ProfileId = "foreign-profile"
			case "backend":
				query.Binding.BackendGeneration = "foreign-backend"
			case "runtime":
				query.Binding.RuntimeId = "foreign-runtime"
			case "stale generation":
				query.Binding.ConnectorGeneration = "1"
			case "operation":
				operation = "invented-health-effect"
			}
			out, err := healthCall(t, s, context.Background(), query, operation)
			healthRefused(t, out, err)
		})
	}
	got := healthRead(t, s, healthWireQuery(uint64(s.clock.Now().UnixMilli()), opened.Endpoint.Binding))
	if got.State != "recent_transport" || j.publications != 1 || j.withdrawals != 0 || j.revision != revision || native.calls != 0 || endpoint.closes != 0 || len(s.effects) != 0 {
		t.Fatal("invalid read changed original owner or caused effects")
	}
}

func TestHealthCannotBypassClosedUncertainWithdrawnOrFencedOwner(t *testing.T) {
	for _, mode := range []string{"absent", "closed", "closing", "uncertain", "withdrawn", "authority fence", "unknown effect", "cancelled lifetime", "nil context", "cancelled context", "busy gate"} {
		t.Run(mode, func(t *testing.T) {
			s, j, native, endpoint, input := newConnectorFixture(t)
			opened, err := s.Open(context.Background(), "open", input)
			if err != nil {
				t.Fatal(err)
			}
			query := healthWireQuery(uint64(s.clock.Now().UnixMilli()), opened.Endpoint.Binding)
			callCtx := context.Background()
			switch mode {
			case "absent":
				s.current = nil
			case "closed":
				if _, err := s.Close(callCtx, "close", wire.ComputerConnectorClose{Binding: opened.Endpoint.Binding}); err != nil {
					t.Fatal(err)
				}
			case "closing":
				s.current.closing = true
			case "uncertain":
				s.current.startupUncertain = true
			case "withdrawn":
				if err := s.current.owner.Withdraw(callCtx); err != nil {
					t.Fatal(err)
				}
			case "authority fence":
				s.root.guard.deactivate()
			case "unknown effect":
				s.root.mu.Lock()
				s.root.unknown = true
				s.root.mu.Unlock()
			case "cancelled lifetime":
				s.cancel()
			case "nil context":
				callCtx = nil
			case "cancelled context":
				cancelled, cancel := context.WithCancel(callCtx)
				cancel()
				callCtx = cancelled
			case "busy gate":
				s.effects <- struct{}{}
				t.Cleanup(func() { <-s.effects })
				bounded, cancel := context.WithTimeout(callCtx, 10*time.Millisecond)
				defer cancel()
				callCtx = bounded
			}
			publications, withdrawals, revision, closes := j.publications, j.withdrawals, j.revision, endpoint.closes
			out, err := healthCall(t, s, callCtx, query, "")
			healthRefused(t, out, err)
			wantGate := 0
			if mode == "busy gate" {
				wantGate = 1
			}
			if j.publications != publications || j.withdrawals != withdrawals || j.revision != revision || endpoint.closes != closes || native.calls != 0 || len(s.effects) != wantGate {
				t.Fatal("refused health read caused effects")
			}
			if mode == "unknown effect" && !s.root.unknown {
				t.Fatal("observation cleared an unknown effect")
			}
		})
	}
}

func TestHealthFreshnessAndHistoricalUploadRemainSeparate(t *testing.T) {
	s, _, _, _, input := newConnectorFixture(t)
	opened, err := s.Open(context.Background(), "open", input)
	if err != nil {
		t.Fatal(err)
	}
	now := uint64(s.clock.Now().UnixMilli())
	tests := []struct {
		name          string
		change        func(*wire.ComputerConnectorHealthRequest)
		state, reason string
		noFacts       bool
	}{
		{"fresh sample with old transition", func(*wire.ComputerConnectorHealthRequest) {}, "recent_transport", "recent_poll_success", false},
		{"success at 90 seconds", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.LastSuccessMillis = healthString(healthTestDecimal(now - 90_000))
		}, "recent_transport", "recent_poll_success", false},
		{"fresh sample with stale success", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.LastSuccessMillis = healthString(healthTestDecimal(now - 90_001))
		}, "unobserved", "stale_poll_success", false},
		{"snapshot at 45 seconds", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.SnapshotAtMillis = healthTestDecimal(now - 45_000)
			q.Snapshot.ControlPlane.Details.LastAttemptMillis = healthString(healthTestDecimal(now - 45_001))
			q.Snapshot.ControlPlane.Details.LastSuccessMillis = healthString(healthTestDecimal(now - 45_001))
		}, "recent_transport", "recent_poll_success", false},
		{"stale snapshot", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.SnapshotAtMillis = healthTestDecimal(now - 45_001)
			q.Snapshot.ControlPlane.Details.LastAttemptMillis = healthString(healthTestDecimal(now - 45_002))
			q.Snapshot.ControlPlane.Details.LastSuccessMillis = healthString(healthTestDecimal(now - 45_002))
		}, "unobserved", "stale_snapshot", true},
		{"historical upload without poll", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.ControlPlane = nil }, "unobserved", "polling_missing", false},
		{"historical upload without success", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.ControlPlane.Details.LastSuccessMillis = nil }, "unobserved", "no_poll_success", false},
		{"waiting without success", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.State = "polling"
			q.Snapshot.ControlPlane.Details.LastSuccessMillis = nil
		}, "checking", "waiting_without_success", false},
		{"producer stop is not owner stop", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.ControlPlane.State = "stopped" }, "unobserved", "polling_stopped", false},
		{"limited runtime", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.RuntimeLimited = true }, "unobserved", "polling_limited", false},
		{"instance mismatch", func(q *wire.ComputerConnectorHealthRequest) { q.ExpectedInstanceId = "another-instance" }, "unobserved", "instance_mismatch", true},
		{"future snapshot", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.SnapshotAtMillis = healthTestDecimal(now + 1) }, "unobserved", "invalid_snapshot", true},
		{"unsafe snapshot", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.SnapshotAtMillis = "9007199254740992" }, "unobserved", "invalid_snapshot", true},
		{"maximum uint64 snapshot", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.SnapshotAtMillis = "18446744073709551615" }, "unobserved", "invalid_snapshot", true},
		{"future optional timestamp", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.LastSuccessMillis = healthString(healthTestDecimal(now + 1))
		}, "unobserved", "invalid_evidence", true},
		{"unsafe optional timestamp", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ResponseDelivery.Details.LastFailureMillis = healthString("9007199254740992")
		}, "unobserved", "invalid_evidence", true},
		{"unsafe delivery count", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ResponseDelivery.Details.Completed = "9007199254740992"
		}, "unobserved", "invalid_evidence", true},
		{"unsafe seconds", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.DeadlineSeconds = "9007199254741"
		}, "unobserved", "invalid_evidence", true},
		{"invalid optional HTTP status", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ResponseDelivery.Details.HttpStatus = healthTestStatus(600)
		}, "unobserved", "invalid_evidence", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			query := healthWireQuery(now, opened.Endpoint.Binding)
			test.change(&query)
			got := healthRead(t, s, query)
			if got.State != test.state || got.Reason != test.reason {
				t.Fatalf("health = %s/%s; want %s/%s", got.State, got.Reason, test.state, test.reason)
			}
			if test.noFacts && (got.LocalReady || got.ObservedAtMillis != nil || got.ValidUntilMillis != nil || got.LastPollSuccessMillis != nil || got.LastResponseAcceptedMillis != nil || got.NextRetryMillis != nil) {
				t.Fatalf("invalid evidence retained facts: %+v", got)
			}
			if strings.HasPrefix(test.name, "historical upload") && (got.LastPollSuccessMillis != nil || got.LastResponseAcceptedMillis == nil || *got.LastResponseAcceptedMillis != healthTestDecimal(now-120_000)) {
				t.Fatalf("historical upload was lost or promoted: %+v", got)
			}
		})
	}
	query := healthWireQuery(now, opened.Endpoint.Binding)
	query.Snapshot.ControlPlane.Status, query.Snapshot.ControlPlane.State = "degraded", "backoff"
	details := query.Snapshot.ControlPlane.Details
	details.LastErrorMillis = healthString(healthTestDecimal(now - 500))
	details.NextRetryMillis = healthString(healthTestDecimal(now + 5000))
	details.FailureCategory, details.HttpStatus = healthString("http_error"), healthTestStatus(503)
	got := healthRead(t, s, query)
	if got.State != "unavailable" || got.Reason != "http_unavailable" || got.NextRetryMillis == nil || *got.NextRetryMillis != healthTestDecimal(now+5000) {
		t.Fatalf("failure/retry mapping = %+v", got)
	}
	details.HttpStatus = healthTestStatus(401)
	got = healthRead(t, s, query)
	if got.State != "action_required" || got.Reason != "authorization_required" {
		t.Fatalf("authorization classification = %+v", got)
	}
}

func TestHealthMapsAllDetachedSnapshotFields(t *testing.T) {
	query := healthWireQuery(200_000, wire.ComputerConnectorBinding{})
	input := query.Snapshot
	input.RuntimeStartedAtMillis = "1000"
	input.RuntimeLimited, input.Live, input.Ready, input.Truncated = true, false, false, true
	input.ControlPlane.Status, input.ControlPlane.State, input.ControlPlane.Limited = "degraded", "backoff", true
	poll := input.ControlPlane.Details
	poll.LastErrorMillis, poll.NextRetryMillis = healthString("199500"), healthString("205000")
	poll.ConsecutiveFailures, poll.FailureCategory, poll.HttpStatus = "3", healthString("network_error"), healthTestStatus(503)
	input.ResponseDelivery.Status, input.ResponseDelivery.State, input.ResponseDelivery.Limited = "degraded", "retry", true
	delivery := input.ResponseDelivery.Details
	delivery.InProgress, delivery.Attempts, delivery.Retries, delivery.Accepted, delivery.Completed, delivery.TerminalFailures = "1", "2", "3", "4", "5", "6"
	delivery.LastCompletedMillis, delivery.LastFailureMillis = healthString("90000"), healthString("95000")
	delivery.Disposition, delivery.FailureCategory, delivery.HttpStatus = "retry", healthString("timeout"), healthTestStatus(504)
	got, err := healthSnapshot(input)
	want := &domain.ConnectionHealthSnapshot{
		SnapshotAtMillis: 200_000, RuntimeInstanceID: "instance-health", RuntimeStartedAtMillis: 1000,
		RuntimeLifecycle: "running", RuntimeLimited: true, Live: false, Ready: false, Truncated: true,
		ControlPlane: &domain.ControlPlaneHealth{Status: "degraded", State: "backoff", Limited: true, ObservedAtMillis: healthTestMillis(100_000), Details: &domain.ControlPlaneHealthDetails{
			LastAttemptMillis: healthTestMillis(199_000), LastSuccessMillis: healthTestMillis(199_000), LastErrorMillis: healthTestMillis(199_500), NextRetryMillis: healthTestMillis(205_000),
			ConsecutiveFailures: 3, CurrentPollAgeSeconds: 0.125, ConfiguredWaitSeconds: 30.25, EffectiveWaitSeconds: 31.5, DeadlineSeconds: 60.75,
			FailureCategory: healthString("network_error"), HTTPStatus: healthTestMillis(503),
		}},
		ResponseDelivery: &domain.ResponseDeliveryHealth{Status: "degraded", State: "retry", Limited: true, ObservedAtMillis: healthTestMillis(100_000), Details: &domain.ResponseDeliveryHealthDetails{
			InProgress: 1, Attempts: 2, Retries: 3, Accepted: 4, Completed: 5, TerminalFailures: 6,
			LastAcceptedMillis: healthTestMillis(80_000), LastCompletedMillis: healthTestMillis(90_000), LastFailureMillis: healthTestMillis(95_000),
			Disposition: "retry", FailureCategory: healthString("timeout"), HTTPStatus: healthTestMillis(504),
		}},
	}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot mapping = %+v, %v; want %+v", got, err, want)
	}
	*poll.FailureCategory, *poll.HttpStatus = "canceled", 401
	*delivery.FailureCategory, *delivery.HttpStatus = "http_error", 403
	*input.ControlPlane.ObservedAtMillis, *input.ResponseDelivery.ObservedAtMillis = "1", "2"
	if !reflect.DeepEqual(got, want) {
		t.Fatal("domain snapshot borrowed wire pointers")
	}
	if got, err := healthSnapshot(nil); got != nil || err != nil {
		t.Fatal("missing snapshot conversion changed absence", got, err)
	}
}

func TestHealthRejectsMalformedBoundaryAndOptionalConversions(t *testing.T) {
	s, j, native, _, input := newConnectorFixture(t)
	opened, err := s.Open(context.Background(), "open", input)
	if err != nil {
		t.Fatal(err)
	}
	revision := j.revision
	now := uint64(s.clock.Now().UnixMilli())
	for _, test := range []struct {
		name   string
		change func(*wire.ComputerConnectorHealthRequest)
	}{
		{"required uint64 overflow", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.SnapshotAtMillis = "18446744073709551616" }},
		{"optional poll uint64 overflow", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.LastErrorMillis = healthString("18446744073709551616")
		}},
		{"optional delivery uint64 overflow", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ResponseDelivery.Details.LastCompletedMillis = healthString("18446744073709551616")
		}},
		{"hidden limited optional overflow", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ResponseDelivery.Limited = true
			q.Snapshot.ResponseDelivery.Details.LastFailureMillis = healthString("18446744073709551616")
		}},
		{"NaN seconds", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.CurrentPollAgeSeconds = "NaN"
		}},
		{"infinite seconds", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.ConfiguredWaitSeconds = "+Inf"
		}},
		{"overflow seconds", func(q *wire.ComputerConnectorHealthRequest) {
			q.Snapshot.ControlPlane.Details.EffectiveWaitSeconds = "1e9999"
		}},
		{"negative seconds", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.ControlPlane.Details.DeadlineSeconds = "-1" }},
		{"exponent seconds", func(q *wire.ComputerConnectorHealthRequest) { q.Snapshot.ControlPlane.Details.DeadlineSeconds = "1e2" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			query := healthWireQuery(now, opened.Endpoint.Binding)
			test.change(&query)
			out, err := healthCall(t, s, context.Background(), query, "")
			healthRefused(t, out, err)
			// Conversion failures must also remain failures before observation when
			// the converter is exercised directly, without the closed wire schema.
			if test.name != "negative seconds" && test.name != "exponent seconds" {
				if got, err := healthSnapshot(query.Snapshot); got != nil || err == nil {
					t.Fatal("invalid nested conversion was silently dropped", got, err)
				}
			}
		})
	}
	query := healthWireQuery(now, opened.Endpoint.Binding)
	raw, err := json.Marshal(query)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ name, raw string }{
		{"malformed JSON", "{"},
		{"trailing JSON", string(raw) + " {}"},
		{"duplicate key", `{"expectedInstanceId":"other",` + string(raw[1:])},
		{"owner stop flag", `{"ownerStopped":true,` + string(raw[1:])},
		{"reconnecting flag", `{"reconnecting":true,` + string(raw[1:])},
		{"recovery flag", `{"recoveryRequired":true,` + string(raw[1:])},
		{"null snapshot", `{"snapshot":null,"binding":` + string(mustHealthJSON(t, query.Binding)) + `,"expectedInstanceId":"instance-health"}`},
		{"null optional field", strings.Replace(string(raw), `"lastSuccessMillis":"`+healthTestDecimal(now-1000)+`"`, `"lastSuccessMillis":null`, 1)},
		{"unknown nested field", strings.Replace(string(raw), `"controlPlane":{`, `"controlPlane":{"ownerStopped":true,`, 1)},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, err := s.Methods()["computer.connector.health"].Handle(context.Background(), desktop.Request{Body: json.RawMessage(test.raw)})
			healthRefused(t, out, err)
		})
	}
	if j.publications != 1 || j.withdrawals != 0 || j.revision != revision || native.calls != 0 || len(s.effects) != 0 {
		t.Fatal("malformed health input caused effects")
	}
}
