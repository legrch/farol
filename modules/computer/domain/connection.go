package domain

import "math"

const (
	connectionMaxSafeInteger uint64 = 1<<53 - 1
	connectionSnapshotAge    uint64 = 45_000
	connectionSuccessAge     uint64 = 90_000
)

// ConnectionHealthSnapshot contains detached, normalized observations, not authority.
type ConnectionHealthSnapshot struct {
	SnapshotAtMillis       uint64
	RuntimeInstanceID      string
	RuntimeStartedAtMillis uint64
	RuntimeLifecycle       string
	RuntimeLimited         bool
	Live                   bool
	Ready                  bool
	Truncated              bool
	ControlPlane           *ControlPlaneHealth
	ResponseDelivery       *ResponseDeliveryHealth
}

type ControlPlaneHealth struct {
	Status           string
	State            string
	Limited          bool
	ObservedAtMillis *uint64
	Details          *ControlPlaneHealthDetails
}

type ControlPlaneHealthDetails struct {
	LastAttemptMillis     *uint64
	LastSuccessMillis     *uint64
	LastErrorMillis       *uint64
	NextRetryMillis       *uint64
	ConsecutiveFailures   uint64
	CurrentPollAgeSeconds float64
	ConfiguredWaitSeconds float64
	EffectiveWaitSeconds  float64
	DeadlineSeconds       float64
	FailureCategory       *string
	HTTPStatus            *uint64
}

type ResponseDeliveryHealth struct {
	Status           string
	State            string
	Limited          bool
	ObservedAtMillis *uint64
	Details          *ResponseDeliveryHealthDetails
}

type ResponseDeliveryHealthDetails struct {
	InProgress          uint64
	Attempts            uint64
	Retries             uint64
	Accepted            uint64
	Completed           uint64
	TerminalFailures    uint64
	LastAcceptedMillis  *uint64
	LastCompletedMillis *uint64
	LastFailureMillis   *uint64
	Disposition         string
	FailureCategory     *string
	HTTPStatus          *uint64
}

// ConnectionContext is supplied by the trusted host, separately from health data.
type ConnectionContext struct {
	NowMillis          uint64
	Current            bool
	ExpectedInstanceID string
	OwnerStopped       bool
	RecoveryRequired   bool
	Reconnecting       bool
}

type ConnectionState string

const (
	ConnectionStateRecentTransport ConnectionState = "recent_transport"
	ConnectionStateChecking        ConnectionState = "checking"
	ConnectionStateReconnecting    ConnectionState = "reconnecting"
	ConnectionStateUnavailable     ConnectionState = "unavailable"
	ConnectionStateUnobserved      ConnectionState = "unobserved"
	ConnectionStateActionRequired  ConnectionState = "action_required"
	ConnectionStateStopped         ConnectionState = "stopped"
)

type ConnectionReason string

