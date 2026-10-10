package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/legrch/farol/modules/chat/app/port"
)

// PlanHead is the exact original image and browser-source revision, captured
// under this repository's existing owner. It is not account or delivery admission.
type PlanHead struct {
	Scope             port.JournalScope
	Revision          uint64
	PublicationDigest string
}

// PlanReservation contains only hashes of the original operation, binding,
// request and complete detached source/selection witness. No prompt, answer,
// token, account value or provider diagnostic belongs to this journal.
type PlanReservation struct {
	Source                                                      PlanHead
	OperationDigest, BindingDigest, IntentDigest, WitnessDigest string
}

// PlanOutcome is a closed bounded remote fact. Delivery withdrawal does not
// erase an observed completion. A reservation without Outcome remains unknown;
// canonical stored bytes never authorize replay or recovery.
type PlanOutcome struct {
	State          string
	ResponseDigest string
	Code           string
	HTTPStatus     int
}

type planRecord struct {
	Source                                                      PlanHead
	OperationDigest, BindingDigest, IntentDigest, WitnessDigest string
	Outcome                                                     *PlanOutcome `json:",omitempty"`
}

func planRecordFor(v PlanReservation) planRecord {
	return planRecord{Source: v.Source, OperationDigest: v.OperationDigest, BindingDigest: v.BindingDigest, IntentDigest: v.IntentDigest, WitnessDigest: v.WitnessDigest}
}
func planHash(raw []byte) string { v := sha256.Sum256(raw); return hex.EncodeToString(v[:]) }
func samePlan(v planRecord, r PlanReservation) bool {
	return v.Source == r.Source && v.OperationDigest == r.OperationDigest && v.BindingDigest == r.BindingDigest && v.IntentDigest == r.IntentDigest && v.WitnessDigest == r.WitnessDigest
}
func validPlan(v planRecord, value record) bool {
	return v.Source.Scope == value.Scope && v.Source.Revision <= uint64(len(value.Writes)) && validIntentDigest(v.Source.PublicationDigest) && validIntentDigest(v.OperationDigest) && validIntentDigest(v.BindingDigest) && validIntentDigest(v.IntentDigest) && validIntentDigest(v.WitnessDigest) && (v.Outcome == nil || validPlanOutcome(*v.Outcome))
}
func validPlanOutcome(o PlanOutcome) bool {
	if o.HTTPStatus < 0 || o.HTTPStatus > 599 || (o.HTTPStatus > 0 && o.HTTPStatus < 100) || (o.ResponseDigest != "" && !validIntentDigest(o.ResponseDigest)) {
		return false
	}
	if o.State == "completed" {
		return o.ResponseDigest != "" && o.Code == ""
	}
	if o.State != "not_sent" && o.State != "unknown" && o.State != "failed" {
		return false
	}
	switch o.Code {
	case "INFERENCE_INVALID", "INFERENCE_WITHDRAWN", "INFERENCE_CREDENTIAL_UNAVAILABLE", "INFERENCE_SCOPE_MISSING", "INFERENCE_CANCELLED", "INFERENCE_CREDENTIAL_REFRESH_UNKNOWN", "INFERENCE_PROVIDER_PROTOCOL", "INFERENCE_HTTP_REJECTED", "INFERENCE_MODEL_DENIED", "INFERENCE_USAGE_LIMITED", "INFERENCE_CREDENTIAL_REJECTED", "INFERENCE_TRANSPORT_UNKNOWN", "INFERENCE_STREAM_INVALID", "INFERENCE_STREAM_LIMIT", "INFERENCE_STREAM_INCOMPLETE", "INFERENCE_PROVIDER_FAILED", "INFERENCE_PROVIDER_REFUSED":
		return true
	}
	return false
}

func validatePlans(value record, limits Limits, browser map[string]port.TurnBinding) error {
	if len(value.Plans) == 0 {
		return nil
	}
	// Original retirement/successor policies know browser-only metadata. They must
	// not silently discard consumed plan operations, even completed ones.
	if value.Version != 3 || value.Retirement != nil {
		return Invalid
	}
	count := len(value.Writes) + len(value.Plans)
	used := make(map[string]bool, len(browser)+len(value.Plans))
	for operation := range browser {
		used[planHash([]byte(operation))] = true
	}
	for _, v := range value.Plans {
		if !validPlan(v, value) || used[v.OperationDigest] {
			return Invalid
		}
		used[v.OperationDigest] = true
		if v.Outcome != nil {
			count++
		}
	}
	if count > limits.Records {
		return Invalid
	}
	return nil
}

