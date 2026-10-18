package domain

import (
	"math"
	"reflect"
	"strings"
	"testing"
)

// These value fixtures exercise policy only, never native or provider behavior.
func connectionFixture() (ConnectionContext, *ConnectionHealthSnapshot) {
	return ConnectionContext{
			NowMillis: 200_000, Current: true, ExpectedInstanceID: "runtime_1-A",
		}, &ConnectionHealthSnapshot{
			SnapshotAtMillis: 200_000, RuntimeInstanceID: "runtime_1-A",
			RuntimeStartedAtMillis: 1_000, RuntimeLifecycle: "running", Live: true, Ready: true,
			ControlPlane: &ControlPlaneHealth{
				Status: "ok", State: "idle", ObservedAtMillis: connectionTestMillis(200_000),
				Details: &ControlPlaneHealthDetails{
					LastAttemptMillis: connectionTestMillis(199_000), LastSuccessMillis: connectionTestMillis(199_000),
					ConfiguredWaitSeconds: 30, EffectiveWaitSeconds: 30, DeadlineSeconds: 60,
				},
			},
		}
}

func connectionTestMillis(value uint64) *uint64 { return &value }
func connectionTestString(value string) *string { return &value }

func connectionDeliveryFixture() *ResponseDeliveryHealth {
	return &ResponseDeliveryHealth{
		Status: "ok", State: "accepted", ObservedAtMillis: connectionTestMillis(200_000),
		Details: &ResponseDeliveryHealthDetails{
			Attempts: 1, Accepted: 1, LastAcceptedMillis: connectionTestMillis(198_000), Disposition: "accepted",
		},
	}
}

func connectionAssertState(t *testing.T, got ConnectionObservation, state ConnectionState, reason ConnectionReason) {
	t.Helper()
	if got.State != state || got.Reason != reason {
		t.Fatalf("state/reason = %s/%s, want %s/%s; observation: %+v", got.State, got.Reason, state, reason, got)
	}
}

func connectionAssertNoFacts(t *testing.T, got ConnectionObservation) {
	t.Helper()
	if got.ObservedAtMillis != nil || got.ValidUntilMillis != nil || got.LastPollSuccessMillis != nil ||
		got.LastResponseAcceptedMillis != nil || got.NextRetryMillis != nil || got.LocalReady {
		t.Fatalf("unqualified facts retained: %+v", got)
	}
}

func connectionAssertMillis(t *testing.T, got *uint64, want uint64) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("timestamp = %v, want %d", got, want)
	}
}

func TestObserveConnectionTrustedPrecedence(t *testing.T) {
	tests := []struct {
		name    string
		context ConnectionContext
		state   ConnectionState
		reason  ConnectionReason
	}{
		{"owner stop overrides everything", ConnectionContext{OwnerStopped: true, RecoveryRequired: true, Reconnecting: true}, ConnectionStateStopped, ConnectionReasonOwnerStopped},
		{"recovery overrides missing current snapshot", ConnectionContext{RecoveryRequired: true, Reconnecting: true}, ConnectionStateActionRequired, ConnectionReasonRecoveryRequired},
		{"not current overrides reconnecting", ConnectionContext{Reconnecting: true}, ConnectionStateUnobserved, ConnectionReasonNotCurrent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := ObserveConnection(test.context, nil)
			connectionAssertState(t, got, test.state, test.reason)
			connectionAssertNoFacts(t, got)
		})
	}
	context, _ := connectionFixture()
	got := ObserveConnection(context, nil)
	connectionAssertState(t, got, ConnectionStateUnobserved, ConnectionReasonMissingSnapshot)
	connectionAssertNoFacts(t, got)
}

