package boot

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type chatHandle struct {
	id           string
	binding      conversation.Binding
	handle       *conversation.Handle
	beforeSend   func(context.Context) error
	accountOwner *accountapproval.Service
}

func (h chatHandle) send(ctx context.Context, deadline uint64) error {
	if h.beforeSend != nil {
		if err := h.beforeSend(ctx); err != nil {
			return err
		}
	}
	return h.handle.Send(ctx, deadline)
}

// ChatIngress binds a trusted inherited desktop pipe to the existing Chat owner.
// This map contains opaque facade handles only: no queue, output, retry policy,
// admission restoration, provider state or independent task engine.
type ChatIngress struct {
	mu           sync.Mutex
	facade       *conversation.Facade
	peer         wire.Context
	owner        string
	handles      map[string]chatHandle
	used         map[string]bool
	caller       *chatCallerIngress
	accountClock chatport.AccountClock
	// One ledger slot per admitted account is unavailable to ordinary creation.
	// All successor handles share this one-shot withdrawal reservation.
	withdrawals map[*accountapproval.Service]bool
}

func NewChatIngress(facade *conversation.Facade, peer wire.Context, owner string) (*ChatIngress, error) {
	if facade == nil || validateIngress("Context", peer) != nil || !validIngressID(owner) {
		return nil, errors.New("chat_ingress_invalid")
	}
	ingress := &ChatIngress{facade: facade, peer: peer, owner: owner, handles: make(map[string]chatHandle), used: make(map[string]bool), withdrawals: make(map[*accountapproval.Service]bool)}
	ingress.caller = newChatCallerIngress(ingress)
	return ingress, nil
}
func (s *ChatIngress) create(ctx context.Context, operation string, input wire.ChatCreate) (*wire.ChatHandle, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.claimChatOperation(ctx, operation); err != nil {
		return nil, err
	}
	return s.createLocked(ctx, operation, input, nil)
}

// Caller holds mu. The same operation ledger covers ordinary and authorized
// creation; a late or lost admission result cannot mint replacement work.
func (s *ChatIngress) claimChatOperation(ctx context.Context, operation string) error {
	return s.claimChatOperationCapacity(ctx, operation, 0)
}

func (s *ChatIngress) claimChatOperationCapacity(ctx context.Context, operation string, reserve int) error {
	if ctx == nil || !validIngressID(operation) || s.used[operation] || len(s.used)+len(s.withdrawals)+reserve >= 1024 || ctx.Err() != nil {
		return errors.New("chat_ingress_refused")
	}
	s.used[operation] = true
	return nil
}

