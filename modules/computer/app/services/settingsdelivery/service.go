package settingsdelivery

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/mutation"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

var (
	ErrInvalid         = errors.New("settings_delivery_invalid")
	ErrConflict        = errors.New("settings_delivery_conflict")
	ErrConsumed        = errors.New("settings_delivery_attempt_consumed")
	ErrFenced          = errors.New("settings_delivery_publication_unknown")
	ErrNotWritten      = errors.New("settings_delivery_not_written")
	ErrNotReady        = errors.New("settings_delivery_result_not_ready")
	ErrCapacity        = errors.New("settings_delivery_retention_full")
	ErrEffectUnsettled = errors.New("settings_delivery_effect_unsettled")
)

const MaxAttempts = 4096

// Permit is an opaque live-service capability. Copies and restored Pending
// values cannot mint execution. Its captured edit is never returned or persisted.
type Permit struct {
	pending  Pending
	request  mutation.OwnerRequest
	consumed bool
}

func (p *Permit) Binding() Pending {
	if p == nil {
		return Pending{}
	}
	return p.pending
}

type Retention uint8

const (
	Durable Retention = iota + 1
	MemoryOnly
)

// Receipt binds the original pending, exact offered result and retention.
// Pointer identity is authority; ID is a bounded service-local correlation
// projection ONLY. Root must correlate it within this live service lifetime.
// A copied Receipt or an ID from the wire cannot authorize ACK.
type Receipt struct {
	id                      uint64
	pending                 Pending
	result                  mutation.OwnerResponse
	retention               Retention
	attempted, acknowledged bool
	ackErr                  error
}

func (r *Receipt) ID() string {
	if r == nil {
		return ""
	}
	return strconv.FormatUint(r.id, 10)
}
func (r *Receipt) Binding() Pending {
	if r == nil {
		return Pending{}
	}
	return r.pending
}
func (r *Receipt) Outcome() *mutation.OwnerResponse {
	if r == nil {
		return nil
	}
	return cloneResult(&r.result)
}
func (r *Receipt) Retention() Retention {
	if r == nil {
		return 0
	}
	return r.retention
}

type attempt struct {
	binding   Pending
	permit    *Permit
	result    *mutation.OwnerResponse
	receipt   *Receipt
	settled   bool
	uncertain bool
}

type Service struct {
	identity                               Identity
	store                                  Store
	outcomes                               Outcomes
	clock                                  port.Clock
	gate                                   mutation.Gate
	attempts                               map[string]*attempt
	publicationFence, effectFence, retired bool
	nextReceipt                            uint64
}

// New injects all identity, storage, outcome, clock and serialization sources.
// identity.Generation is ignored; current generation comes from a typed Load.
func New(identity Identity, store Store, outcomes Outcomes, clock port.Clock, gate mutation.Gate) (*Service, error) {
	if !validIdentity(identity) || store == nil || outcomes == nil || clock == nil || gate == nil {
		return nil, ErrInvalid
	}
	return &Service{identity: identity, store: store, outcomes: outcomes, clock: clock, gate: gate, attempts: make(map[string]*attempt)}, nil
}

// Begin binds the original preview selection, refuses a changed current
// generation or existing pending, and saves before issuing one live permit.
// A failed publication never yields a permit; no subsequent Load can repair an
// uncertain save in this service. Operation IDs cannot be reused in a lifetime.
func (s *Service) Begin(ctx context.Context, selected mutation.OwnerSelection, request mutation.OwnerRequest) (*Permit, error) {
	s.gate.Lock()
	defer s.gate.Unlock()
	if err := s.writable(ctx); err != nil {
		return nil, err
	}
	operationID := selected.OperationID
	if selected.ProfileID != s.identity.ProfileID || selected.OwnerID != s.identity.OwnerID || selected.ComputerID != s.identity.ComputerID || selected.ComputerGeneration == 0 || selected.ComputerGeneration > state.MaxSafeInteger {
		return nil, ErrInvalid
	}
	edit, ok := request.Operation.(mutation.Edit)
	edit.Edits = slices.Clone(edit.Edits)
	request = mutation.OwnerRequest{WorkspaceID: request.WorkspaceID, Operation: edit}
	if !ok || mutation.ValidateOwnerRequest(request) != nil || !state.Identifier(operationID, 160) {
		return nil, ErrInvalid
	}
	if s.attempts[operationID] != nil {
		return nil, ErrConsumed
	}
	if len(s.attempts) >= MaxAttempts {
		return nil, ErrCapacity
	}
	snapshot, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	if snapshot.Pending != nil || snapshot.Current.Generation != selected.ComputerGeneration {
		return nil, ErrConflict
	}
	pending := Pending{Backend: "go-owner-v2", OperationID: operationID, ProfileID: s.identity.ProfileID, ComputerGeneration: selected.ComputerGeneration,
		WorkspaceID: request.WorkspaceID, RelativePath: edit.RelativePath, BeforeSHA256: edit.ExpectedSHA256, SubmittedAt: s.clock.Now().UTC().Format(time.RFC3339Nano)}
	if !validPending(pending) {
		return nil, ErrInvalid
	}
	a := &attempt{binding: pending}
	s.attempts[operationID] = a
	if err := s.save(ctx, snapshot, &pending, false); err != nil {
		a.settled = !s.publicationFence
		return nil, err
	}
	a.permit = &Permit{pending: pending, request: mutation.OwnerRequest{WorkspaceID: request.WorkspaceID, Operation: edit}}
	return a.permit, nil
}

