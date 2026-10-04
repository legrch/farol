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
	return Binding{ProviderState: string(v.ProviderState), Lease: leaseFromPort(v.Lease), ViewID: v.ViewID, ViewGeneration: v.ViewGeneration, DocumentGeneration: v.DocumentGeneration, ConversationID: v.ConversationID}
}
func resolutionFromPort(v port.ModelResolution) Resolution {
	return Resolution{RequestedAlias: v.RequestedAlias, RequestedExecutor: v.RequestedExecutor, RequestedEffort: v.RequestedEffort, RequestedMode: v.RequestedMode, Resolved: selectionFromPort(v.Resolved), ConfigSHA256: v.ConfigSHA256, TranslationID: v.TranslationID}
}
func verificationFromPort(v port.SendVerification) Verification {
	return Verification{Account: accountFromPort(v.Account), Binding: bindingFromPort(v.Binding), Pinned: selectionFromPort(v.Pinned), Required: requiredFromPort(v.Required), Observed: factsFromPort(v.Observed), PreviousUserTurnID: v.PreviousUserTurnID, PreviousReplyID: v.PreviousReplyID, IntentDigest: v.IntentDigest, EvidenceID: v.EvidenceID}
}
func leaseToPort(v Lease) port.BrowserLease {
	return port.BrowserLease{Identity: identityToPort(v.Identity), BackendGeneration: v.BackendGeneration, SlotOrdinal: v.SlotOrdinal, SlotGeneration: v.SlotGeneration}
}
func bindingToPort(v Binding) port.BrowserBinding {
	return port.BrowserBinding{ProviderState: port.ProviderState(v.ProviderState), Lease: leaseToPort(v.Lease), ViewID: v.ViewID, ViewGeneration: v.ViewGeneration, DocumentGeneration: v.DocumentGeneration, ConversationID: v.ConversationID}
}
func resolutionToPort(v Resolution) port.ModelResolution {
	return port.ModelResolution{RequestedAlias: v.RequestedAlias, RequestedExecutor: v.RequestedExecutor, RequestedEffort: v.RequestedEffort, RequestedMode: v.RequestedMode, Resolved: selectionToPort(v.Resolved), ConfigSHA256: v.ConfigSHA256, TranslationID: v.TranslationID}
}
func verificationToPort(v Verification) port.SendVerification {
	return port.SendVerification{Account: accountToPort(v.Account), Binding: bindingToPort(v.Binding), Pinned: selectionToPort(v.Pinned), Required: requiredToPort(v.Required), Observed: factsToPort(v.Observed), PreviousUserTurnID: v.PreviousUserTurnID, PreviousReplyID: v.PreviousReplyID, IntentDigest: v.IntentDigest, EvidenceID: v.EvidenceID}
}
func targetFromPort(v port.ConversationTarget) Target {
	return Target{Required: requiredFromPort(v.Required), Mode: string(v.Mode), ConversationID: v.ConversationID, PreviousUserTurnID: v.PreviousUserTurnID, PreviousReplyID: v.PreviousReplyID, Selection: selectionFromPort(v.Selection), Resolution: resolutionFromPort(v.Resolution)}
}

func requiredFromPort(v port.RequiredControls) RequiredControls {
	return RequiredControls{Model: v.Model, Effort: v.Effort, Mode: v.Mode, Connector: v.Connector}
}
func requiredToPort(v RequiredControls) port.RequiredControls {
	return port.RequiredControls{Model: v.Model, Effort: v.Effort, Mode: v.Mode, Connector: v.Connector}
}
func factFromPort(v port.ControlFact) ControlFact {
	return ControlFact{Value: v.Value, Literal: v.Literal, Source: string(v.Source)}
}
func factToPort(v ControlFact) port.ControlFact {
	return port.ControlFact{Value: v.Value, Literal: v.Literal, Source: port.FactSource(v.Source)}
}
func factsFromPort(v port.SelectionFacts) SelectionFacts {
	return SelectionFacts{Model: factFromPort(v.Model), Effort: factFromPort(v.Effort), Mode: factFromPort(v.Mode), Connector: factFromPort(v.Connector), ObservedAtMillis: v.ObservedAtMillis}
}
func factsToPort(v SelectionFacts) port.SelectionFacts {
	return port.SelectionFacts{Model: factToPort(v.Model), Effort: factToPort(v.Effort), Mode: factToPort(v.Mode), Connector: factToPort(v.Connector), ObservedAtMillis: v.ObservedAtMillis}
}

func accountFromPort(v port.AccountObservation) AccountObservation {
	return AccountObservation{State: v.State, Source: v.Source, PrincipalKey: v.PrincipalKey, ObservedAtMillis: v.ObservedAtMillis, ExpiresAtMillis: v.ExpiresAtMillis}
}
func accountToPort(v AccountObservation) port.AccountObservation {
	return port.AccountObservation{State: v.State, Source: v.Source, PrincipalKey: v.PrincipalKey, ObservedAtMillis: v.ObservedAtMillis, ExpiresAtMillis: v.ExpiresAtMillis}
}
