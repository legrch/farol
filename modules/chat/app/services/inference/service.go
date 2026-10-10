package inference

import (
	"context"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

type Options struct {
	Clock       Clock
	Deadline    Deadline
	Digester    Digester
	Credentials Credentials
	Transport   Transport
	Authority   Authority
	Ledger      Ledger
	Publication Publication
}

// Service depends on the owning lifecycle, journal and account capabilities.
// It supplies no persistence, scheduler, OAuth UI, grants or automatic retries.
type Service struct{ options Options }

func New(o Options) (*Service, error) {
	if o.Clock == nil || o.Deadline == nil || o.Digester == nil || o.Credentials == nil || o.Transport == nil || o.Authority == nil || o.Ledger == nil || o.Publication == nil {
		return nil, Invalid
	}
	return &Service{options: o}, nil
}

func (s *Service) currentTime(b Binding, last *uint64) bool {
	now := s.options.Clock.NowMillis()
	if now == 0 || now < *last || now >= b.DeadlineMillis {
		return false
	}
	*last = now
	return true
}

func (s *Service) usable(ctx context.Context, b Binding, last *uint64) error {
	if ctx == nil || ctx.Err() != nil {
		return Cancelled
	}
	if !s.currentTime(b, last) {
		return Cancelled
	}
	return s.options.Authority.WithCurrent(ctx, b, func() error { return nil })
}

func validBinding(b Binding) bool {
	return identifier(b.OperationID) && identifier(b.ProfileID) && identifier(b.BackendGeneration) && identifier(b.OwnerID) && identifier(b.SessionID) && ValidSelection(b.Selection) && identifier(b.Context.CheckpointID) && digestValue(b.Context.InputHash) && b.Context.TokenLimit > 0 && b.Context.EstimatedTokens <= b.Context.TokenLimit && b.DeadlineMillis > 0
}

func HasInferenceScopes(c Credential) bool {
	if len(c.RequestedScopes) > 64 || len(c.GrantedScopes) > 64 {
		return false
	}
	granted := make(map[string]bool)
	requested := make(map[string]bool)
	for _, scope := range c.GrantedScopes {
		if !identifier(scope) {
			return false
		}
		granted[scope] = true
	}
	for _, scope := range c.RequestedScopes {
		if !identifier(scope) {
			return false
		}
		requested[scope] = true
	}
	return granted["resource.invoke"] && granted["chatgpt.tokens.use.direct"] && requested["resource.invoke"] && requested["chatgpt.tokens.use.direct"]
}

func safeCredential(c Credential, b Binding, now uint64) bool {
	if c.Account != b.Selection.Account || c.Generation == 0 || c.ExpiresAtMillis <= now || len(c.AccessToken) == 0 || len(c.AccessToken) > 16<<10 || !HasInferenceScopes(c) {
		return false
	}
	for _, ch := range c.AccessToken {
		if ch <= 32 || ch >= 127 {
			return false
		}
	}
	return true
}

func metadata(o Outcome) Outcome { o.Text = ""; return o }

func (s *Service) settle(ctx context.Context, b Binding, o Outcome) Outcome {
	if err := s.options.Ledger.Settle(ctx, b, metadata(o)); err != nil {
		return Outcome{State: Unknown, RemoteState: o.State, ResponseID: o.ResponseID, Code: PersistenceUnknown}
	}
	return o
}

// Infer reserves exactly the original operation before any outbound inference.
// Lost reservation, transport or settlement never produces a second request.
// Text is buffered until a successful terminal and final current publication.
func (s *Service) Infer(ctx context.Context, b Binding, input []InputItem) Outcome {
	if s == nil || !validBinding(b) {
		return Outcome{State: NotSent, Code: Invalid}
	}
	if ctx == nil {
		return Outcome{State: NotSent, Code: Cancelled}
	}
	bounded, cancel, err := s.options.Deadline.Limit(ctx, b.DeadlineMillis)
	if err != nil || bounded == nil || cancel == nil {
		if cancel != nil {
			cancel()
		}
		return Outcome{State: NotSent, Code: Cancelled}
	}
	defer cancel()
	ctx = bounded
	var last uint64
	r := Request{Model: b.Selection.Model, Input: append([]InputItem(nil), input...), DeadlineMillis: b.DeadlineMillis}
	if ValidateRequest(r) != nil {
		return Outcome{State: NotSent, Code: Invalid}
	}
	hash, err := InputHash(s.options.Digester, r.Input)
	if err != nil || hash != b.Context.InputHash {
		return Outcome{State: NotSent, Code: Invalid}
	}
	if err := s.usable(ctx, b, &last); err != nil {
		return Outcome{State: NotSent, Code: Withdrawn}
	}
	preflight := r
	preflight.Input = append([]InputItem(nil), r.Input...)
	if s.options.Transport.Preflight(preflight) != nil {
		return Outcome{State: NotSent, Code: Invalid}
	}
	raw, err := json.Marshal(struct {
		Binding Binding
		Request Request
	}{b, r})
	if err != nil {
		return Outcome{State: NotSent, Code: Invalid}
	}
	intent, err := s.options.Digester.Digest(raw)
	if err != nil || !digestValue(intent) {
		return Outcome{State: NotSent, Code: Invalid}
	}
	// Validation and digest ports cannot extend the original lifetime or replace
	// its authority. Recheck immediately before the first journal/secret IO.
	if s.usable(ctx, b, &last) != nil {
		return Outcome{State: NotSent, Code: Withdrawn}
	}
	reserved, err := s.options.Ledger.Reserve(ctx, b, intent)
	if err != nil {
		return Outcome{State: Unknown, RemoteState: NotSent, Code: PersistenceUnknown}
	}
	if !reserved {
		return Outcome{State: NotSent, Code: AlreadyReserved}
	}
	if s.usable(ctx, b, &last) != nil {
		return s.settle(ctx, b, Outcome{State: NotSent, Code: Withdrawn})
	}
	c, err := s.options.Credentials.Acquire(ctx, b.Selection)
	if err != nil {
		code := CredentialUnavailable
		for _, known := range []Code{CredentialRefreshUnknown, ScopeMissing, Withdrawn, Cancelled} {
			if errors.Is(err, known) {
				code = known
				break
			}
		}
		return s.settle(ctx, b, Outcome{State: NotSent, Code: code})
	}
	if !HasInferenceScopes(c) {
		return s.settle(ctx, b, Outcome{State: NotSent, Code: ScopeMissing})
	}
	if !s.currentTime(b, &last) || !safeCredential(c, b, last) {
		return s.settle(ctx, b, Outcome{State: NotSent, Code: CredentialUnavailable})
	}
	if s.usable(ctx, b, &last) != nil {
		return s.settle(ctx, b, Outcome{State: NotSent, Code: Withdrawn})
	}
	o := s.options.Transport.Infer(ctx, c, r)
	if !validOutcome(o) {
		o = Outcome{State: Unknown, Code: "INFERENCE_PROVIDER_PROTOCOL"}
	}
	if o.State != Completed {
		o.Text = ""
		return metadata(s.settle(ctx, b, o))
	}
	// Record the original remote completion even when delivery is withdrawn.
	if s.usable(ctx, b, &last) != nil {
		settled := s.settle(ctx, b, metadata(o))
		if settled.State == Unknown {
			return settled
		}
		return Outcome{State: Suppressed, RemoteState: Completed, ResponseID: o.ResponseID, Code: Withdrawn}
	}
	settled := s.settle(ctx, b, o)
	if settled.State != Completed {
		return metadata(settled)
	}
	if s.usable(ctx, b, &last) != nil {
		return Outcome{State: Suppressed, RemoteState: Completed, ResponseID: o.ResponseID, Code: Withdrawn}
	}
	publicationEntered := false
	err = s.options.Authority.WithCurrent(ctx, b, func() error {
		if ctx.Err() != nil || !s.currentTime(b, &last) {
			return Cancelled
		}
		publicationEntered = true
		return s.options.Publication.Publish(b, o)
	})
	if err != nil {
		if publicationEntered {
			return Outcome{State: Unknown, RemoteState: Completed, ResponseID: o.ResponseID, Code: PublicationUnknown}
		}
		return Outcome{State: Suppressed, RemoteState: Completed, ResponseID: o.ResponseID, Code: Withdrawn}
	}
	return o
}

func validOutcome(o Outcome) bool {
	if o.RemoteState != "" {
		return false
	}
	switch o.State {
	case NotSent, Unknown, Failed:
		return len(o.Text) == 0 && safeOutcomeCode(o.Code) && (o.ResponseID == "" || identifier(o.ResponseID))
	case Completed:
		return identifier(o.ResponseID) && o.Code == "" && len(o.Text) <= MaxOutputBytes && utf8.ValidString(o.Text)
	default:
		return false
	}
}

func safeOutcomeCode(c Code) bool {
	switch c {
	case Invalid, Withdrawn, CredentialUnavailable, ScopeMissing, Cancelled,
		"INFERENCE_HTTP_REJECTED", "INFERENCE_MODEL_DENIED", "INFERENCE_USAGE_LIMITED",
		"INFERENCE_CREDENTIAL_REJECTED", "INFERENCE_TRANSPORT_UNKNOWN", "INFERENCE_STREAM_INVALID",
		"INFERENCE_STREAM_LIMIT", "INFERENCE_STREAM_INCOMPLETE", "INFERENCE_PROVIDER_FAILED", "INFERENCE_PROVIDER_REFUSED":
		return true
	}
	return false
}