func TestObserveConnectionInvalidSnapshotHasNoFacts(t *testing.T) {
	tests := []struct {
		name   string
		change func(*ConnectionContext, *ConnectionHealthSnapshot)
		reason ConnectionReason
	}{
		{"zero clock", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) { c.NowMillis = 0 }, ConnectionReasonInvalidClock},
		{"unsafe clock", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) { c.NowMillis = 1 << 53 }, ConnectionReasonInvalidClock},
		{"overflow clock", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) { c.NowMillis = math.MaxUint64 }, ConnectionReasonInvalidClock},
		{"not current", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) { c.Current = false }, ConnectionReasonNotCurrent},
		{"missing expected instance", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) { c.ExpectedInstanceID = "" }, ConnectionReasonInvalidInstance},
		{"invalid expected instance", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) { c.ExpectedInstanceID = "runtime.1" }, ConnectionReasonInvalidInstance},
		{"long expected instance", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) {
			c.ExpectedInstanceID = strings.Repeat("a", 129)
		}, ConnectionReasonInvalidInstance},
		{"missing instance", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.RuntimeInstanceID = "" }, ConnectionReasonInvalidInstance},
		{"non ASCII instance", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.RuntimeInstanceID = "runtime_é" }, ConnectionReasonInvalidInstance},
		{"hostile instance", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.RuntimeInstanceID = "raw\nprovider text" }, ConnectionReasonInvalidInstance},
		{"crossed instance", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.RuntimeInstanceID = "runtime_2" }, ConnectionReasonInstanceMismatch},
		{"zero snapshot", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.SnapshotAtMillis = 0 }, ConnectionReasonInvalidSnapshot},
		{"unsafe snapshot", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.SnapshotAtMillis = 1 << 53 }, ConnectionReasonInvalidSnapshot},
		{"future snapshot", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.SnapshotAtMillis++ }, ConnectionReasonInvalidSnapshot},
		{"zero start", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.RuntimeStartedAtMillis = 0 }, ConnectionReasonInvalidSnapshot},
		{"unsafe start", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.RuntimeStartedAtMillis = 1 << 53 }, ConnectionReasonInvalidSnapshot},
		{"future start", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) {
			s.RuntimeStartedAtMillis = s.SnapshotAtMillis + 1
		}, ConnectionReasonInvalidSnapshot},
		{"unsupported lifecycle", func(_ *ConnectionContext, s *ConnectionHealthSnapshot) { s.RuntimeLifecycle = "connected" }, ConnectionReasonInvalidSnapshot},
		{"stale snapshot", func(c *ConnectionContext, _ *ConnectionHealthSnapshot) { c.NowMillis += 45_001 }, ConnectionReasonStaleSnapshot},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, sample := connectionFixture()
			sample.ResponseDelivery = connectionDeliveryFixture()
			context.Reconnecting = true
			test.change(&context, sample)
			got := ObserveConnection(context, sample)
			connectionAssertState(t, got, ConnectionStateUnobserved, test.reason)
			connectionAssertNoFacts(t, got)
		})
	}
}

func TestObserveConnectionLocalReadinessAndReconnect(t *testing.T) {
	tests := []struct {
		name   string
		change func(*ConnectionHealthSnapshot)
		reason ConnectionReason
	}{
		{"not live", func(s *ConnectionHealthSnapshot) { s.Live = false }, ConnectionReasonLocalNotLive},
		{"starting", func(s *ConnectionHealthSnapshot) { s.RuntimeLifecycle = "starting" }, ConnectionReasonRuntimeStarting},
		{"draining", func(s *ConnectionHealthSnapshot) { s.RuntimeLifecycle = "draining" }, ConnectionReasonRuntimeDraining},
		{"not ready", func(s *ConnectionHealthSnapshot) { s.Ready = false }, ConnectionReasonLocalNotReady},
	}
	for _, test := range tests {
		for _, reconnecting := range []bool{false, true} {
			name := test.name
			if reconnecting {
				name += " trusted reconnect"
			}
			t.Run(name, func(t *testing.T) {
				context, sample := connectionFixture()
				context.Reconnecting = reconnecting
				test.change(sample)
				got := ObserveConnection(context, sample)
				state := ConnectionStateChecking
				if reconnecting {
					state = ConnectionStateReconnecting
				}
				connectionAssertState(t, got, state, test.reason)
				if got.LocalReady || got.LastPollSuccessMillis != nil {
					t.Fatalf("local pending observation became positive: %+v", got)
				}
				connectionAssertMillis(t, got.ObservedAtMillis, sample.SnapshotAtMillis)
			})
		}
	}
	context, sample := connectionFixture()
	context.Reconnecting = true
	sample.ControlPlane = nil
	got := ObserveConnection(context, sample)
	connectionAssertState(t, got, ConnectionStateReconnecting, ConnectionReasonReconnecting)
	if !got.LocalReady || got.LastPollSuccessMillis != nil {
		t.Fatalf("trusted reconnect/local readiness facts = %+v", got)
	}
}

