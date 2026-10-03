package boot

import (
	"encoding/json"
	"errors"
	wire "github.com/legrch/farol/gen/desktop/v1"
	browser "github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/pkg/ipc"
	"strconv"
)

// Explicit consumer-owned value mapping. Private Chat structs never become wire
// definitions and no arbitrary method, URL, script or JSON invocation is accepted.
func toBrowserIdentity(v browser.Identity) wire.BrowserIdentity {
	return wire.BrowserIdentity{
		ProfileId:      v.ProfileID,
		OwnerId:        v.OwnerID,
		SessionId:      v.SessionID,
		TaskId:         v.TaskID,
		TurnId:         v.TurnID,
		OperationId:    v.OperationID,
		TurnGeneration: strconv.FormatUint(v.TurnGeneration, 10),
	}
}
func fromBrowserIdentity(v wire.BrowserIdentity) browser.Identity {
	return browser.Identity{
		ProfileID:      v.ProfileId,
		OwnerID:        v.OwnerId,
		SessionID:      v.SessionId,
		TaskID:         v.TaskId,
		TurnID:         v.TurnId,
		OperationID:    v.OperationId,
		TurnGeneration: wireUint(v.TurnGeneration),
	}
}
func toBrowserLease(v browser.Lease) wire.BrowserLease {
	return wire.BrowserLease{
		Identity:          toBrowserIdentity(v.Identity),
		BackendGeneration: v.BackendGeneration,
		SlotOrdinal:       uint32(v.SlotOrdinal),
		SlotGeneration:    strconv.FormatUint(v.SlotGeneration, 10),
	}
}
func fromBrowserLease(v wire.BrowserLease) browser.Lease {
	return browser.Lease{
		Identity:          fromBrowserIdentity(v.Identity),
		BackendGeneration: v.BackendGeneration,
		SlotOrdinal:       uint8(v.SlotOrdinal),
		SlotGeneration:    wireUint(v.SlotGeneration),
	}
}
func toBrowserBinding(v browser.Binding) wire.BrowserBinding {
	return wire.BrowserBinding{
		Lease:              toBrowserLease(v.Lease),
		ViewId:             v.ViewID,
		ViewGeneration:     strconv.FormatUint(v.ViewGeneration, 10),
		DocumentGeneration: strconv.FormatUint(v.DocumentGeneration, 10),
		ConversationId:     v.ConversationID,
	}
}
func fromBrowserBinding(v wire.BrowserBinding) browser.Binding {
	return browser.Binding{
		Lease:              fromBrowserLease(v.Lease),
		ViewID:             v.ViewId,
		ViewGeneration:     wireUint(v.ViewGeneration),
		DocumentGeneration: wireUint(v.DocumentGeneration),
		ConversationID:     v.ConversationId,
	}
}
func toBrowserSelection(v browser.Selection) wire.BrowserSelection {
	return wire.BrowserSelection{
		Provider:         v.Provider,
		Alias:            v.Alias,
		AccountId:        v.AccountID,
		ModelId:          v.ModelID,
		Effort:           v.Effort,
		Mode:             v.Mode,
		ToolsEnabled:     v.ToolsEnabled,
		ConnectorId:      v.ConnectorID,
		ConnectorGrantId: v.ConnectorGrantID,
	}
}
func fromBrowserSelection(v wire.BrowserSelection) browser.Selection {
	return browser.Selection{
		Provider:         v.Provider,
		Alias:            v.Alias,
		AccountID:        v.AccountId,
		ModelID:          v.ModelId,
		Effort:           v.Effort,
		Mode:             v.Mode,
		ToolsEnabled:     v.ToolsEnabled,
		ConnectorID:      v.ConnectorId,
		ConnectorGrantID: v.ConnectorGrantId,
	}
}
func toBrowserResolution(v browser.Resolution) wire.BrowserResolution {
	return wire.BrowserResolution{
		RequestedAlias:    v.RequestedAlias,
		RequestedExecutor: v.RequestedExecutor,
		RequestedEffort:   v.RequestedEffort,
		RequestedMode:     v.RequestedMode,
		ConfigSHA256:      v.ConfigSHA256,
		TranslationId:     v.TranslationID,
		Resolved:          toBrowserSelection(v.Resolved),
	}
}
func fromBrowserResolution(v wire.BrowserResolution) browser.Resolution {
	return browser.Resolution{
		RequestedAlias:    v.RequestedAlias,
		RequestedExecutor: v.RequestedExecutor,
		RequestedEffort:   v.RequestedEffort,
		RequestedMode:     v.RequestedMode,
		ConfigSHA256:      v.ConfigSHA256,
		TranslationID:     v.TranslationId,
		Resolved:          fromBrowserSelection(v.Resolved),
	}
}
func toBrowserTarget(v browser.Target) wire.BrowserTarget {
	return wire.BrowserTarget{
		Mode:               v.Mode,
		ConversationId:     v.ConversationID,
		PreviousUserTurnId: v.PreviousUserTurnID,
		PreviousReplyId:    v.PreviousReplyID,
		Selection:          toBrowserSelection(v.Selection),
		Resolution:         toBrowserResolution(v.Resolution),
	}
}
func fromBrowserTarget(v wire.BrowserTarget) browser.Target {
	return browser.Target{
		Mode:               v.Mode,
		ConversationID:     v.ConversationId,
		PreviousUserTurnID: v.PreviousUserTurnId,
		PreviousReplyID:    v.PreviousReplyId,
		Selection:          fromBrowserSelection(v.Selection),
		Resolution:         fromBrowserResolution(v.Resolution),
	}
}
func toBrowserVerification(v browser.Verification) wire.BrowserVerification {
	return wire.BrowserVerification{
		Binding:            toBrowserBinding(v.Binding),
		Observed:           toBrowserSelection(v.Observed),
		PreviousUserTurnId: v.PreviousUserTurnID,
		PreviousReplyId:    v.PreviousReplyID,
		IntentDigest:       v.IntentDigest,
		EvidenceId:         v.EvidenceID,
	}
}
func fromBrowserVerification(v wire.BrowserVerification) browser.Verification {
	return browser.Verification{
		Binding:            fromBrowserBinding(v.Binding),
		Observed:           fromBrowserSelection(v.Observed),
		PreviousUserTurnID: v.PreviousUserTurnId,
		PreviousReplyID:    v.PreviousReplyId,
		IntentDigest:       v.IntentDigest,
		EvidenceID:         v.EvidenceId,
	}
}
func toBrowserObservation(v browser.Observation) wire.BrowserObservation {
	return wire.BrowserObservation{
		Binding:          toBrowserBinding(v.Binding),
		Sequence:         strconv.FormatUint(v.Sequence, 10),
		ObservedAtMillis: strconv.FormatUint(v.ObservedAtMillis, 10),
		Kind:             v.Kind,
		Text:             v.Text,
		Code:             v.Code,
		UserTurnId:       v.UserTurnID,
		ReplyId:          v.ReplyID,
		SegmentId:        v.SegmentID,
	}
}
func fromBrowserObservation(v wire.BrowserObservation) browser.Observation {
	return browser.Observation{
		Binding:          fromBrowserBinding(v.Binding),
		Sequence:         wireUint(v.Sequence),
		ObservedAtMillis: wireUint(v.ObservedAtMillis),
		Kind:             v.Kind,
		Text:             v.Text,
		Code:             v.Code,
		UserTurnID:       v.UserTurnId,
		ReplyID:          v.ReplyId,
		SegmentID:        v.SegmentId,
	}
}

