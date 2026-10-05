package lifecycle

import (
	"context"
	"encoding/json"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/stream"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// The first text serving subset has explicit bounds, with no invented usage or
// tools. A connector selection proves binding only, not a tool execution round.
const PromptBytesLimit = 8192
const OutputBytesLimit = 8192

// Conversation is minted from actual admission, never from a provider URL/ID.
// Each handle captures one logical turn; Follow returns the next owned handle.
// Earlier handles continue to read their own retained result and stream.
type Conversation struct {
	owner                  *Service
	input                  port.ConversationInput
	target                 port.ConversationTarget
	providerID             string
	handle                 *Handle
	root, previous, latest *Conversation
	sendAuthorization      port.SendAuthorization
}

var _ port.ConversationOwner = (*Conversation)(nil)

type observationKey struct{}

func (s *Service) CreateConversation(ctx context.Context, input port.ConversationInput) (*Conversation, error) {
	return s.createConversation(ctx, input, port.ConversationTarget{Mode: port.NewSaved, Required: input.Required, Selection: input.Selection, Resolution: input.Resolution}, nil)
}
func (s *Service) FollowConversation(ctx context.Context, previous *Conversation, input port.ConversationInput) (*Conversation, error) {
	if s == nil || ctx == nil || previous == nil || previous.owner != s || previous.handle == nil {
		return nil, Invalid
	}
	s.deps.Gate.Lock()
	if err := s.available(ctx); err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	h := previous.handle
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil || !followSettled(h, view) {
		s.deps.Gate.Unlock()
		return nil, Unsettled
	}
	old := h.fixed
	b := input.Binding
	if old.ProfileID != b.ProfileID || old.BackendGeneration != b.BackendGeneration || old.OwnerID != b.OwnerID || old.SessionID != b.SessionID || old.TaskID != b.TaskID || old.TaskEpoch != b.TaskEpoch || old.ParticipantID != b.ParticipantID || input.Selection != h.target.Selection || input.Required != h.target.Required || b.OperationID == old.OperationID || b.TurnID == old.TurnID || b.TurnGeneration <= old.TurnGeneration {
		s.deps.Gate.Unlock()
		return nil, Mismatch
	}
	target := port.ConversationTarget{Mode: port.OwnedSaved, Required: input.Required, ConversationID: previous.providerID, Selection: input.Selection, PreviousUserTurnID: h.output.UserID, PreviousReplyID: h.output.ReplyID, Resolution: input.Resolution}
	s.deps.Gate.Unlock()
	return s.createConversation(ctx, input, target, previous)
}

// followSettled reads prerequisites under the owning gate. Follow keeps its
// exact known successor replay; only a new admission requires the latest handle.
func followSettled(h *Handle, view turn.Snapshot) bool {
	return !h.observing && view.HasResult && view.Result.Outcome == turn.Completed && h.output.Complete && view.DeliveryAcknowledged && view.LifecycleSettled && h.releasedRevision != 0 && view.OutstandingCallID == "" && h.unresolvedCallID == ""
}

func (s *Service) createConversation(ctx context.Context, input port.ConversationInput, target port.ConversationTarget, previous *Conversation) (*Conversation, error) {
	if s == nil || ctx == nil || !target.Valid() || input.Selection != target.Selection || len(input.Prompt) == 0 || len(input.Prompt) > PromptBytesLimit || !utf8.ValidString(input.Prompt) {
		return nil, Invalid
	}
	if s.deps.IntentDigests == nil || s.deps.ResultBytesLimit < OutputBytesLimit {
		return nil, Unavailable
	}
	if _, ok := s.deps.Browser.(port.VerifiedBrowser); !ok {
		return nil, Unavailable
	}
	digest, err := s.intentDigest(input.Binding, target, input.Prompt)
	if err != nil {
		return nil, err
	}
	s.deps.Gate.Lock()
	if err := s.available(ctx); err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	if h := s.handles[input.Binding.OperationID]; h != nil {
		if h.fixed != input.Binding || h.digest != digest || h.target != target || h.conversation == nil {
			s.deps.Gate.Unlock()
			return nil, turn.Conflict
		}
		c := h.conversation
		s.deps.Gate.Unlock()
		// Exact known replay observes the same result; it performs no new Send.
		return c, nil
	}
	s.deps.Gate.Unlock()
	c := &Conversation{owner: s, input: input, target: target, previous: previous}
	if previous == nil {
		c.root = c
	} else {
		c.root = previous.root
		// Follow retains the original disclosure guard; a new turn cannot silently
		// shed Computer/account authority captured when this conversation began.
		c.sendAuthorization = previous.sendAuthorization
	}
	h, err := s.admit(ctx, input.Binding, digest, c)
	if err != nil {
		return nil, err
	}
	_, err = s.Apply(ctx, h, Change{Action: Enqueue})
	if err != nil {
		return c, err
	}
	return c, nil
}
func (s *Service) intentDigest(binding port.TurnBinding, target port.ConversationTarget, prompt string) (string, error) {
	if s.deps.IntentDigests == nil {
		return "", Unavailable
	}
	bytes, err := json.Marshal(struct {
		Version int
		Binding port.TurnBinding
		Target  port.ConversationTarget
		Prompt  string
	}{1, binding, target, prompt})
	if err != nil {
		return "", Invalid
	}
	digest, err := s.deps.IntentDigests.Digest(bytes)
	if err != nil {
		return "", Invalid
	}
	return digest, nil
}
func (c *Conversation) Send(ctx context.Context, deadline uint64) error {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	if err := s.available(ctx); err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	if h.observing {
		s.deps.Gate.Unlock()
		return Busy
	}
	prompt := h.prompt
	if prompt == "" {
		s.deps.Gate.Unlock()
		return turn.Transition
	}
	h.observing = true
	s.deps.Gate.Unlock()
	defer func() { s.deps.Gate.Lock(); h.observing = false; s.deps.Gate.Unlock() }()
	view, err := s.Send(context.WithValue(ctx, observationKey{}, h), h, prompt, deadline, h.fixed.OperationID)
	if err != nil {
		return err
	}
	if view.HasResult {
		s.deps.Gate.Lock()
		defer s.deps.Gate.Unlock()
		frames := h.frames.Clone()
		if err := failureFrames(h, view.Result.Code, frames); err != nil {
			s.unknown = true
			return Unsettled
		}
		h.frames = frames
	}
	return nil
}
func (c *Conversation) Cancel(ctx context.Context) error {
	if c == nil || c.owner == nil || c.handle == nil {
		return Invalid
	}
	_, err := c.owner.Cancel(ctx, c.handle, c.handle.fixed.OperationID)
	return err
}

// WithConversation exposes only content-free live state under the owning gate.
// Callbacks cannot perform IO/mutation/reentry or mint admission.
func (c *Conversation) WithConversation(ctx context.Context, inspect func(port.ConversationState) error) error {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil || inspect == nil {
		return Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err := s.settlementAvailable(ctx); err != nil {
		return err
	}
	if h.observing {
		return Busy
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil {
		return err
	}
	if err := inspect(port.ConversationState{
		Binding: h.fixed, ProviderConversationID: c.providerID, Requested: h.target.Selection,
		Prepared: view.Bound && h.releasedRevision == 0, Phase: string(view.Phase), Evidence: selectionEvidence(h),
		HasResult:            view.HasResult,
		DeliveryAcknowledged: view.DeliveryAcknowledged, LifecycleSettled: view.LifecycleSettled,
		Released:    h.releasedRevision != 0,
		FollowReady: !s.frozen && c.root != nil && c.root.latest == c && followSettled(h, view),
	}); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return Cancelled
	}
	return nil
}
func (c *Conversation) Result(ctx context.Context) (*port.ConversationResult, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return nil, Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err := s.settlementAvailable(ctx); err != nil {
		return nil, err
	}
	if h.observing {
		return nil, Busy
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	if err != nil {
		return nil, err
	}
	if !view.HasResult {
		return nil, Unsettled
	}
	return &port.ConversationResult{Binding: h.fixed, ProviderConversationID: c.providerID, ProviderUserTurnID: h.output.UserID, ProviderReplyID: h.output.ReplyID, ResultID: view.Result.ID, Requested: h.target.Selection, Observed: h.verification.Observed.Projection(), Text: h.output.Text(), Evidence: selectionEvidence(h), Phase: string(view.Phase), Outcome: string(view.Result.Outcome), Code: view.Result.Code, Complete: view.Result.Outcome == turn.Completed && h.output.Complete, Acknowledged: view.DeliveryAcknowledged}, nil
}
func (c *Conversation) Acknowledge(ctx context.Context, resultID string) error {
	if c == nil || c.owner == nil || c.handle == nil {
		return Invalid
	}
	s, h := c.owner, c.handle
	view, err := s.Apply(ctx, h, Change{Action: Acknowledge, ResultID: resultID})
	if err != nil {
		return err
	}
	return s.releaseIfReady(ctx, h, *view)
}
func (s *Service) releaseIfReady(ctx context.Context, h *Handle, view turn.Snapshot) error {
	if !view.DeliveryAcknowledged || !view.LifecycleSettled || view.Result.Outcome == turn.UnknownOutcome {
		return nil
	}
	s.deps.Gate.Lock()
	released := h.releasedRevision != 0
	s.deps.Gate.Unlock()
	if released {
		return nil
	}
	_, err := s.Apply(ctx, h, Change{Action: Release, Reservation: view.Reservation})
	return err
}

// Events and FrameAcknowledgement use the owning handle's exact scope; socket
// success/disconnect and result reads do not acknowledge business delivery.
func (c *Conversation) Events(ctx context.Context, after uint64) ([]stream.Frame, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return nil, Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err := s.settlementAvailable(ctx); err != nil {
		return nil, err
	}
	return h.frames.After(streamScope(h.fixed), after)
}
func (c *Conversation) AcknowledgeFrame(ctx context.Context, sequence uint64) (stream.AckStatus, error) {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return "", Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if err := s.settlementAvailable(ctx); err != nil {
		return "", err
	}
	if h.observing {
		return "", Busy
	}
	return h.frames.Acknowledge(streamScope(h.fixed), sequence)
}
func streamScope(b port.TurnBinding) stream.Scope {
	return stream.Scope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TurnID: b.TurnID, TurnGeneration: b.TurnGeneration}
}

// Resume records an explicit owner action; it does not infer readiness or Send.
// The next explicit Send still requires fresh observed selection evidence.
func (c *Conversation) Resume(ctx context.Context) error {
	if c == nil || c.owner == nil || c.handle == nil || ctx == nil {
		return Invalid
	}
	s, h := c.owner, c.handle
	s.deps.Gate.Lock()
	if err := s.settlementAvailable(ctx); err != nil {
		s.deps.Gate.Unlock()
		return err
	}
	view, err := s.queue.Snapshot(identity(h.fixed))
	s.deps.Gate.Unlock()
	if err != nil {
		return err
	}
	_, err = s.Apply(ctx, h, Change{Action: Resume, Binding: view.Binding})
	return err
}

func selectionEvidence(h *Handle) port.SelectionEvidence {
	e := port.SelectionEvidence{Requested: h.target.Selection, Resolution: h.target.Resolution, ResolutionSource: "unknown", AdmissionSource: "unknown", ObservationSource: "unknown", PinnedSource: "configured-pinned-scope", Observed: (port.SelectionFacts{}).Projection()}
	if h.target.Resolution != (port.ModelResolution{}) {
		e.ResolutionSource = "configured"
	}
	if h.verification.EvidenceID != "" {
		e.Admitted = h.target.Selection
		e.AdmissionSource = "chat-policy"
		e.Observed = h.verification.Observed.Projection()
		e.ObservationSource = "field-facts"
		e.EvidenceID = h.verification.EvidenceID
	}
	return e
}
