// Package conversation publishes the consumer facade for the actual Chat owner.
// DTOs are independent of app/domain, Desktop wire schemas and React components.
package conversation

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/output"
	"github.com/legrch/farol/modules/chat/domain/stream"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

type Binding struct {
	ProfileID, BackendGeneration, OwnerID, SessionID, TaskID string
	TaskEpoch                                                uint64
	ParticipantID, TurnID, OperationID                       string
	TurnGeneration                                           uint64
}
type Selection struct {
	Provider, Alias, AccountID, ModelID, Effort string
	Mode                                        string
	ToolsEnabled                                bool
	ConnectorID, ConnectorGrantID               string
}
type Input struct {
	Binding    Binding
	Selection  Selection
	Resolution ModelResolution
	Prompt     string
}
type Prepared struct {
	Binding                            Binding
	SlotOrdinal                        uint8
	SlotGeneration                     uint64
	ViewID                             string
	ViewGeneration, DocumentGeneration uint64
	ConversationID                     string
}
type State struct {
	Binding        Binding
	ConversationID string
	Requested      Selection
	Evidence       SelectionEvidence
	Prepared       bool
	Phase          string
}
type Result struct {
	Binding                                       Binding
	ConversationID, UserTurnID, ReplyID, ResultID string
	Requested, Observed                           Selection
	Evidence                                      SelectionEvidence
	Phase, Outcome, Code                          string
	Text                                          string
	Complete, Acknowledged                        bool
}

// JSON is transient authorized model output. A consumer must drain/ACK frames
// separately from the initiating client's terminal delivery acknowledgement.
type Frame struct {
	Sequence uint64
	Type     string
	JSON     []byte
}
type Failure struct{ Code, Source, Retry string }

func (f *Failure) Error() string { return f.Code }
func failure(err error) error {
	if err == nil {
		return nil
	}
	code := "CHAT_CONVERSATION_UNAVAILABLE"
	var l lifecycle.Code
	var t turn.Code
	var o output.Code
	var s stream.Code
	switch {
	case errors.As(err, &l):
		code = string(l)
	case errors.As(err, &t):
		code = string(t)
	case errors.As(err, &o):
		code = string(o)
	case errors.As(err, &s):
		code = string(s)
	}
	return &Failure{Code: code, Source: "chat-conversation", Retry: "never"}
}

// Facade is captured from trusted composition of one existing lifecycle owner.
// Handle is created only by successful source admission; IDs/URLs cannot forge it.
type Facade struct{ service *lifecycle.Service }
type Handle struct {
	facade  *Facade
	current *lifecycle.Conversation
}

