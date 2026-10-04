// Package accountapproval owns one in-memory explicit local account approval.
// It proves only a bounded snapshot check. Trusted composition separately owns
// live provider/account/workspace binding and the exact Chat send guard. There is
// no provider entitlement, authentication, persistence, observation refresh, or
// retry authority here. Unknown/mismatched observations never revoke implicitly.
package accountapproval

import (
	"context"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_ACCOUNT_APPROVAL_INVALID"
	Mismatch    Code = "CHAT_ACCOUNT_APPROVAL_MISMATCH"
	Unavailable Code = "CHAT_ACCOUNT_APPROVAL_UNAVAILABLE"
	Stale       Code = "CHAT_ACCOUNT_APPROVAL_STALE"
	Cancelled   Code = "CHAT_ACCOUNT_APPROVAL_CANCELLED"
	Capacity    Code = "CHAT_ACCOUNT_APPROVAL_CAPACITY"

	MaxApprovalIDs      = 1024
	MaxObservationAgeMs = uint64(5000)
	maxSafeMillis       = uint64(1<<53 - 1)
)

// Service must be retained by pointer, never copied. All state is protected by
// its dedicated injected Gate; no concrete synchronization belongs to app.
type Service struct {
	scope    port.AccountScope
	gate     port.Gate
	clock    port.AccountClock
	revision uint64
	current  *Grant
	usedIDs  map[string]struct{}
	lastNow  uint64
}

// Grant has no public constructor or mutable/exported authority fields. Even a
// value copy of a minted Grant is not the exact private grant retained by owner.
type Grant struct {
	owner    *Service
	approval port.AccountApproval
}

func New(scope port.AccountScope, gate port.Gate, clock port.AccountClock) (*Service, error) {
	if !validScope(scope) || gate == nil || clock == nil {
		return nil, Invalid
	}
	return &Service{scope: scope, gate: gate, clock: clock, usedIDs: make(map[string]struct{})}, nil
}

func validID(value string) bool {
	if len(value) == 0 || len(value) > 120 || !utf8.ValidString(value) {
		return false
	}
	for _, ch := range value {
		if ch <= 32 || unicode.IsControl(ch) {
			return false
		}
	}
	return true
}

func validScope(scope port.AccountScope) bool {
	return validID(scope.ProfileID) && validID(scope.BackendGeneration) && validID(scope.OwnerID) && validID(scope.SessionID)
}

func (s *Service) ready(ctx context.Context) error {
	if s == nil || s.gate == nil || s.clock == nil || s.usedIDs == nil || ctx == nil {
		return Invalid
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}

// fresh samples a high-water clock; subtraction is safe only after ordering and
// safe-integer checks. Rollback is refused, including between callback samples.
// Failed observations may advance the clock watermark, never approval state.
func (s *Service) fresh(observation port.AccountObservation) error {
	switch observation.State {
	case "unknown":
		return Unavailable
	case "observed":
	default:
		return Invalid
	}
	if observation.Source != "provider-session-v1" || len(observation.PrincipalKey) != 64 || strings.IndexFunc(observation.PrincipalKey, func(ch rune) bool {
		return !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))
	}) >= 0 || observation.ObservedAtMillis == 0 || observation.ObservedAtMillis > maxSafeMillis || observation.ExpiresAtMillis > maxSafeMillis || observation.ExpiresAtMillis <= observation.ObservedAtMillis {
		return Invalid
	}
	now := s.clock.NowMillis()
	if now == 0 || now > maxSafeMillis || now < s.lastNow {
		return Stale
	}
	s.lastNow = now
	if now < observation.ObservedAtMillis || now >= observation.ExpiresAtMillis || now-observation.ObservedAtMillis > MaxObservationAgeMs {
		return Stale
	}
	return nil
}