const (
	ConnectionReasonOwnerStopped                  ConnectionReason = "owner_stopped"
	ConnectionReasonRecoveryRequired              ConnectionReason = "recovery_required"
	ConnectionReasonNotCurrent                    ConnectionReason = "not_current"
	ConnectionReasonInvalidClock                  ConnectionReason = "invalid_clock"
	ConnectionReasonMissingSnapshot               ConnectionReason = "missing_snapshot"
	ConnectionReasonInvalidInstance               ConnectionReason = "invalid_instance"
	ConnectionReasonInstanceMismatch              ConnectionReason = "instance_mismatch"
	ConnectionReasonInvalidSnapshot               ConnectionReason = "invalid_snapshot"
	ConnectionReasonInvalidEvidence               ConnectionReason = "invalid_evidence"
	ConnectionReasonStaleSnapshot                 ConnectionReason = "stale_snapshot"
	ConnectionReasonTimestampOverflow             ConnectionReason = "timestamp_overflow"
	ConnectionReasonLocalNotLive                  ConnectionReason = "local_not_live"
	ConnectionReasonRuntimeStarting               ConnectionReason = "runtime_starting"
	ConnectionReasonRuntimeDraining               ConnectionReason = "runtime_draining"
	ConnectionReasonLocalNotReady                 ConnectionReason = "local_not_ready"
	ConnectionReasonReconnecting                  ConnectionReason = "reconnecting"
	ConnectionReasonPollingMissing                ConnectionReason = "polling_missing"
	ConnectionReasonPollingLimited                ConnectionReason = "polling_limited"
	ConnectionReasonPollingDisabled               ConnectionReason = "polling_disabled"
	ConnectionReasonPollingUnknown                ConnectionReason = "polling_unknown"
	ConnectionReasonPollingUnsupported            ConnectionReason = "polling_unsupported"
	ConnectionReasonPollingStale                  ConnectionReason = "polling_stale"
	ConnectionReasonPollingStopped                ConnectionReason = "polling_stopped"
	ConnectionReasonFailureUnobserved             ConnectionReason = "failure_unobserved"
	ConnectionReasonAuthorizationRequired         ConnectionReason = "authorization_required"
	ConnectionReasonHTTPUnavailable               ConnectionReason = "http_unavailable"
	ConnectionReasonTransportUnavailable          ConnectionReason = "transport_unavailable"
	ConnectionReasonRequestUnobserved             ConnectionReason = "request_unobserved"
	ConnectionReasonFailureCanceled               ConnectionReason = "failure_canceled"
	ConnectionReasonRecentPollSuccess             ConnectionReason = "recent_poll_success"
	ConnectionReasonNoPollSuccess                 ConnectionReason = "no_poll_success"
	ConnectionReasonStalePollSuccess              ConnectionReason = "stale_poll_success"
	ConnectionReasonWaitingWithoutSuccess         ConnectionReason = "waiting_without_success"
	ConnectionReasonWaitingWithStaleSuccess       ConnectionReason = "waiting_with_stale_success"
	ConnectionReasonBackpressuredWithoutSuccess   ConnectionReason = "backpressured_without_success"
	ConnectionReasonBackpressuredWithStaleSuccess ConnectionReason = "backpressured_with_stale_success"
	ConnectionReasonPollDeadlineExceeded          ConnectionReason = "poll_deadline_exceeded"
)

// ConnectionObservation is presentation only. It cannot clear an unknown effect,
// authorize recovery, or establish ChatGPT attachment or owner-command success.
type ConnectionObservation struct {
	State                      ConnectionState
	Reason                     ConnectionReason
	ObservedAtMillis           *uint64
	ValidUntilMillis           *uint64
	LastPollSuccessMillis      *uint64
	LastResponseAcceptedMillis *uint64
	NextRetryMillis            *uint64
	LocalReady                 bool
}