func TestObserveConnectionRequiresPollingEvidence(t *testing.T) {
	tests := []struct {
		name   string
		change func(*ConnectionHealthSnapshot)
		reason ConnectionReason
	}{
		{"missing component", func(s *ConnectionHealthSnapshot) { s.ControlPlane = nil }, ConnectionReasonPollingMissing},
		{"missing details", func(s *ConnectionHealthSnapshot) { s.ControlPlane.Details = nil }, ConnectionReasonPollingMissing},
		{"missing observation", func(s *ConnectionHealthSnapshot) { s.ControlPlane.ObservedAtMillis = nil }, ConnectionReasonPollingMissing},
		{"runtime limited", func(s *ConnectionHealthSnapshot) { s.RuntimeLimited = true }, ConnectionReasonPollingLimited},
		{"snapshot truncated", func(s *ConnectionHealthSnapshot) { s.Truncated = true }, ConnectionReasonPollingLimited},
		{"component limited", func(s *ConnectionHealthSnapshot) { s.ControlPlane.Limited = true }, ConnectionReasonPollingLimited},
		{"disabled", func(s *ConnectionHealthSnapshot) { s.ControlPlane.Status = "disabled" }, ConnectionReasonPollingDisabled},
		{"unknown", func(s *ConnectionHealthSnapshot) { s.ControlPlane.Status = "unknown" }, ConnectionReasonPollingUnknown},
		{"unsupported status", func(s *ConnectionHealthSnapshot) { s.ControlPlane.Status = "raw-provider-error" }, ConnectionReasonPollingUnsupported},
		{"unsupported state", func(s *ConnectionHealthSnapshot) { s.ControlPlane.State = "raw-provider-error" }, ConnectionReasonPollingUnsupported},
		{"producer stop is not owner stop", func(s *ConnectionHealthSnapshot) { s.ControlPlane.State = "stopped" }, ConnectionReasonPollingStopped},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, sample := connectionFixture()
			test.change(sample)
			got := ObserveConnection(context, sample)
			connectionAssertState(t, got, ConnectionStateUnobserved, test.reason)
			if !got.LocalReady || got.LastPollSuccessMillis != nil {
				t.Fatalf("local and transport facts were conflated: %+v", got)
			}
		})
	}
}

func TestObserveConnectionFreshnessBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		now     uint64
		success uint64
		state   ConnectionState
		reason  ConnectionReason
		until   uint64
	}{
		{"ordinary empty poll", 200_000, 199_000, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess, 245_000},
		{"success exactly 90 seconds", 200_000, 110_000, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess, 200_000},
		{"success older than 90 seconds", 200_000, 109_999, ConnectionStateUnobserved, ConnectionReasonStalePollSuccess, 245_000},
		{"snapshot exactly 45 seconds", 245_000, 199_000, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess, 245_000},
		{"snapshot older than 45 seconds", 245_001, 199_000, ConnectionStateUnobserved, ConnectionReasonStaleSnapshot, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, sample := connectionFixture()
			context.NowMillis = test.now
			sample.ControlPlane.Details.LastSuccessMillis = connectionTestMillis(test.success)
			got := ObserveConnection(context, sample)
			connectionAssertState(t, got, test.state, test.reason)
			if test.until == 0 {
				connectionAssertNoFacts(t, got)
				return
			}
			connectionAssertMillis(t, got.ValidUntilMillis, test.until)
			if test.state == ConnectionStateRecentTransport {
				connectionAssertMillis(t, got.LastPollSuccessMillis, test.success)
			} else {
				connectionAssertMillis(t, got.LastPollSuccessMillis, test.success)
			}
		})
	}
	for _, state := range []string{"idle", "polling", "backpressured", "starting"} {
		t.Run("recent success in "+state, func(t *testing.T) {
			context, sample := connectionFixture()
			sample.ControlPlane.State = state
			got := ObserveConnection(context, sample)
			connectionAssertState(t, got, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
		})
	}
}

func TestObserveConnectionWaitingIsNotOutage(t *testing.T) {
	tests := []struct {
		name      string
		state     string
		age       float64
		success   *uint64
		wantState ConnectionState
		reason    ConnectionReason
	}{
		{"OK alone is not green", "idle", 0, nil, ConnectionStateUnobserved, ConnectionReasonNoPollSuccess},
		{"initial polling", "polling", 1, nil, ConnectionStateChecking, ConnectionReasonWaitingWithoutSuccess},
		{"deadline equality", "polling", 60, nil, ConnectionStateChecking, ConnectionReasonWaitingWithoutSuccess},
		{"past deadline is not proven outage", "polling", 60.001, nil, ConnectionStateUnobserved, ConnectionReasonPollDeadlineExceeded},
		{"waiting after stale success", "polling", 1, connectionTestMillis(109_999), ConnectionStateChecking, ConnectionReasonWaitingWithStaleSuccess},
		{"backpressure without success", "backpressured", 0, nil, ConnectionStateChecking, ConnectionReasonBackpressuredWithoutSuccess},
		{"backpressure with stale success", "backpressured", 0, connectionTestMillis(109_999), ConnectionStateChecking, ConnectionReasonBackpressuredWithStaleSuccess},
		{"initial control plane", "starting", 0, nil, ConnectionStateChecking, ConnectionReasonNoPollSuccess},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, sample := connectionFixture()
			sample.ControlPlane.State = test.state
			details := sample.ControlPlane.Details
			details.LastSuccessMillis = test.success
			details.CurrentPollAgeSeconds = test.age
			if test.age > 1 {
				details.LastAttemptMillis = connectionTestMillis(139_000)
			}
			got := ObserveConnection(context, sample)
			connectionAssertState(t, got, test.wantState, test.reason)
			if !reflect.DeepEqual(got.LastPollSuccessMillis, test.success) || got.NextRetryMillis != nil {
				t.Fatalf("waiting changed historical evidence or invented retry: %+v", got)
			}
		})
	}
}