// Called only after canonical decimal validation.
func wireUint(s string) uint64 { value, _ := strconv.ParseUint(s, 10, 64); return value }
func encodeBrowserCommand(command browser.Command) (string, json.RawMessage, uint64, error) {
	var kind, name string
	var value any
	var deadline uint64
	switch c := command.(type) {
	case browser.PrepareCommand:
		kind, name, deadline = "prepare", "BrowserPrepare", c.DeadlineMillis
		value = wire.BrowserPrepare{Target: toBrowserTarget(c.Target), Lease: toBrowserLease(c.Lease), DeadlineMillis: strconv.FormatUint(deadline, 10)}
	case browser.VerifySendCommand:
		kind, name, deadline = "verify-send", "BrowserVerifySend", c.DeadlineMillis
		value = wire.BrowserVerifySend{Binding: toBrowserBinding(c.Binding), Requested: toBrowserSelection(c.Requested), PreviousUserTurnId: c.PreviousUserTurnID, PreviousReplyId: c.PreviousReplyID, IntentDigest: c.IntentDigest, DeadlineMillis: strconv.FormatUint(deadline, 10)}
	case browser.SendCommand:
		kind, name, deadline = "send", "BrowserSend", c.DeadlineMillis
		value = wire.BrowserSend{Binding: toBrowserBinding(c.Binding), Verification: toBrowserVerification(c.Verification), IntentDigest: c.IntentDigest, Prompt: c.Prompt, DeadlineMillis: strconv.FormatUint(deadline, 10)}
	case browser.ObserveCommand:
		if c.Limit < 1 || c.Limit > 128 {
			return "", nil, 0, errors.New("browser_command_invalid")
		}
		kind, name, deadline = "observe", "BrowserObserve", c.DeadlineMillis
		value = wire.BrowserObserve{Binding: toBrowserBinding(c.Binding), AfterSequence: strconv.FormatUint(c.AfterSequence, 10), Limit: uint32(c.Limit), DeadlineMillis: strconv.FormatUint(deadline, 10)}
	case browser.CancelCommand:
		kind, name, deadline = "cancel", "BrowserCancel", c.DeadlineMillis
		value = wire.BrowserCancel{Binding: toBrowserBinding(c.Binding), DeadlineMillis: strconv.FormatUint(deadline, 10)}
	case browser.DisposeCommand:
		kind, name, deadline = "dispose", "BrowserDispose", c.DeadlineMillis
		value = wire.BrowserDispose{Lease: toBrowserLease(c.Lease), DeadlineMillis: strconv.FormatUint(deadline, 10)}
	default:
		return "", nil, 0, errors.New("browser_command_invalid")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", nil, 0, err
	}
	if err = wire.Validate(name, raw); err != nil {
		return "", nil, 0, err
	}
	if len(raw) > ipc.MaxFrameBytes/2 {
		return "", nil, 0, errors.New("browser_command_bound")
	}
	return kind, raw, deadline, nil
}
func decodeBrowserReply(kind string, raw json.RawMessage) (browser.Reply, error) {
	if len(raw) > ipc.MaxFrameBytes/2 || ipc.ValidateJSON(raw) != nil {
		return nil, errors.New("browser_reply_invalid")
	}
	decode := func(name string, out any) error {
		if err := wire.Validate(name, raw); err != nil {
			return err
		}
		return json.Unmarshal(raw, out)
	}
	switch kind {
	case "prepare":
		var v wire.BrowserPrepared
		if err := decode("BrowserPrepared", &v); err != nil {
			return nil, err
		}
		return browser.PreparedReply{Saved: v.Saved, Readiness: v.Readiness, Binding: fromBrowserBinding(v.Binding), Code: v.Code}, nil
	case "verify-send":
		var v wire.BrowserVerified
		if err := decode("BrowserVerified", &v); err != nil {
			return nil, err
		}
		return browser.VerifiedReply{Verification: fromBrowserVerification(v.Verification)}, nil
	case "send":
		var v wire.BrowserSent
		if err := decode("BrowserSent", &v); err != nil {
			return nil, err
		}
		return browser.SentReply{Binding: fromBrowserBinding(v.Binding), VerificationID: v.VerificationId, Status: v.Status, Code: v.Code}, nil
	case "observe":
		var v wire.BrowserObserved
		if err := decode("BrowserObserved", &v); err != nil {
			return nil, err
		}
		events := make([]browser.Observation, len(v.Events))
		for i, e := range v.Events {
			events[i] = fromBrowserObservation(e)
		}
		return browser.ObservedReply{Events: events, Gap: v.Gap}, nil
	case "cancel":
		var v wire.BrowserCancelled
		if err := decode("BrowserCancelled", &v); err != nil {
			return nil, err
		}
		return browser.CancelledReply{Binding: fromBrowserBinding(v.Binding), Status: v.Status, Code: v.Code}, nil
	case "dispose":
		var v wire.BrowserDisposed
		if err := decode("BrowserDisposed", &v); err != nil {
			return nil, err
		}
		return browser.DisposedReply{Lease: fromBrowserLease(v.Lease), Confirmed: v.Confirmed, Code: v.Code}, nil
	}
	return nil, errors.New("browser_reply_invalid")
}