func (s *ChatIngress) createLocked(ctx context.Context, operation string, input wire.ChatCreate, account *chatStartAccount) (*wire.ChatHandle, error) {
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	task, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	turn, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	// A participant belongs to this admitted task, not to the owner account.
	// Follow below preserves it with TaskID; a new conversation must not collide
	// with another task when Computer records the captured admission.
	participant, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	binding := conversation.Binding{ProfileID: s.peer.ProfileId, BackendGeneration: s.peer.BackendGeneration, OwnerID: s.owner, SessionID: input.SessionId, TaskID: task, TaskEpoch: 1, ParticipantID: participant, TurnID: turn, OperationID: operation, TurnGeneration: 1}
	var previous *conversation.Handle
	var accountOwner *accountapproval.Service
	if input.PreviousHandle != nil {
		if account != nil {
			return nil, errors.New("chat_previous_account_refused")
		}
		old, ok := s.handles[*input.PreviousHandle]
		if !ok || old.binding.SessionID != input.SessionId || old.binding.TurnGeneration == math.MaxUint64 {
			return nil, errors.New("chat_previous_handle_refused")
		}
		binding = old.binding
		binding.TurnID = turn
		binding.OperationID = operation
		binding.TurnGeneration++
		previous = old.handle
		accountOwner = old.accountOwner
	}
	in := conversation.Input{Required: conversation.RequiredControls{Model: input.Required.Model, Effort: input.Required.Effort, Mode: input.Required.Mode, Connector: input.Required.Connector}, Binding: binding, Selection: chatSelection(input.Selection), Resolution: chatResolution(input.Resolution), Prompt: input.Prompt}
	var handle *conversation.Handle
	if previous == nil {
		if account == nil {
			handle, err = s.facade.Create(ctx, in)
		} else {
			authorization, e := newChatAccountAuthorization(&account.captured, binding, in.Selection.AccountID)
			if e != nil {
				return nil, e
			}
			accountOwner = account.owner
			handle, err = s.facade.CreateAuthorized(ctx, in, authorization.Authorize)
		}
	} else {
		handle, err = s.facade.Follow(ctx, previous, in)
	}
	if handle != nil {
		s.handles[id] = chatHandle{id: id, binding: binding, handle: handle, accountOwner: accountOwner}
	}
	if err != nil {
		return nil, err
	}
	if handle == nil {
		return nil, errors.New("chat_admission_unknown")
	}
	out := chatWireHandle(s.handles[id])
	return &out, nil
}
func (s *ChatIngress) get(id string) (chatHandle, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h, ok := s.handles[id]
	if !ok {
		return chatHandle{}, errors.New("chat_handle_refused")
	}
	return h, nil
}
func chatSelection(s wire.BrowserSelection) conversation.Selection {
	return conversation.Selection{Provider: s.Provider, Alias: s.Alias, AccountID: s.AccountId, ModelID: s.ModelId, Effort: s.Effort, Mode: s.Mode, ToolsEnabled: s.ToolsEnabled, ConnectorID: s.ConnectorId, ConnectorGrantID: s.ConnectorGrantId}
}
func chatResolution(s wire.BrowserResolution) conversation.ModelResolution {
	return conversation.ModelResolution{RequestedAlias: s.RequestedAlias, RequestedExecutor: s.RequestedExecutor, RequestedEffort: s.RequestedEffort, RequestedMode: s.RequestedMode, Resolved: chatSelection(s.Resolved), ConfigSHA256: s.ConfigSHA256, TranslationID: s.TranslationId}
}
func chatWireSelection(s conversation.Selection) wire.BrowserSelection {
	return wire.BrowserSelection{Provider: s.Provider, Alias: s.Alias, AccountId: s.AccountID, ModelId: s.ModelID, Effort: s.Effort, Mode: s.Mode, ToolsEnabled: s.ToolsEnabled, ConnectorId: s.ConnectorID, ConnectorGrantId: s.ConnectorGrantID}
}
func decimal(v uint64) string { return strconv.FormatUint(v, 10) }
func chatWireBinding(b conversation.Binding) wire.ChatTurnBinding {
	return wire.ChatTurnBinding{ProfileId: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerId: b.OwnerID, SessionId: b.SessionID, TaskId: b.TaskID, TaskEpoch: decimal(b.TaskEpoch), ParticipantId: b.ParticipantID, TurnId: b.TurnID, OperationId: b.OperationID, TurnGeneration: decimal(b.TurnGeneration)}
}
func chatWireHandle(h chatHandle) wire.ChatHandle {
	return wire.ChatHandle{HandleId: h.id, Binding: chatWireBinding(h.binding)}
}
func chatWireEvidence(e conversation.SelectionEvidence) wire.ChatSelectionEvidence {
	r := e.Resolution
	out := wire.ChatSelectionEvidence{PinnedSource: e.PinnedSource, Requested: chatWireSelection(e.Requested), Resolution: wire.BrowserResolution{RequestedAlias: r.RequestedAlias, RequestedExecutor: r.RequestedExecutor, RequestedEffort: r.RequestedEffort, RequestedMode: r.RequestedMode, Resolved: chatWireSelection(r.Resolved), ConfigSHA256: r.ConfigSHA256, TranslationId: r.TranslationID}, ResolutionSource: e.ResolutionSource, AdmissionSource: e.AdmissionSource, ObservationSource: e.ObservationSource, EvidenceId: e.EvidenceID}
	if e.AdmissionSource != "unknown" {
		v := chatWireSelection(e.Admitted)
		out.Admitted = &v
	}
	if e.ObservationSource != "unknown" {
		v := chatWireFacts(e.Observed)
		out.Observed = &v
	}
	return out
}
func chatDecode(shape string, r desktop.Request, v any) error {
	if ipc.ValidateJSON(r.Body) != nil || wire.Validate(shape, r.Body) != nil {
		return errors.New("chat_request_invalid")
	}
	return json.Unmarshal(r.Body, v)
}
func chatOutcome(shape string, value any, err error) (*desktop.Outcome, error) {
	if err != nil {
		return nil, err
	} // conservative unknown; never reinterpret an uncertain effect as not sent
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if wire.Validate(shape, raw) != nil {
		return nil, errors.New("chat_response_invalid")
	}
	return &desktop.Outcome{Status: "ok", Data: raw}, nil
}
func (s *ChatIngress) Methods() map[string]desktop.Method {
	methods := s.caller.Methods()
	for name, method := range s.startMethods() {
		methods[name] = method
	}
	methods["chat.conversation.state"] = desktop.Method{Handle: s.conversationState}
	methods["chat.conversation.create"] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatCreate
		if r.OperationID == "" || chatDecode("ChatCreate", r, &in) != nil {
			return invalidIngress()
		}
		v, e := s.create(ctx, r.OperationID, in)
		return chatOutcome("ChatHandle", v, e)
	}}
	methods["chat.conversation.prepare"] = desktop.Method{Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatDeadline
		if r.OperationID == "" || chatDecode("ChatDeadline", r, &in) != nil {
			return invalidIngress()
		}
		if _, e := boundedBrowserDeadline(wireUint(in.DeadlineMillis)); e != nil {
			return invalidIngress()
		}
		p, e := s.facade.PrepareNext(ctx, wireUint(in.DeadlineMillis))
		if e != nil {
			// Only this facade's PrepareNext capacity result is known to precede
			// reservation, journal publication and browser IO. Keep the queued
			// handles; this is not permission to replace a request or retry Send.
			// Other methods and every uncertain preparation remain unknown.
			var failure *conversation.Failure
			if p == nil && errors.As(e, &failure) && failure != nil && failure.Source == "chat-conversation" && failure.Retry == "never" && failure.Code == "CHAT_CAPACITY" {
				return &desktop.Outcome{Status: "refused", Code: failure.Code}, nil
			}
			return nil, e
		}
		s.mu.Lock()
		var h chatHandle
		for _, v := range s.handles {
			if v.binding == p.Binding {
				h = v
				break
			}
		}
		s.mu.Unlock()
		if h.handle == nil {
			return nil, errors.New("chat_prepared_owner_unknown")
		}
		return chatOutcome("ChatPrepared", wire.ChatPrepared{ProviderState: p.ProviderState, Handle: chatWireHandle(h), SlotOrdinal: uint32(p.SlotOrdinal), SlotGeneration: decimal(p.SlotGeneration), ViewId: p.ViewID, ViewGeneration: decimal(p.ViewGeneration), DocumentGeneration: decimal(p.DocumentGeneration), ConversationId: p.ConversationID}, nil)
	}}
	for _, name := range []string{"send", "observe"} {
		methods["chat.conversation."+name] = desktop.Method{Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatAction
			if r.OperationID == "" || chatDecode("ChatAction", r, &in) != nil {
				return invalidIngress()
			}
			h, e := s.get(in.HandleId)
			if e != nil {
				return invalidIngress()
			}
			if _, e := boundedBrowserDeadline(wireUint(in.DeadlineMillis)); e != nil {
				return invalidIngress()
			}
			if name == "send" {
				e = h.send(ctx, wireUint(in.DeadlineMillis))
			} else {
				e = h.handle.Observe(ctx, wireUint(in.DeadlineMillis))
			}
			return chatOutcome("Empty", wire.Empty{}, e)
		}}
	}
	// Read-only intent observation. A queued/prepared not-dispatched handle can
	// still Send later, so this result never releases an external replay guard.
	methods["chat.conversation.submission"] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatHandleRequest
		if r.OperationID != "" || chatDecode("ChatHandleRequest", r, &in) != nil {
			return invalidIngress()
		}
		h, e := s.get(in.HandleId)
		if e != nil {
			return invalidIngress()
		}
		state, e := h.handle.SubmissionState(ctx)
		return chatOutcome("ChatSubmissionState", wire.ChatSubmissionState{Handle: chatWireHandle(h), State: string(state)}, e)
	}}
	methods["chat.conversation.result"] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatHandleRequest
		if r.OperationID != "" || chatDecode("ChatHandleRequest", r, &in) != nil {
			return invalidIngress()
		}
		h, e := s.get(in.HandleId)
		if e != nil {
			return invalidIngress()
		}
		v, e := h.handle.Result(ctx)
		if e != nil {
			return nil, e
		}
		return chatOutcome("ChatResult", wire.ChatResult{Handle: chatWireHandle(h), ConversationId: v.ConversationID, UserTurnId: v.UserTurnID, ReplyId: v.ReplyID, ResultId: v.ResultID, Evidence: chatWireEvidence(v.Evidence), Phase: v.Phase, Outcome: v.Outcome, Code: v.Code, Text: v.Text, Complete: v.Complete, Acknowledged: v.Acknowledged}, nil)
	}}
	methods["chat.conversation.events"] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatEventsRequest
		if r.OperationID != "" || chatDecode("ChatEventsRequest", r, &in) != nil {
			return invalidIngress()
		}
		h, e := s.get(in.HandleId)
		if e != nil {
			return invalidIngress()
		}
		v, e := h.handle.Events(ctx, wireUint(in.AfterSequence))
		if e != nil {
			return nil, e
		}
		frames := make([]wire.ChatFrame, 0, len(v))
		for _, f := range v {
			if ipc.ValidateJSON(f.JSON) != nil {
				return nil, errors.New("chat_frame_invalid")
			}
			frames = append(frames, wire.ChatFrame{Sequence: decimal(f.Sequence), Kind: f.Type, Data: append(json.RawMessage(nil), f.JSON...)})
		}
		return chatOutcome("ChatFrames", wire.ChatFrames{Frames: frames}, nil)
	}}
	methods["chat.conversation.result.ack"] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatResultAck
		if r.OperationID == "" || chatDecode("ChatResultAck", r, &in) != nil {
			return invalidIngress()
		}
		h, e := s.get(in.HandleId)
		if e != nil {
			return invalidIngress()
		}
		return chatOutcome("Empty", wire.Empty{}, h.handle.Acknowledge(ctx, in.ResultId))
	}}
	methods["chat.conversation.frame.ack"] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		var in wire.ChatFrameAck
		if r.OperationID == "" || chatDecode("ChatFrameAck", r, &in) != nil {
			return invalidIngress()
		}
		h, e := s.get(in.HandleId)
		if e != nil {
			return invalidIngress()
		}
		v, e := h.handle.AcknowledgeFrame(ctx, wireUint(in.Sequence))
		return chatOutcome("ChatFrameAckResult", wire.ChatFrameAckResult{Status: v}, e)
	}}
	for _, name := range []string{"cancel", "resume"} {
		methods["chat.conversation."+name] = desktop.Method{Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ChatHandleRequest
			if r.OperationID == "" || chatDecode("ChatHandleRequest", r, &in) != nil {
				return invalidIngress()
			}
			h, e := s.get(in.HandleId)
			if e != nil {
				return invalidIngress()
			}
			if name == "cancel" {
				e = h.handle.Cancel(ctx)
			} else {
				e = h.handle.Resume(ctx)
			}
			return chatOutcome("Empty", wire.Empty{}, e)
		}}
	}
	return methods
}

func chatWireFacts(v conversation.SelectionFacts) wire.BrowserSelectionFacts {
	fact := func(v conversation.ControlFact) wire.BrowserControlFact {
		if v.Source == "" {
			v.Source = "unknown"
		}
		return wire.BrowserControlFact{Source: v.Source, Value: v.Value, Literal: v.Literal}
	}
	return wire.BrowserSelectionFacts{Model: fact(v.Model), Effort: fact(v.Effort), Mode: fact(v.Mode), Connector: fact(v.Connector), ObservedAtMillis: decimal(v.ObservedAtMillis)}
}
