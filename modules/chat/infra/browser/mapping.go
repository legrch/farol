package browser

import "github.com/legrch/farol/modules/chat/app/port"

func identityFromPort(v port.RequestIdentity) Identity {
	return Identity{ProfileID: v.ProfileID, OwnerID: v.OwnerID, SessionID: v.SessionID, TaskID: v.TaskID, TurnID: v.TurnID, OperationID: v.OperationID, TurnGeneration: v.TurnGeneration}
}
func identityToPort(v Identity) port.RequestIdentity {
	return port.RequestIdentity{ProfileID: v.ProfileID, OwnerID: v.OwnerID, SessionID: v.SessionID, TaskID: v.TaskID, TurnID: v.TurnID, OperationID: v.OperationID, TurnGeneration: v.TurnGeneration}
}
func selectionFromPort(v port.Selection) Selection {
	return Selection{Provider: v.Provider, Alias: v.Alias, AccountID: v.AccountID, ModelID: v.ModelID, Effort: v.Effort, Mode: v.Mode, ToolsEnabled: v.ToolsEnabled, ConnectorID: v.ConnectorID, ConnectorGrantID: v.ConnectorGrantID}
}
func selectionToPort(v Selection) port.Selection {
	return port.Selection{Provider: v.Provider, Alias: v.Alias, AccountID: v.AccountID, ModelID: v.ModelID, Effort: v.Effort, Mode: v.Mode, ToolsEnabled: v.ToolsEnabled, ConnectorID: v.ConnectorID, ConnectorGrantID: v.ConnectorGrantID}
}
func leaseFromPort(v port.BrowserLease) Lease {
	return Lease{Identity: identityFromPort(v.Identity), BackendGeneration: v.BackendGeneration, SlotOrdinal: v.SlotOrdinal, SlotGeneration: v.SlotGeneration}
}
func bindingFromPort(v port.BrowserBinding) Binding {
	return Binding{Lease: leaseFromPort(v.Lease), ViewID: v.ViewID, ViewGeneration: v.ViewGeneration, DocumentGeneration: v.DocumentGeneration, ConversationID: v.ConversationID}
}
func resolutionFromPort(v port.ModelResolution) Resolution {
	return Resolution{RequestedAlias: v.RequestedAlias, RequestedExecutor: v.RequestedExecutor, RequestedEffort: v.RequestedEffort, RequestedMode: v.RequestedMode, Resolved: selectionFromPort(v.Resolved), ConfigSHA256: v.ConfigSHA256, TranslationID: v.TranslationID}
}
func verificationFromPort(v port.SendVerification) Verification {
	return Verification{Binding: bindingFromPort(v.Binding), Observed: selectionFromPort(v.Observed), PreviousUserTurnID: v.PreviousUserTurnID, PreviousReplyID: v.PreviousReplyID, IntentDigest: v.IntentDigest, EvidenceID: v.EvidenceID}
}
func leaseToPort(v Lease) port.BrowserLease {
	return port.BrowserLease{Identity: identityToPort(v.Identity), BackendGeneration: v.BackendGeneration, SlotOrdinal: v.SlotOrdinal, SlotGeneration: v.SlotGeneration}
}
func bindingToPort(v Binding) port.BrowserBinding {
	return port.BrowserBinding{Lease: leaseToPort(v.Lease), ViewID: v.ViewID, ViewGeneration: v.ViewGeneration, DocumentGeneration: v.DocumentGeneration, ConversationID: v.ConversationID}
}
func resolutionToPort(v Resolution) port.ModelResolution {
	return port.ModelResolution{RequestedAlias: v.RequestedAlias, RequestedExecutor: v.RequestedExecutor, RequestedEffort: v.RequestedEffort, RequestedMode: v.RequestedMode, Resolved: selectionToPort(v.Resolved), ConfigSHA256: v.ConfigSHA256, TranslationID: v.TranslationID}
}
func verificationToPort(v Verification) port.SendVerification {
	return port.SendVerification{Binding: bindingToPort(v.Binding), Observed: selectionToPort(v.Observed), PreviousUserTurnID: v.PreviousUserTurnID, PreviousReplyID: v.PreviousReplyID, IntentDigest: v.IntentDigest, EvidenceID: v.EvidenceID}
}
func targetFromPort(v port.ConversationTarget) Target {
	return Target{Mode: string(v.Mode), ConversationID: v.ConversationID, PreviousUserTurnID: v.PreviousUserTurnID, PreviousReplyID: v.PreviousReplyID, Selection: selectionFromPort(v.Selection), Resolution: resolutionFromPort(v.Resolution)}
}