func TestObserveConnectionLatestFailure(t *testing.T) {
	tests := []struct {
		name     string
		category *string
		http     *uint64
		state    ConnectionState
		reason   ConnectionReason
	}{
		{"401", connectionTestString("http_error"), connectionTestMillis(401), ConnectionStateActionRequired, ConnectionReasonAuthorizationRequired},
		{"403", connectionTestString("http_error"), connectionTestMillis(403), ConnectionStateActionRequired, ConnectionReasonAuthorizationRequired},
		{"429", connectionTestString("http_error"), connectionTestMillis(429), ConnectionStateUnavailable, ConnectionReasonHTTPUnavailable},
		{"503", connectionTestString("http_error"), connectionTestMillis(503), ConnectionStateUnavailable, ConnectionReasonHTTPUnavailable},
		{"504", connectionTestString("http_error"), connectionTestMillis(504), ConnectionStateUnavailable, ConnectionReasonHTTPUnavailable},
		{"599", connectionTestString("http_error"), connectionTestMillis(599), ConnectionStateUnavailable, ConnectionReasonHTTPUnavailable},
		{"dated auth status without category", nil, connectionTestMillis(401), ConnectionStateActionRequired, ConnectionReasonAuthorizationRequired},
		{"timeout", connectionTestString("timeout"), nil, ConnectionStateUnavailable, ConnectionReasonTransportUnavailable},
		{"network", connectionTestString("network_error"), nil, ConnectionStateUnavailable, ConnectionReasonTransportUnavailable},
		{"canceled", connectionTestString("canceled"), nil, ConnectionStateChecking, ConnectionReasonFailureCanceled},
		{"canceled with older HTTP detail", connectionTestString("canceled"), connectionTestMillis(503), ConnectionStateChecking, ConnectionReasonFailureCanceled},
		{"request error", connectionTestString("request_error"), nil, ConnectionStateUnobserved, ConnectionReasonRequestUnobserved},
		{"unknown category", connectionTestString("raw-provider-error"), connectionTestMillis(503), ConnectionStateUnobserved, ConnectionReasonFailureUnobserved},
		{"unclassified HTTP", connectionTestString("http_error"), connectionTestMillis(404), ConnectionStateUnobserved, ConnectionReasonFailureUnobserved},
		{"no failure detail", nil, nil, ConnectionStateUnobserved, ConnectionReasonFailureUnobserved},
		{"HTTP 200 is not connected", connectionTestString("http_error"), connectionTestMillis(200), ConnectionStateUnobserved, ConnectionReasonFailureUnobserved},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, sample := connectionFixture()
			poll := sample.ControlPlane
			poll.Status, poll.State = "degraded", "backoff"
			poll.Details.LastErrorMillis = connectionTestMillis(199_000) // Equality makes the failure latest.
			poll.Details.ConsecutiveFailures = 1
			poll.Details.FailureCategory, poll.Details.HTTPStatus = test.category, test.http
			got := ObserveConnection(context, sample)
			connectionAssertState(t, got, test.state, test.reason)
			if !reflect.DeepEqual(got.LastPollSuccessMillis, poll.Details.LastSuccessMillis) || got.NextRetryMillis != nil || !got.LocalReady {
				t.Fatalf("failure qualification = %+v", got)
			}
		})
	}
	context, sample := connectionFixture()
	sample.ControlPlane.Status, sample.ControlPlane.State = "degraded", "backoff"
	sample.ControlPlane.Details.LastErrorMillis = connectionTestMillis(198_999)
	sample.ControlPlane.Details.FailureCategory = connectionTestString("http_error")
	sample.ControlPlane.Details.HTTPStatus = connectionTestMillis(503)
	got := ObserveConnection(context, sample)
	connectionAssertState(t, got, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
	for _, change := range []func(*ControlPlaneHealth){
		func(p *ControlPlaneHealth) { p.Status = "degraded" },
		func(p *ControlPlaneHealth) { p.State = "backoff" },
		func(p *ControlPlaneHealth) { p.Details.ConsecutiveFailures = 1 },
		func(p *ControlPlaneHealth) { p.Details.FailureCategory = connectionTestString("timeout") },
		func(p *ControlPlaneHealth) { p.Details.HTTPStatus = connectionTestMillis(503) },
	} {
		context, sample := connectionFixture()
		change(sample.ControlPlane)
		got := ObserveConnection(context, sample)
		connectionAssertState(t, got, ConnectionStateUnobserved, ConnectionReasonFailureUnobserved)
	}
}