// ObserveConnection uses only the supplied clock, generation and detached values.
func ObserveConnection(context ConnectionContext, sample *ConnectionHealthSnapshot) ConnectionObservation {
	if context.OwnerStopped {
		return connectionObservation(ConnectionStateStopped, ConnectionReasonOwnerStopped)
	}
	if context.RecoveryRequired {
		return connectionObservation(ConnectionStateActionRequired, ConnectionReasonRecoveryRequired)
	}
	if !context.Current {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonNotCurrent)
	}
	if !connectionTimestamp(context.NowMillis) {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonInvalidClock)
	}
	if !connectionIdentifier(context.ExpectedInstanceID, 128) {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonInvalidInstance)
	}
	if sample == nil {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonMissingSnapshot)
	}
	if !connectionIdentifier(sample.RuntimeInstanceID, 128) {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonInvalidInstance)
	}
	if sample.RuntimeInstanceID != context.ExpectedInstanceID {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonInstanceMismatch)
	}
	if !connectionTimestamp(sample.SnapshotAtMillis) || !connectionTimestamp(sample.RuntimeStartedAtMillis) ||
		sample.SnapshotAtMillis > context.NowMillis || sample.RuntimeStartedAtMillis > sample.SnapshotAtMillis ||
		!connectionLifecycle(sample.RuntimeLifecycle) {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonInvalidSnapshot)
	}
	if !connectionEvidenceValid(sample) {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonInvalidEvidence)
	}
	if context.NowMillis-sample.SnapshotAtMillis > connectionSnapshotAge {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonStaleSnapshot)
	}
	until, ok := connectionAdd(sample.SnapshotAtMillis, connectionSnapshotAge)
	if !ok {
		return connectionObservation(ConnectionStateUnobserved, ConnectionReasonTimestampOverflow)
	}
	lastAccepted := connectionLastAccepted(sample)
	observation := ConnectionObservation{
		ObservedAtMillis:           connectionMillis(sample.SnapshotAtMillis),
		ValidUntilMillis:           connectionMillis(until),
		LocalReady:                 sample.Live && sample.Ready && sample.RuntimeLifecycle == "running",
		LastResponseAcceptedMillis: lastAccepted,
	}
	if !sample.Live {
		return connectionPending(observation, context, ConnectionReasonLocalNotLive)
	}
	if sample.RuntimeLifecycle == "starting" {
		return connectionPending(observation, context, ConnectionReasonRuntimeStarting)
	}
	if sample.RuntimeLifecycle == "draining" {
		return connectionPending(observation, context, ConnectionReasonRuntimeDraining)
	}
	if !sample.Ready {
		return connectionPending(observation, context, ConnectionReasonLocalNotReady)
	}
	if context.Reconnecting {
		return connectionWithState(observation, ConnectionStateReconnecting, ConnectionReasonReconnecting)
	}
	if sample.RuntimeLimited || sample.Truncated {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingLimited)
	}
	poll := sample.ControlPlane
	if poll == nil {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingMissing)
	}
	if poll.Limited {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingLimited)
	}
	switch poll.Status {
	case "disabled":
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingDisabled)
	case "unknown", "ok", "degraded":
	default:
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingUnsupported)
	}
	if !connectionPollingState(poll.State) {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingUnsupported)
	}
	if poll.ObservedAtMillis == nil || poll.Details == nil {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingMissing)
	}
	// Component observed_at records a transition, not the time of this read.
	// Only snapshot_at bounds observation freshness; historical facts never
	// extend that bound or establish an attachment.
	if poll.State == "stopped" {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingStopped)
	}
	details := poll.Details
	if poll.Status == "unknown" && details.LastSuccessMillis != nil {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingUnknown)
	}
	if details.LastSuccessMillis != nil {
		observation.LastPollSuccessMillis = connectionMillis(*details.LastSuccessMillis)
	}
	if details.LastErrorMillis != nil && (details.LastSuccessMillis == nil || *details.LastErrorMillis >= *details.LastSuccessMillis) {
		state, reason := connectionFailure(poll)
		observation = connectionWithState(observation, state, reason)
		if state == ConnectionStateUnavailable || poll.State == "backoff" {
			observation.NextRetryMillis = connectionNextRetry(context, details)
		}
		return observation
	}
	// A degraded/backoff report without a dated failure cannot establish its order.
	if details.LastErrorMillis == nil && (poll.Status == "degraded" || poll.State == "backoff" || details.ConsecutiveFailures > 0 || details.FailureCategory != nil || (details.HTTPStatus != nil && *details.HTTPStatus >= 400)) {
		if poll.State == "backoff" {
			observation.NextRetryMillis = connectionNextRetry(context, details)
		}
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonFailureUnobserved)
	}
	if details.FailureCategory != nil && !connectionFailureCategory(*details.FailureCategory) {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonFailureUnobserved)
	}
	if details.LastSuccessMillis != nil && context.NowMillis-*details.LastSuccessMillis <= connectionSuccessAge {
		successUntil, ok := connectionAdd(*details.LastSuccessMillis, connectionSuccessAge)
		if !ok {
			return connectionObservation(ConnectionStateUnobserved, ConnectionReasonTimestampOverflow)
		}
		observation.ValidUntilMillis = connectionMillis(min(until, successUntil))
		observation.LastPollSuccessMillis = connectionMillis(*details.LastSuccessMillis)
		return connectionWithState(observation, ConnectionStateRecentTransport, ConnectionReasonRecentPollSuccess)
	}
	hasStaleSuccess := details.LastSuccessMillis != nil
	switch poll.State {
	case "polling":
		if details.LastAttemptMillis == nil {
			return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingMissing)
		}
		deadline, ok := connectionAdd(*details.LastAttemptMillis, uint64(math.Ceil(details.DeadlineSeconds*1000)))
		if !ok {
			return connectionObservation(ConnectionStateUnobserved, ConnectionReasonTimestampOverflow)
		}
		// Snapshot transit time does not renew the original poll budget. A
		// small reported age cannot override its dated original attempt.
		if context.NowMillis <= deadline && details.CurrentPollAgeSeconds <= details.DeadlineSeconds {
			observation.ValidUntilMillis = connectionMillis(min(until, deadline))
			reason := ConnectionReasonWaitingWithoutSuccess
			if hasStaleSuccess {
				reason = ConnectionReasonWaitingWithStaleSuccess
			}
			return connectionWithState(observation, ConnectionStateChecking, reason)
		}
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollDeadlineExceeded)
	case "backpressured":
		reason := ConnectionReasonBackpressuredWithoutSuccess
		if hasStaleSuccess {
			reason = ConnectionReasonBackpressuredWithStaleSuccess
		}
		return connectionWithState(observation, ConnectionStateChecking, reason)
	}
	if poll.Status == "unknown" && poll.State != "starting" {
		return connectionWithState(observation, ConnectionStateUnobserved, ConnectionReasonPollingUnknown)
	}
	reason := ConnectionReasonNoPollSuccess
	if hasStaleSuccess {
		reason = ConnectionReasonStalePollSuccess
	}
	if poll.State == "starting" {
		return connectionWithState(observation, ConnectionStateChecking, reason)
	}
	return connectionWithState(observation, ConnectionStateUnobserved, reason)
}

