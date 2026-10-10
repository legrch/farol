// Package planledger maps plan inference onto the original Chat lifecycle
// journal owner. It owns no database, native root, recovery or admission grant.
package planledger

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/services/inference"
	"github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
)

// Capture pins the root's detached original request/source/selection witness.
// It must synchronously verify the exact Binding and intent, and return the
// previously captured original journal head plus the complete identity witness
// digest. A current source head alone proves neither account nor delivery rights.
// It must not return a fresh replacement capture for an already consumed request.
type Capture func(inference.Binding, string) (lifecycle.PlanHead, string, error)

type Ledger struct {
	mu         sync.Mutex
	repository planRepository
	capture    Capture
	original   *original
}
type planRepository interface {
	ReservePlan(context.Context, lifecycle.PlanReservation) (bool, error)
	SettlePlan(context.Context, lifecycle.PlanReservation, lifecycle.PlanOutcome) error
}

type original struct {
	binding     inference.Binding
	reservation lifecycle.PlanReservation
}

var _ inference.Ledger = (*Ledger)(nil)

// New binds a ledger to one original operation on the existing owner. The small
// in-memory receipt carries no prompts, text or credentials and cannot resume IO.
func New(repository *lifecycle.Repository, capture Capture) (*Ledger, error) {
	if repository == nil || capture == nil {
		return nil, inference.Invalid
	}
	return &Ledger{repository: repository, capture: capture}, nil
}
func hash(raw []byte) string                   { v := sha256.Sum256(raw); return hex.EncodeToString(v[:]) }
func bindingDigest(b inference.Binding) string { raw, _ := json.Marshal(b); return hash(raw) }

func boundedID(value string) bool {
	if len(value) == 0 || len(value) > 120 || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if r <= 32 || r == 127 {
			return false
		}
	}
	return true
}
func boundedBinding(b inference.Binding) bool {
	for _, value := range []string{b.OperationID, b.ProfileID, b.BackendGeneration, b.OwnerID, b.SessionID, b.Context.CheckpointID} {
		if !boundedID(value) {
			return false
		}
	}
	if len(b.Context.InputHash) != 64 {
		return false
	}
	for _, r := range b.Context.InputHash {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return inference.ValidSelection(b.Selection) && b.DeadlineMillis > 0 && b.Context.TokenLimit > 0 && b.Context.EstimatedTokens <= b.Context.TokenLimit
}

func (l *Ledger) Reserve(ctx context.Context, b inference.Binding, intent string) (bool, error) {
	if l == nil || ctx == nil || !boundedBinding(b) {
		return false, inference.Invalid
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.original != nil {
		if l.original.binding != b || l.original.reservation.IntentDigest != intent {
			return false, inference.Conflict
		}
		return l.repository.ReservePlan(ctx, l.original.reservation)
	}
	source, witness, err := l.capture(b, intent)
	if err != nil {
		return false, err
	}
	if b.ProfileID != source.Scope.ProfileID || b.BackendGeneration != source.Scope.BackendGeneration || b.OperationID == "" {
		return false, inference.Invalid
	}
	reservation := lifecycle.PlanReservation{Source: source, OperationDigest: hash([]byte(b.OperationID)), BindingDigest: bindingDigest(b), IntentDigest: intent, WitnessDigest: witness}
	// Retain the original capture even if publication is uncertain. A later call
	// reaches the SAME poisoned owner and cannot ask Capture for a newer source.
	l.original = &original{binding: b, reservation: reservation}
	return l.repository.ReservePlan(ctx, reservation)
}

func (l *Ledger) Settle(ctx context.Context, b inference.Binding, o inference.Outcome) error {
	if l == nil || ctx == nil {
		return inference.Invalid
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.original == nil || l.original.binding != b {
		return inference.Conflict
	}
	// Text is refused, not persisted or silently stripped; Service supplies
	// metadata only. Local suppression/publication never rewrites remote facts.
	if o.Text != "" || o.RemoteState != "" || (o.ResponseID != "" && !boundedID(o.ResponseID)) {
		return inference.Invalid
	}
	remote := lifecycle.PlanOutcome{State: string(o.State), Code: string(o.Code), HTTPStatus: o.HTTPStatus}
	if o.ResponseID != "" {
		remote.ResponseDigest = hash([]byte(o.ResponseID))
	}
	return l.repository.SettlePlan(ctx, l.original.reservation, remote)
}