func TestObserveConnectionNextRetryIsOnlyReportedPlan(t *testing.T) {
	for _, planned := range []uint64{199_999, 200_000, 205_000} {
		context, sample := connectionFixture()
		poll := sample.ControlPlane
		poll.Status, poll.State = "degraded", "backoff"
		poll.Details.LastErrorMillis = connectionTestMillis(200_000)
		poll.Details.FailureCategory = connectionTestString("http_error")
		poll.Details.HTTPStatus = connectionTestMillis(503)
		poll.Details.NextRetryMillis = connectionTestMillis(planned)
		got := ObserveConnection(context, sample)
		connectionAssertState(t, got, ConnectionStateUnavailable, ConnectionReasonHTTPUnavailable)
		if planned >= context.NowMillis {
			connectionAssertMillis(t, got.NextRetryMillis, planned)
		} else if got.NextRetryMillis != nil {
			t.Fatal("past retry plan retained")
		}
	}
	context, sample := connectionFixture()
	sample.ControlPlane.Details.NextRetryMillis = connectionTestMillis(205_000)
	got := ObserveConnection(context, sample)
	if got.NextRetryMillis != nil {
		t.Fatal("success fabricated a retry branch")
	}
	sample.ControlPlane.Status = "degraded"
	got = ObserveConnection(context, sample)
	if got.NextRetryMillis != nil {
		t.Fatal("undated failure outside backoff retained retry")
	}
	sample.ControlPlane.State = "backoff"
	got = ObserveConnection(context, sample)
	connectionAssertState(t, got, ConnectionStateUnobserved, ConnectionReasonFailureUnobserved)
	connectionAssertMillis(t, got.NextRetryMillis, 205_000)
}

func TestObserveConnectionInvalidNumbersAndTimes(t *testing.T) {
	type mutation struct {
		name   string
		change func(*ConnectionHealthSnapshot)
	}
	tests := []mutation{}
	seconds := []struct {
		name  string
		field func(*ControlPlaneHealthDetails) *float64
	}{
		{"poll age", func(d *ControlPlaneHealthDetails) *float64 { return &d.CurrentPollAgeSeconds }},
		{"configured wait", func(d *ControlPlaneHealthDetails) *float64 { return &d.ConfiguredWaitSeconds }},
		{"effective wait", func(d *ControlPlaneHealthDetails) *float64 { return &d.EffectiveWaitSeconds }},
		{"deadline", func(d *ControlPlaneHealthDetails) *float64 { return &d.DeadlineSeconds }},
	}
	for _, field := range seconds {
		for _, number := range []struct {
			name  string
			value float64
		}{
			{"negative", -1}, {"NaN", math.NaN()}, {"infinite", math.Inf(1)}, {"negative infinite", math.Inf(-1)},
			{"outside safe milliseconds", float64(1<<53)/1000 + 1},
		} {
			tests = append(tests, mutation{field.name + " " + number.name, func(s *ConnectionHealthSnapshot) { *field.field(s.ControlPlane.Details) = number.value }})
		}
	}
	counters := []struct {
		name  string
		field func(*ConnectionHealthSnapshot) *uint64
	}{
		{"consecutive failures", func(s *ConnectionHealthSnapshot) *uint64 { return &s.ControlPlane.Details.ConsecutiveFailures }},
		{"in progress", func(s *ConnectionHealthSnapshot) *uint64 { return &s.ResponseDelivery.Details.InProgress }},
		{"attempts", func(s *ConnectionHealthSnapshot) *uint64 { return &s.ResponseDelivery.Details.Attempts }},
		{"retries", func(s *ConnectionHealthSnapshot) *uint64 { return &s.ResponseDelivery.Details.Retries }},
		{"accepted", func(s *ConnectionHealthSnapshot) *uint64 { return &s.ResponseDelivery.Details.Accepted }},
		{"completed", func(s *ConnectionHealthSnapshot) *uint64 { return &s.ResponseDelivery.Details.Completed }},
		{"terminal failures", func(s *ConnectionHealthSnapshot) *uint64 { return &s.ResponseDelivery.Details.TerminalFailures }},
	}
	for _, field := range counters {
		for _, value := range []uint64{1 << 53, math.MaxUint64} {
			tests = append(tests, mutation{field.name + " unsafe", func(s *ConnectionHealthSnapshot) { *field.field(s) = value }})
		}
	}
	past := []struct {
		name  string
		field func(*ConnectionHealthSnapshot) **uint64
	}{
		{"poll observation", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ControlPlane.ObservedAtMillis }},
		{"attempt", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ControlPlane.Details.LastAttemptMillis }},
		{"success", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ControlPlane.Details.LastSuccessMillis }},
		{"error", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ControlPlane.Details.LastErrorMillis }},
		{"response observation", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ResponseDelivery.ObservedAtMillis }},
		{"response accepted", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ResponseDelivery.Details.LastAcceptedMillis }},
		{"response completed", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ResponseDelivery.Details.LastCompletedMillis }},
		{"response failure", func(s *ConnectionHealthSnapshot) **uint64 { return &s.ResponseDelivery.Details.LastFailureMillis }},
	}
	for _, field := range past {
		for _, number := range []struct {
			name  string
			value uint64
		}{
			{"zero", 0}, {"before start", 999}, {"future", 200_001}, {"unsafe", 1 << 53}, {"overflow", math.MaxUint64},
		} {
			tests = append(tests, mutation{field.name + " " + number.name, func(s *ConnectionHealthSnapshot) { *field.field(s) = connectionTestMillis(number.value) }})
		}
	}
	for _, number := range []uint64{0, 99, 600, math.MaxUint64} {
		tests = append(tests,
			mutation{"invalid poll HTTP status", func(s *ConnectionHealthSnapshot) { s.ControlPlane.Details.HTTPStatus = connectionTestMillis(number) }},
			mutation{"invalid response HTTP status", func(s *ConnectionHealthSnapshot) {
				s.ResponseDelivery.Details.HTTPStatus = connectionTestMillis(number)
			}},
		)
	}
	for _, number := range []uint64{0, 1 << 53, math.MaxUint64} {
		tests = append(tests, mutation{"invalid planned retry", func(s *ConnectionHealthSnapshot) {
			s.ControlPlane.Details.NextRetryMillis = connectionTestMillis(number)
		}})
	}
	tests = append(tests,
		mutation{"zero polling deadline", func(s *ConnectionHealthSnapshot) {
			s.ControlPlane.State = "polling"
			s.ControlPlane.Details.DeadlineSeconds = 0
		}},
		mutation{"poll older than attempt", func(s *ConnectionHealthSnapshot) {
			s.ControlPlane.State = "polling"
			s.ControlPlane.Details.CurrentPollAgeSeconds = 2
		}},
		mutation{"poll older than runtime", func(s *ConnectionHealthSnapshot) {
			s.ControlPlane.State = "polling"
			s.ControlPlane.Details.LastAttemptMillis = nil
			s.ControlPlane.Details.CurrentPollAgeSeconds = 200
		}},
	)
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, sample := connectionFixture()
			sample.ResponseDelivery = connectionDeliveryFixture()
			test.change(sample)
			got := ObserveConnection(context, sample)
			connectionAssertState(t, got, ConnectionStateUnobserved, ConnectionReasonInvalidEvidence)
			connectionAssertNoFacts(t, got)
		})
	}
}