func connectionFailure(poll *ControlPlaneHealth) (ConnectionState, ConnectionReason) {
	details := poll.Details
	category := ""
	if details.FailureCategory != nil {
		category = *details.FailureCategory
		if !connectionFailureCategory(category) {
			return ConnectionStateUnobserved, ConnectionReasonFailureUnobserved
		}
	}
	switch category {
	case "canceled":
		return ConnectionStateChecking, ConnectionReasonFailureCanceled
	case "request_error":
		return ConnectionStateUnobserved, ConnectionReasonRequestUnobserved
	}
	if details.HTTPStatus != nil {
		status := *details.HTTPStatus
		if status == 401 || status == 403 {
			return ConnectionStateActionRequired, ConnectionReasonAuthorizationRequired
		}
		if status == 429 || status >= 500 {
			return ConnectionStateUnavailable, ConnectionReasonHTTPUnavailable
		}
	}
	if category == "timeout" || category == "network_error" {
		return ConnectionStateUnavailable, ConnectionReasonTransportUnavailable
	}
	return ConnectionStateUnobserved, ConnectionReasonFailureUnobserved
}

func connectionEvidenceValid(sample *ConnectionHealthSnapshot) bool {
	if poll := sample.ControlPlane; poll != nil {
		if !connectionPastTimestamp(poll.ObservedAtMillis, sample) {
			return false
		}
		if d := poll.Details; d != nil {
			if !connectionPastTimestamp(d.LastAttemptMillis, sample) || !connectionPastTimestamp(d.LastSuccessMillis, sample) ||
				!connectionPastTimestamp(d.LastErrorMillis, sample) || !connectionOptionalTimestamp(d.NextRetryMillis) ||
				d.ConsecutiveFailures > connectionMaxSafeInteger || !connectionHTTPStatus(d.HTTPStatus) ||
				!connectionSeconds(d.CurrentPollAgeSeconds) || !connectionSeconds(d.ConfiguredWaitSeconds) ||
				!connectionSeconds(d.EffectiveWaitSeconds) || !connectionSeconds(d.DeadlineSeconds) {
				return false
			}
			if poll.State == "polling" {
				// Millisecond truncation permits at most one millisecond of rounding.
				start := sample.RuntimeStartedAtMillis
				if d.LastAttemptMillis != nil {
					start = *d.LastAttemptMillis
				}
				if d.DeadlineSeconds <= 0 || d.CurrentPollAgeSeconds > float64(sample.SnapshotAtMillis-start)/1000+0.001 {
					return false
				}
			}
		}
	}
	if delivery := sample.ResponseDelivery; delivery != nil {
		if !connectionPastTimestamp(delivery.ObservedAtMillis, sample) {
			return false
		}
		if d := delivery.Details; d != nil {
			if d.InProgress > connectionMaxSafeInteger || d.Attempts > connectionMaxSafeInteger ||
				d.Retries > connectionMaxSafeInteger || d.Accepted > connectionMaxSafeInteger ||
				d.Completed > connectionMaxSafeInteger || d.TerminalFailures > connectionMaxSafeInteger ||
				!connectionPastTimestamp(d.LastAcceptedMillis, sample) || !connectionPastTimestamp(d.LastCompletedMillis, sample) ||
				!connectionPastTimestamp(d.LastFailureMillis, sample) || !connectionHTTPStatus(d.HTTPStatus) {
				return false
			}
		}
	}
	return true
}