func (s *owner) planVisible(ctx context.Context) error {
	if err := s.checkContext(ctx); err != nil {
		return err
	}
	if !s.opened || s.current.Retirement != nil {
		return s.reject(Refused, false)
	}
	raw, err := s.disk.read(s.limits.Bytes)
	if err != nil {
		return s.storageFailure(err)
	}
	if sha256.Sum256(raw) != s.digest {
		return s.reject(Unavailable, false)
	}
	return nil
}
func (s *owner) planHead() PlanHead {
	return PlanHead{Scope: s.current.Scope, Revision: uint64(len(s.current.Writes)), PublicationDigest: hex.EncodeToString(s.digest[:])}
}

// CapturePlanHead reads the original qualified image. Source changes, including
// another reservation, make that capture stale before a fresh ReservePlan.
func (r *Repository) CapturePlanHead(ctx context.Context) (PlanHead, error) {
	if r == nil || r.owner == nil || ctx == nil {
		return PlanHead{}, failure(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.planVisible(ctx); err != nil {
		return PlanHead{}, err
	}
	return s.planHead(), nil
}

func (s *owner) publishPlan(ctx context.Context, candidate record) error {
	raw, err := encode(candidate, s.limits)
	if err != nil {
		return s.reject(Refused, false)
	}
	if ctx.Err() != nil {
		return s.reject(Cancelled, false)
	}
	if err = s.disk.replace(ctx, raw, s.digest, s.limits.Bytes); err != nil {
		return s.storageFailure(err)
	}
	visible, err := s.disk.read(s.limits.Bytes)
	if err != nil || sha256.Sum256(visible) != sha256.Sum256(raw) || ctx.Err() != nil {
		return s.reject(Unknown, true)
	}
	s.current, s.digest = candidate, sha256.Sum256(raw)
	return nil
}

// ReservePlan consumes the original operation atomically before provider IO.
// Exact existing metadata returns not-fresh, including after lost ACK. A
// different capture is a conflict, never permission to replay the operation.
func (r *Repository) ReservePlan(ctx context.Context, reservation PlanReservation) (bool, error) {
	if r == nil || r.owner == nil || ctx == nil {
		return false, failure(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.planVisible(ctx); err != nil {
		return false, err
	}
	incoming := planRecordFor(reservation)
	if !validPlan(incoming, s.current) {
		return false, s.reject(Refused, false)
	}
	for _, prior := range s.current.Plans {
		if prior.OperationDigest == reservation.OperationDigest {
			if !samePlan(prior, reservation) {
				return false, s.reject(Refused, false)
			}
			return false, nil
		}
	}
	if reservation.Source != s.planHead() {
		return false, s.reject(Refused, false)
	}
	candidate := s.current
	candidate.Plans = append(append([]planRecord(nil), s.current.Plans...), incoming)
	if err := s.publishPlan(ctx, candidate); err != nil {
		return false, err
	}
	return true, nil
}

// SettlePlan records only the original remote outcome; current source revision,
// account consent and publication may already be withdrawn. The immutable
// original reservation still has to match exactly. No second settlement effect
// is attempted, and an unknown publication poisons this same owner.
func (r *Repository) SettlePlan(ctx context.Context, reservation PlanReservation, outcome PlanOutcome) error {
	if r == nil || r.owner == nil || ctx == nil {
		return failure(Invalid, false)
	}
	s := r.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.planVisible(ctx); err != nil {
		return err
	}
	if !validPlanOutcome(outcome) {
		return s.reject(Refused, false)
	}
	for n, prior := range s.current.Plans {
		if prior.OperationDigest != reservation.OperationDigest {
			continue
		}
		if !samePlan(prior, reservation) {
			return s.reject(Refused, false)
		}
		if prior.Outcome != nil {
			if *prior.Outcome != outcome {
				return s.reject(Refused, false)
			}
			return nil
		}
		candidate := s.current
		candidate.Plans = append([]planRecord(nil), s.current.Plans...)
		copy := outcome
		candidate.Plans[n].Outcome = &copy
		return s.publishPlan(ctx, candidate)
	}
	return s.reject(Refused, false)
}