func TestObserveConnectionSafeNumericEdges(t *testing.T) {
	context, sample := connectionFixture()
	context.ExpectedInstanceID = strings.Repeat("A", 128)
	sample.RuntimeInstanceID = context.ExpectedInstanceID
	sample.ResponseDelivery = connectionDeliveryFixture()
	details := sample.ResponseDelivery.Details
	details.InProgress, details.Attempts, details.Retries = connectionMaxSafeInteger, connectionMaxSafeInteger, connectionMaxSafeInteger
	details.Accepted, details.Completed, details.TerminalFailures = connectionMaxSafeInteger, connectionMaxSafeInteger, connectionMaxSafeInteger
	sample.ControlPlane.Details.ConfiguredWaitSeconds = float64(connectionMaxSafeInteger) / 1000
	sample.ControlPlane.Details.EffectiveWaitSeconds = 0.001
	got := ObserveConnection(context, sample)
	connectionAssertState(t, got, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
	connectionAssertMillis(t, got.LastResponseAcceptedMillis, 198_000)
	for _, now := range []uint64{connectionMaxSafeInteger, connectionMaxSafeInteger - 45_000} {
		context, sample := connectionFixture()
		context.NowMillis, sample.SnapshotAtMillis = now, now
		sample.ControlPlane.ObservedAtMillis = connectionTestMillis(now)
		sample.ControlPlane.Details.LastSuccessMillis = connectionTestMillis(now)
		got := ObserveConnection(context, sample)
		connectionAssertState(t, got, ConnectionStateUnobserved, ConnectionReasonTimestampOverflow)
		connectionAssertNoFacts(t, got)
	}
}

func TestObserveConnectionResponseAcceptanceIsHistorical(t *testing.T) {
	tests := []struct {
		name     string
		change   func(*ConnectionHealthSnapshot)
		accepted bool
	}{
		{"actual acceptance", func(_ *ConnectionHealthSnapshot) {}, true},
		{"historical acceptance with current delivery failure", func(s *ConnectionHealthSnapshot) {
			s.ResponseDelivery.Status = "degraded"
			s.ResponseDelivery.Details.FailureCategory = connectionTestString("network_error")
		}, true},
		{"forward compatible state", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.State = "future_state" }, true},
		{"missing component", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery = nil }, false},
		{"missing details", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Details = nil }, false},
		{"missing observation", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.ObservedAtMillis = nil }, false},
		{"old transition retains history", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.ObservedAtMillis = connectionTestMillis(154_999) }, true},
		{"component limited", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Limited = true }, false},
		{"runtime limited", func(s *ConnectionHealthSnapshot) { s.RuntimeLimited = true }, false},
		{"truncated", func(s *ConnectionHealthSnapshot) { s.Truncated = true }, false},
		{"unknown status", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Status = "unknown" }, false},
		{"disabled status", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Status = "disabled" }, false},
		{"unsupported status", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Status = "raw error" }, false},
		{"hostile state", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.State = "raw\nerror" }, false},
		{"hostile disposition", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Details.Disposition = "raw\nerror" }, false},
		{"long disposition", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Details.Disposition = strings.Repeat("a", 33) }, false},
		{"unsupported category", func(s *ConnectionHealthSnapshot) {
			s.ResponseDelivery.Details.FailureCategory = connectionTestString("raw-error")
		}, false},
		{"missing acceptance time", func(s *ConnectionHealthSnapshot) { s.ResponseDelivery.Details.LastAcceptedMillis = nil }, false},
		{"uploading alone", func(s *ConnectionHealthSnapshot) {
			s.ResponseDelivery.State = "uploading"
			s.ResponseDelivery.Details.Accepted = 0
			s.ResponseDelivery.Details.LastAcceptedMillis = nil
			s.ResponseDelivery.Details.InProgress = 1
		}, false},
		{"benign completed 404 alone", func(s *ConnectionHealthSnapshot) {
			d := s.ResponseDelivery.Details
			s.ResponseDelivery.State = "completed"
			d.Accepted, d.Completed, d.LastAcceptedMillis = 0, 1, nil
			d.LastCompletedMillis, d.HTTPStatus, d.Disposition = connectionTestMillis(199_000), connectionTestMillis(404), "completed"
		}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			context, sample := connectionFixture()
			sample.ResponseDelivery = connectionDeliveryFixture()
			test.change(sample)
			got := ObserveConnection(context, sample)
			if test.accepted {
				connectionAssertMillis(t, got.LastResponseAcceptedMillis, 198_000)
			} else if got.LastResponseAcceptedMillis != nil {
				t.Fatal("unqualified upload acceptance retained")
			}
			if got.State == ConnectionStateRecentTransport && got.LastPollSuccessMillis == nil {
				t.Fatal("response acceptance substituted for polling")
			}
		})
	}
	context, sample := connectionFixture()
	sample.ControlPlane.Details.LastSuccessMillis = nil
	sample.ResponseDelivery = connectionDeliveryFixture()
	got := ObserveConnection(context, sample)
	connectionAssertState(t, got, ConnectionStateUnobserved, ConnectionReasonNoPollSuccess)
	connectionAssertMillis(t, got.LastResponseAcceptedMillis, 198_000)
	if got.LastPollSuccessMillis != nil {
		t.Fatal("response acceptance made transport positive")
	}
}