func connectionLastAccepted(sample *ConnectionHealthSnapshot) *uint64 {
	delivery := sample.ResponseDelivery
	if sample.RuntimeLimited || sample.Truncated || delivery == nil || delivery.Limited ||
		(delivery.Status != "ok" && delivery.Status != "degraded") ||
		!connectionIdentifier(delivery.State, 32) || delivery.ObservedAtMillis == nil ||
		delivery.Details == nil {
		return nil
	}
	details := delivery.Details
	if details.Accepted == 0 || details.LastAcceptedMillis == nil || !connectionIdentifier(details.Disposition, 32) ||
		(details.FailureCategory != nil && !connectionFailureCategory(*details.FailureCategory)) {
		return nil
	}
	return connectionMillis(*details.LastAcceptedMillis)
}

func connectionNextRetry(context ConnectionContext, details *ControlPlaneHealthDetails) *uint64 {
	if details.NextRetryMillis == nil || *details.NextRetryMillis < context.NowMillis {
		return nil
	}
	return connectionMillis(*details.NextRetryMillis)
}

func connectionTimestamp(value uint64) bool {
	return value > 0 && value <= connectionMaxSafeInteger
}

func connectionOptionalTimestamp(value *uint64) bool {
	return value == nil || connectionTimestamp(*value)
}

func connectionPastTimestamp(value *uint64, sample *ConnectionHealthSnapshot) bool {
	return value == nil || connectionTimestamp(*value) && *value >= sample.RuntimeStartedAtMillis && *value <= sample.SnapshotAtMillis
}

func connectionSeconds(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= float64(connectionMaxSafeInteger)/1000
}

func connectionHTTPStatus(value *uint64) bool {
	return value == nil || *value >= 100 && *value <= 599
}

func connectionIdentifier(value string, limit int) bool {
	if len(value) == 0 || len(value) > limit {
		return false
	}
	for i := 0; i < len(value); i++ {
		char := value[i]
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-') {
			return false
		}
	}
	return true
}

func connectionLifecycle(value string) bool {
	return value == "starting" || value == "running" || value == "draining"
}

func connectionPollingState(value string) bool {
	switch value {
	case "starting", "polling", "idle", "backoff", "backpressured", "stopped":
		return true
	}
	return false
}

func connectionFailureCategory(value string) bool {
	switch value {
	case "http_error", "timeout", "canceled", "network_error", "request_error":
		return true
	}
	return false
}

func connectionAdd(value, delta uint64) (uint64, bool) {
	if value > connectionMaxSafeInteger || delta > connectionMaxSafeInteger-value {
		return 0, false
	}
	return value + delta, true
}

func connectionMillis(value uint64) *uint64 { return &value }

func connectionObservation(state ConnectionState, reason ConnectionReason) ConnectionObservation {
	return ConnectionObservation{State: state, Reason: reason}
}

func connectionWithState(observation ConnectionObservation, state ConnectionState, reason ConnectionReason) ConnectionObservation {
	observation.State, observation.Reason = state, reason
	return observation
}

func connectionPending(observation ConnectionObservation, context ConnectionContext, reason ConnectionReason) ConnectionObservation {
	state := ConnectionStateChecking
	if context.Reconnecting {
		state = ConnectionStateReconnecting
	}
	return connectionWithState(observation, state, reason)
}