// Approve is called ONLY by trusted composition after actual explicit owner
// selection. Each success replaces the current approval with a fresh private
// Grant. A used ID is never evicted/reused, including after withdrawal.
func (s *Service) Approve(ctx context.Context, approvalID string, expectedRevision uint64, observation port.AccountObservation) (*Grant, error) {
	if s == nil || s.gate == nil {
		return nil, Invalid
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if expectedRevision != s.revision {
		return nil, Mismatch
	}
	if !validID(approvalID) {
		return nil, Invalid
	}
	if _, used := s.usedIDs[approvalID]; used {
		return nil, Mismatch
	}
	// Reserve one revision for withdrawal even at the uint64 boundary. The
	// lifetime ID bound makes that boundary unreachable through this public API.
	if len(s.usedIDs) >= MaxApprovalIDs || s.revision >= ^uint64(0)-1 {
		return nil, Capacity
	}
	if err := s.fresh(observation); err != nil {
		return nil, err
	}
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	s.revision++
	g := &Grant{owner: s, approval: port.AccountApproval{Scope: s.scope, ApprovalID: approvalID, Revision: s.revision, PrincipalKey: observation.PrincipalKey}}
	s.usedIDs[approvalID] = struct{}{}
	s.current = g
	return g, nil
}

// Revoke always permits withdrawal at ID capacity and without consulting time.
// A no-op still checks CAS. No observation failure invents this owner decision.
func (s *Service) Revoke(ctx context.Context, expectedRevision uint64) (uint64, error) {
	if s == nil || s.gate == nil {
		return 0, Invalid
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if err := s.ready(ctx); err != nil {
		return 0, err
	}
	if expectedRevision != s.revision {
		return 0, Mismatch
	}
	if s.current != nil {
		s.current = nil
		s.revision++
	}
	return s.revision, nil
}

func (s *Service) Revision(ctx context.Context) (uint64, error) {
	if s == nil || s.gate == nil {
		return 0, Invalid
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if err := s.ready(ctx); err != nil {
		return 0, err
	}
	return s.revision, nil
}

func (g *Grant) current(scope port.AccountScope, approvalID string) error {
	s := g.owner
	if s.current != g || s.revision != g.approval.Revision {
		return Stale
	}
	if scope != s.scope || scope != g.approval.Scope || approvalID != g.approval.ApprovalID {
		return Mismatch
	}
	return nil
}

// WithCurrent checks the exact private Grant under the same owner's Gate. Caller
// supplies an independently pinned scope and selected ID, and fresh independently
// observed principal. inspect receives a value, runs synchronously without IO,
// and MUST NOT reenter this owner. Trusted composition may enter the exact
// Chat send guard in its declared Computer -> activation -> account -> Chat order;
// it must not reacquire an earlier gate. This cannot attest later provider work.
// Callback errors are classified, never disclose callback/input content, and
// imply no success. Recheck cancellation/current/time even after callback failure.
func (g *Grant) WithCurrent(ctx context.Context, scope port.AccountScope, approvalID string, observation port.AccountObservation, inspect func(port.AccountApproval) error) error {
	if g == nil || g.owner == nil || g.owner.gate == nil || ctx == nil || inspect == nil || !validScope(scope) || !validID(approvalID) {
		return Invalid
	}
	s := g.owner
	s.gate.Lock()
	defer s.gate.Unlock()
	if err := s.ready(ctx); err != nil {
		return err
	}
	if err := g.current(scope, approvalID); err != nil {
		return err
	}
	if err := s.fresh(observation); err != nil {
		return err
	}
	if observation.PrincipalKey != g.approval.PrincipalKey {
		return Mismatch
	}
	if err := s.ready(ctx); err != nil {
		return err
	}
	callbackErr := inspect(g.approval)
	if err := s.ready(ctx); err != nil {
		return err
	}
	if err := g.current(scope, approvalID); err != nil {
		return err
	}
	if err := s.fresh(observation); err != nil {
		return err
	}
	if err := s.ready(ctx); err != nil {
		return err
	}
	if callbackErr != nil {
		return Unavailable
	}
	return nil
}