func TestObserveConnectionDoesNotMutateOrAliasInputs(t *testing.T) {
	context, sample := connectionFixture()
	_, expected := connectionFixture()
	sample.ResponseDelivery, expected.ResponseDelivery = connectionDeliveryFixture(), connectionDeliveryFixture()
	beforeContext := context
	got, other := ObserveConnection(context, sample), ObserveConnection(context, sample)
	if context != beforeContext || !reflect.DeepEqual(sample, expected) {
		t.Fatal("classification mutated supplied values")
	}
	for _, output := range []*uint64{got.ObservedAtMillis, got.ValidUntilMillis, got.LastPollSuccessMillis, got.LastResponseAcceptedMillis} {
		if output == sample.ControlPlane.ObservedAtMillis || output == sample.ControlPlane.Details.LastSuccessMillis ||
			output == sample.ResponseDelivery.ObservedAtMillis || output == sample.ResponseDelivery.Details.LastAcceptedMillis {
			t.Fatal("output pointer aliases an input")
		}
		*output = 1
	}
	connectionAssertMillis(t, other.ObservedAtMillis, 200_000)
	connectionAssertMillis(t, other.ValidUntilMillis, 245_000)
	connectionAssertMillis(t, other.LastPollSuccessMillis, 199_000)
	connectionAssertMillis(t, other.LastResponseAcceptedMillis, 198_000)
	if !reflect.DeepEqual(sample, expected) {
		t.Fatal("output mutation changed nested input")
	}
	sample.ControlPlane.Status, sample.ControlPlane.State = "degraded", "backoff"
	sample.ControlPlane.Details.LastErrorMillis = connectionTestMillis(200_000)
	sample.ControlPlane.Details.FailureCategory = connectionTestString("timeout")
	sample.ControlPlane.Details.NextRetryMillis = connectionTestMillis(205_000)
	got = ObserveConnection(context, sample)
	if got.NextRetryMillis == sample.ControlPlane.Details.NextRetryMillis {
		t.Fatal("retry pointer aliases input")
	}
	*got.NextRetryMillis = 1
	connectionAssertMillis(t, sample.ControlPlane.Details.NextRetryMillis, 205_000)
}