func New(service *lifecycle.Service) *Facade { return &Facade{service: service} }
func (f *Facade) Create(ctx context.Context, input Input) (*Handle, error) {
	if f == nil || f.service == nil {
		return nil, failure(lifecycle.Invalid)
	}
	c, err := f.service.CreateConversation(ctx, toInput(input))
	if c == nil {
		return nil, failure(err)
	}
	return &Handle{facade: f, current: c}, failure(err)
}
func (f *Facade) Follow(ctx context.Context, previous *Handle, input Input) (*Handle, error) {
	if f == nil || f.service == nil || previous == nil || previous.facade != f || previous.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	c, err := f.service.FollowConversation(ctx, previous.current, toInput(input))
	if c == nil {
		return nil, failure(err)
	}
	return &Handle{facade: f, current: c}, failure(err)
}
func (f *Facade) PrepareNext(ctx context.Context, deadline uint64) (*Prepared, error) {
	if f == nil || f.service == nil {
		return nil, failure(lifecycle.Invalid)
	}
	b, err := f.service.PrepareNext(ctx, deadline)
	if err != nil {
		return nil, failure(err)
	}
	fixed, err := f.service.PreparedOwner(ctx, *b)
	if err != nil {
		return nil, failure(err)
	}
	return &Prepared{Binding: fromBinding(fixed), SlotOrdinal: b.Lease.SlotOrdinal, SlotGeneration: b.Lease.SlotGeneration, ViewID: b.ViewID, ViewGeneration: b.ViewGeneration, DocumentGeneration: b.DocumentGeneration, ConversationID: b.ConversationID}, nil
}
func (h *Handle) Send(ctx context.Context, deadline uint64) error {
	if h == nil || h.current == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(h.current.Send(ctx, deadline))
}
func (h *Handle) Observe(ctx context.Context, deadline uint64) error {
	if h == nil || h.current == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(h.current.Observe(ctx, deadline))
}
func (h *Handle) Result(ctx context.Context) (*Result, error) {
	if h == nil || h.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	r, err := h.current.Result(ctx)
	if err != nil {
		return nil, failure(err)
	}
	return &Result{Binding: fromBinding(r.Binding), ConversationID: r.ProviderConversationID, UserTurnID: r.ProviderUserTurnID, ReplyID: r.ProviderReplyID, ResultID: r.ResultID, Requested: fromSelection(r.Requested), Observed: fromSelection(r.Observed), Text: r.Text, Evidence: fromEvidence(r.Evidence), Phase: r.Phase, Outcome: r.Outcome, Code: r.Code, Complete: r.Complete, Acknowledged: r.Acknowledged}, nil
}
func (h *Handle) WithState(ctx context.Context, inspect func(State) error) error {
	if h == nil || h.current == nil || inspect == nil {
		return failure(lifecycle.Invalid)
	}
	var inspected error
	err := h.current.WithConversation(ctx, func(s port.ConversationState) error {
		inspected = inspect(State{Binding: fromBinding(s.Binding), ConversationID: s.ProviderConversationID, Requested: fromSelection(s.Requested), Evidence: fromEvidence(s.Evidence), Prepared: s.Prepared, Phase: s.Phase})
		return inspected
	})
	if inspected != nil {
		return inspected
	}
	return failure(err)
}
func (h *Handle) Events(ctx context.Context, after uint64) ([]Frame, error) {
	if h == nil || h.current == nil {
		return nil, failure(lifecycle.Invalid)
	}
	frames, err := h.current.Events(ctx, after)
	if err != nil {
		return nil, failure(err)
	}
	out := make([]Frame, 0, len(frames))
	for _, frame := range frames {
		var event struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(frame.Data, &event) != nil {
			return nil, failure(lifecycle.Unsettled)
		}
		out = append(out, Frame{Sequence: frame.Sequence, Type: event.Type, JSON: append([]byte(nil), frame.Data...)})
	}
	return out, nil
}
func (h *Handle) Acknowledge(ctx context.Context, resultID string) error {
	if h == nil || h.current == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(h.current.Acknowledge(ctx, resultID))
}
func (h *Handle) AcknowledgeFrame(ctx context.Context, sequence uint64) (string, error) {
	if h == nil || h.current == nil {
		return "", failure(lifecycle.Invalid)
	}
	status, err := h.current.AcknowledgeFrame(ctx, sequence)
	return string(status), failure(err)
}
func toInput(i Input) port.ConversationInput {
	return port.ConversationInput{Binding: toBinding(i.Binding), Selection: toSelection(i.Selection), Resolution: toResolution(i.Resolution), Prompt: i.Prompt}
}
func toBinding(b Binding) port.TurnBinding {
	return port.TurnBinding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, OperationID: b.OperationID, TurnGeneration: b.TurnGeneration}
}
func fromBinding(b port.TurnBinding) Binding {
	return Binding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, OperationID: b.OperationID, TurnGeneration: b.TurnGeneration}
}
func toSelection(s Selection) port.Selection {
	return port.Selection{Provider: s.Provider, Alias: s.Alias, AccountID: s.AccountID, ModelID: s.ModelID, Effort: s.Effort, Mode: s.Mode, ToolsEnabled: s.ToolsEnabled, ConnectorID: s.ConnectorID, ConnectorGrantID: s.ConnectorGrantID}
}
func fromSelection(s port.Selection) Selection {
	return Selection{Provider: s.Provider, Alias: s.Alias, AccountID: s.AccountID, ModelID: s.ModelID, Effort: s.Effort, Mode: s.Mode, ToolsEnabled: s.ToolsEnabled, ConnectorID: s.ConnectorID, ConnectorGrantID: s.ConnectorGrantID}
}

func (h *Handle) Cancel(ctx context.Context) error {
	if h == nil || h.current == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(h.current.Cancel(ctx))
}

func (h *Handle) Resume(ctx context.Context) error {
	if h == nil || h.current == nil {
		return failure(lifecycle.Invalid)
	}
	return failure(h.current.Resume(ctx))
}

type ModelResolution struct {
	RequestedAlias, RequestedExecutor, RequestedEffort, RequestedMode string
	Resolved                                                          Selection
	ConfigSHA256, TranslationID                                       string
}
type SelectionEvidence struct {
	Requested         Selection
	Resolution        ModelResolution
	ResolutionSource  string
	Admitted          Selection
	AdmissionSource   string
	Observed          Selection
	ObservationSource string
	EvidenceID        string
}

func toResolution(r ModelResolution) port.ModelResolution {
	return port.ModelResolution{RequestedAlias: r.RequestedAlias, RequestedExecutor: r.RequestedExecutor, RequestedEffort: r.RequestedEffort, RequestedMode: r.RequestedMode, Resolved: toSelection(r.Resolved), ConfigSHA256: r.ConfigSHA256, TranslationID: r.TranslationID}
}
func fromEvidence(e port.SelectionEvidence) SelectionEvidence {
	r := e.Resolution
	return SelectionEvidence{Requested: fromSelection(e.Requested), Resolution: ModelResolution{RequestedAlias: r.RequestedAlias, RequestedExecutor: r.RequestedExecutor, RequestedEffort: r.RequestedEffort, RequestedMode: r.RequestedMode, Resolved: fromSelection(r.Resolved), ConfigSHA256: r.ConfigSHA256, TranslationID: r.TranslationID}, ResolutionSource: e.ResolutionSource, Admitted: fromSelection(e.Admitted), AdmissionSource: e.AdmissionSource, Observed: fromSelection(e.Observed), ObservationSource: e.ObservationSource, EvidenceID: e.EvidenceID}
}