// Execute consumes the permit before Load or any outcome call, even on refusal.
// It performs no native admission/journal work itself: one injected invocation
// dispatches the captured original edit through the existing owner engine.
func (s *Service) Execute(ctx context.Context, permit *Permit) (*mutation.OwnerResponse, error) {
	s.gate.Lock()
	defer s.gate.Unlock()
	if permit == nil {
		return nil, ErrConsumed
	}
	a := s.attempts[permit.pending.OperationID]
	if a == nil || a.permit != permit || permit.consumed {
		return nil, ErrConsumed
	}
	permit.consumed = true
	request := permit.request
	permit.request = mutation.OwnerRequest{} // Retain no edit after dispatch consumption.
	if err := s.writable(ctx); err != nil {
		return nil, err
	}
	snapshot, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	if !samePending(snapshot.Pending, &a.binding) || snapshot.Current.Generation != a.binding.ComputerGeneration {
		return nil, ErrConflict
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out, callErr := s.outcomes.Execute(ctx, s.selection(a.binding), request)
	if callErr != nil || out == nil {
		out = unknownResult(a.binding)
	}
	if !s.validResult(a.binding, out) {
		s.retain(a, unknownResult(a.binding))
		return nil, ErrInvalid
	}
	s.retain(a, out)
	if ctx.Err() != nil {
		s.effectFence = true
		a.uncertain = true
		return nil, ctx.Err()
	}
	return cloneResult(a.result), nil
}

// Observe never mints a permit or dispatches. Original generation is retained
// across restart/current generation changes. A retained result is immutable.
// Known durable ACK replays from memory without loading or saving again.
func (s *Service) Observe(ctx context.Context, pending Pending) (*mutation.OwnerResponse, error) {
	s.gate.Lock()
	defer s.gate.Unlock()
	a, err := s.observe(ctx, pending)
	if err != nil {
		return nil, err
	}
	return cloneResult(a.result), nil
}

// Offer exposes a delivery receipt, not an ACK or execution permission.
// Prepared is observable but cannot be offered for terminal UI delivery.
func (s *Service) Offer(ctx context.Context, pending Pending) (*Receipt, error) {
	s.gate.Lock()
	defer s.gate.Unlock()
	a, err := s.observe(ctx, pending)
	if err != nil {
		return nil, err
	}
	if a.result.Phase == "prepared" {
		return nil, ErrNotReady
	}
	if a.uncertain && (a.receipt == nil || !a.receipt.acknowledged) {
		if err := s.invalidate(ctx, a.binding); err != nil {
			return nil, err
		}
	}
	if a.receipt == nil {
		retention := MemoryOnly
		if a.result.Publication == "durable" {
			retention = Durable
		}
		s.nextReceipt++
		a.receipt = &Receipt{id: s.nextReceipt, pending: a.binding, result: *cloneResult(a.result), retention: retention}
	}
	return a.receipt, nil
}

// ACK validates pointer identity and exact still-current pending, then makes
// exactly one conditional clear. Known ACK is replayable without another save.
// ACK preserves the already confirmed verification invalidation.
// An uncertainty/memory-only warning may close UI delivery, but cannot settle
// the separate effect/retirement fence. Unknown clear publication fences forever.
// A proven NotWritten receipt retains that refusal; it is not silently retried.
func (s *Service) ACK(ctx context.Context, receipt *Receipt) error {
	s.gate.Lock()
	defer s.gate.Unlock()
	if receipt == nil {
		return ErrInvalid
	}
	a := s.attempts[receipt.pending.OperationID]
	if a == nil || a.receipt != receipt {
		return ErrInvalid
	}
	if receipt.attempted {
		return receipt.ackErr
	}
	if s.publicationFence {
		return ErrFenced
	}
	if s.retired {
		return ErrEffectUnsettled
	}
	if err := live(ctx); err != nil {
		return err
	}
	snapshot, err := s.load(ctx)
	if err != nil {
		return err
	}
	if !samePending(snapshot.Pending, &a.binding) || a.uncertain && !snapshot.VerificationInvalidated {
		return ErrConflict
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	receipt.attempted = true
	receipt.ackErr = s.save(ctx, snapshot, nil, false)
	receipt.acknowledged = receipt.ackErr == nil
	return receipt.ackErr
}

// FreezeForRetirement blocks new writes before checking this lifetime. ACK is
// delivery only; unresolved/restored/memory-only effects forbid clean retirement.
// This never retires the actual engine/journal; root must check that owner too.
func (s *Service) FreezeForRetirement() error {
	s.gate.Lock()
	defer s.gate.Unlock()
	s.retired = true
	if s.publicationFence {
		return ErrFenced
	}
	if s.effectFence {
		return ErrEffectUnsettled
	}
	for _, a := range s.attempts {
		if !a.settled {
			return ErrEffectUnsettled
		}
	}
	return nil
}

func (s *Service) observe(ctx context.Context, pending Pending) (*attempt, error) {
	if err := live(ctx); err != nil {
		return nil, err
	}
	if !validPending(pending) || !s.owns(pending) {
		return nil, ErrInvalid
	}
	a := s.attempts[pending.OperationID]
	if a != nil && a.binding != pending {
		return nil, ErrConflict
	}
	if a != nil && a.receipt != nil && a.receipt.acknowledged {
		return a, nil
	}
	if a != nil && a.permit != nil && !a.permit.consumed {
		return nil, ErrNotReady
	}
	snapshot, err := s.load(ctx)
	if err != nil {
		return nil, err
	}
	if !samePending(snapshot.Pending, &pending) {
		return nil, ErrConflict
	}
	if a == nil {
		if len(s.attempts) >= MaxAttempts {
			return nil, ErrCapacity
		}
		a = &attempt{binding: pending}
		s.attempts[pending.OperationID] = a
	}
	if a.result == nil || a.result.Phase == "prepared" {
		out, callErr := s.outcomes.Observe(ctx, s.selection(pending), mutation.OwnerObservation{WorkspaceID: pending.WorkspaceID, RelativePath: pending.RelativePath})
		if callErr != nil || out == nil {
			out = unknownResult(pending)
		}
		if !s.validResult(pending, out) {
			s.retain(a, unknownResult(pending))
			return nil, ErrInvalid
		}
		s.retain(a, out)
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return a, nil
}
func (s *Service) retain(a *attempt, out *mutation.OwnerResponse) {
	a.result = cloneResult(out)
	a.settled = out.Publication == "durable" && (out.Phase == "completed" || out.Phase == "failed")
	if !a.settled && out.Phase != "prepared" {
		s.effectFence = true
		a.uncertain = true
	}
}

// Invalidation belongs to this policy; the existing writer performs only the
// requested mechanical projection. A refusal produces no delivery receipt.
func (s *Service) invalidate(ctx context.Context, pending Pending) error {
	if s.retired {
		return ErrEffectUnsettled
	}
	if s.publicationFence {
		return ErrFenced
	}
	if err := live(ctx); err != nil {
		return err
	}
	snapshot, err := s.load(ctx)
	if err != nil {
		return err
	}
	if !samePending(snapshot.Pending, &pending) {
		return ErrConflict
	}
	if snapshot.VerificationInvalidated {
		return nil
	}
	return s.save(ctx, snapshot, &pending, true)
}
func live(ctx context.Context) error {
	if ctx == nil {
		return ErrInvalid
	}
	return ctx.Err()
}
func (s *Service) writable(ctx context.Context) error {
	if s.publicationFence {
		return ErrFenced
	}
	if s.retired || s.effectFence {
		return ErrEffectUnsettled
	}
	return live(ctx)
}
func (s *Service) owns(p Pending) bool { return p.ProfileID == s.identity.ProfileID }
func validIdentity(i Identity) bool {
	return state.Identifier(i.ProfileID, 160) && state.Identifier(i.OwnerID, 80) && state.Identifier(i.ComputerID, 120) && i.Generation > 0 && i.Generation <= state.MaxSafeInteger
}
func validPending(p Pending) bool {
	submitted, err := time.ParseInLocation(time.RFC3339Nano, p.SubmittedAt, time.UTC)
	return p.Backend == "go-owner-v2" && state.Identifier(p.OperationID, 160) && state.Identifier(p.ProfileID, 160) && p.ComputerGeneration > 0 && p.ComputerGeneration <= state.MaxSafeInteger && state.Identifier(p.WorkspaceID, 120) && state.RelativePath(p.RelativePath) && state.SHA256(p.BeforeSHA256) && err == nil && strings.HasSuffix(p.SubmittedAt, "Z") && submitted.UnixMilli() > 0 && uint64(submitted.UnixMilli()) <= state.MaxSafeInteger
}
func (s *Service) load(ctx context.Context) (Snapshot, error) {
	snapshot, err := s.store.Load(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	if err := ctx.Err(); err != nil {
		return Snapshot{}, err
	}
	if snapshot.Revision == 0 || snapshot.Revision >= state.MaxSafeInteger || !validIdentity(snapshot.Current) || snapshot.Current.ProfileID != s.identity.ProfileID || snapshot.Current.OwnerID != s.identity.OwnerID || snapshot.Current.ComputerID != s.identity.ComputerID || snapshot.Pending != nil && (!validPending(*snapshot.Pending) || !s.owns(*snapshot.Pending)) {
		return Snapshot{}, ErrInvalid
	}
	return cloneSnapshot(snapshot), nil
}
func (s *Service) save(ctx context.Context, expected Snapshot, next *Pending, invalidate bool) error {
	if err := live(ctx); err != nil {
		return err
	}
	out, err := s.store.CompareAndSet(ctx, Change{Expected: cloneSnapshot(expected), Next: clonePending(next), InvalidateVerification: invalidate})
	if err == nil && out.Publication == NotWritten && out.Readback == nil {
		return ErrNotWritten
	}
	wanted := Snapshot{Revision: expected.Revision + 1, Current: expected.Current, Pending: next, VerificationInvalidated: expected.VerificationInvalidated || invalidate}
	if err != nil || ctx.Err() != nil || out.Publication != Committed || out.Readback == nil || !sameSnapshot(*out.Readback, wanted) {
		s.publicationFence = true
		return ErrFenced
	}
	return nil
}
func (s *Service) selection(p Pending) mutation.OwnerSelection {
	return mutation.OwnerSelection{OperationID: p.OperationID, ProfileID: p.ProfileID, OwnerID: s.identity.OwnerID, ComputerID: s.identity.ComputerID, ComputerGeneration: p.ComputerGeneration}
}
func unknownResult(p Pending) *mutation.OwnerResponse {
	return &mutation.OwnerResponse{OperationID: p.OperationID, WorkspaceID: p.WorkspaceID, ComputerGeneration: p.ComputerGeneration, Phase: "outcome_unknown", Publication: "memory_only", Failure: &mutation.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}}
}
func (s *Service) validResult(p Pending, r *mutation.OwnerResponse) bool {
	if r == nil || r.OperationID != p.OperationID || r.WorkspaceID != p.WorkspaceID || r.ComputerGeneration != p.ComputerGeneration || r.Publication != "durable" && r.Publication != "memory_only" {
		return false
	}
	var receipt *state.Receipt
	if r.Receipt != nil {
		v := r.Receipt
		if v.Operation != "edit" || v.RelativePath != p.RelativePath || v.BeforeSHA256 == nil || *v.BeforeSHA256 != p.BeforeSHA256 || v.Replacements == 0 {
			return false
		}
		receipt = &state.Receipt{Operation: state.EditKind, RelativePath: v.RelativePath, Bytes: v.Bytes, Replacements: v.Replacements, BeforeSHA256: v.BeforeSHA256, AfterSHA256: v.AfterSHA256}
	}
	var failure *state.Failure
	if r.Failure != nil {
		failure = &state.Failure{Code: r.Failure.Code, Source: r.Failure.Source}
	}
	// Restore validates phase/receipt/failure shape only. The actual journal
	// request digest is owned by the engine; no digest/effect evidence is minted.
	binding := state.Binding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: p.OperationID, ProfileID: p.ProfileID, OwnerID: s.identity.OwnerID, ComputerID: s.identity.ComputerID}, WorkspaceID: p.WorkspaceID, ComputerGeneration: p.ComputerGeneration, RelativePath: p.RelativePath, RequestDigest: p.BeforeSHA256}
	_, err := state.Restore(binding, state.Phase(r.Phase), receipt, failure)
	return err == nil
}
func cloneResult(r *mutation.OwnerResponse) *mutation.OwnerResponse {
	if r == nil {
		return nil
	}
	copy := *r
	if r.Receipt != nil {
		v := *r.Receipt
		if v.BeforeSHA256 != nil {
			hash := *v.BeforeSHA256
			v.BeforeSHA256 = &hash
		}
		copy.Receipt = &v
	}
	if r.Failure != nil {
		v := *r.Failure
		copy.Failure = &v
	}
	return &copy
}
func clonePending(p *Pending) *Pending {
	if p == nil {
		return nil
	}
	copy := *p
	return &copy
}
func cloneSnapshot(s Snapshot) Snapshot { s.Pending = clonePending(s.Pending); return s }
func samePending(a, b *Pending) bool    { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func sameSnapshot(a, b Snapshot) bool {
	return a.VerificationInvalidated == b.VerificationInvalidated && a.Revision == b.Revision && a.Current == b.Current && samePending(a.Pending, b.Pending)
}