func TestObserveConnectionValidityUsesSnapshotAndSuccess(t *testing.T) {
	c, s := connectionFixture()
	s.ControlPlane.ObservedAtMillis = connectionTestMillis(155_000)
	s.ControlPlane.Details.LastSuccessMillis = connectionTestMillis(154_000)
	s.ControlPlane.Details.LastAttemptMillis = connectionTestMillis(154_000)
	got := ObserveConnection(c, s)
	connectionAssertState(t, got, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
	connectionAssertMillis(t, got.ValidUntilMillis, 244_000)
	c.NowMillis = 244_001
	got = ObserveConnection(c, s)
	connectionAssertState(t, got, ConnectionStateUnobserved, ConnectionReasonStalePollSuccess)
	connectionAssertMillis(t, got.LastPollSuccessMillis, 154_000)

	c, s = connectionFixture()
	s.ResponseDelivery = connectionDeliveryFixture()
	s.ResponseDelivery.ObservedAtMillis = connectionTestMillis(155_000)
	s.ResponseDelivery.Details.LastAcceptedMillis = connectionTestMillis(154_000)
	got = ObserveConnection(c, s)
	connectionAssertMillis(t, got.ValidUntilMillis, 245_000)
	c.NowMillis++
	got = ObserveConnection(c, s)
	connectionAssertState(t, got, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
	connectionAssertMillis(t, got.LastResponseAcceptedMillis, 154_000)
	connectionAssertMillis(t, got.ValidUntilMillis, 245_000)
}

// Producer observed_at is a transition timestamp; snapshot_at is refreshed on
// every passive read. These values reproduce that distinction without IO.
func TestObserveConnectionProducerTransitions(t *testing.T) {
	t.Run("recent success survives an old transition", func(t *testing.T) {
		c, s := connectionFixture()
		s.ControlPlane.ObservedAtMillis = connectionTestMillis(150_000)
		s.ControlPlane.Details.LastAttemptMillis = connectionTestMillis(150_000)
		s.ControlPlane.Details.LastSuccessMillis = connectionTestMillis(130_000)
		got := ObserveConnection(c, s)
		connectionAssertState(t, got, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
		connectionAssertMillis(t, got.ValidUntilMillis, 220_000)
	})
	t.Run("first long poll has unknown health status while checking", func(t *testing.T) {
		c, s := connectionFixture()
		s.ControlPlane.Status, s.ControlPlane.State = "unknown", "polling"
		s.ControlPlane.ObservedAtMillis = connectionTestMillis(140_000)
		s.ControlPlane.Details.LastAttemptMillis = connectionTestMillis(140_000)
		s.ControlPlane.Details.LastSuccessMillis = nil
		s.ControlPlane.Details.CurrentPollAgeSeconds = 60
		s.ControlPlane.Details.DeadlineSeconds = 180
		got := ObserveConnection(c, s)
		connectionAssertState(t, got, ConnectionStateChecking, ConnectionReasonWaitingWithoutSuccess)
		connectionAssertMillis(t, got.ValidUntilMillis, 245_000)
	})
	t.Run("unchanged backpressure is not an outage", func(t *testing.T) {
		c, s := connectionFixture()
		s.ControlPlane.Status, s.ControlPlane.State = "unknown", "backpressured"
		s.ControlPlane.ObservedAtMillis = connectionTestMillis(80_000)
		s.ControlPlane.Details.LastSuccessMillis = nil
		got := ObserveConnection(c, s)
		connectionAssertState(t, got, ConnectionStateChecking, ConnectionReasonBackpressuredWithoutSuccess)
	})
	t.Run("idle delivery history does not expire current polling", func(t *testing.T) {
		c, s := connectionFixture()
		s.ResponseDelivery = connectionDeliveryFixture()
		s.ResponseDelivery.ObservedAtMillis = connectionTestMillis(80_000)
		s.ResponseDelivery.Details.LastAcceptedMillis = connectionTestMillis(80_000)
		got := ObserveConnection(c, s)
		connectionAssertState(t, got, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
		connectionAssertMillis(t, got.ValidUntilMillis, 245_000)
		connectionAssertMillis(t, got.LastResponseAcceptedMillis, 80_000)
	})
}
