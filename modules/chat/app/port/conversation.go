package port

import (
	"context"
	"strings"
	"unicode/utf8"
)

// Selection is pinned by authorized composition/caller before admission. IDs
// are opaque non-secret references, never cookies/authentication or entitlement.
// The stable public route is farol/chatgpt; ModelID names the exact UI selection.
type Selection struct {
	Provider, Alias, AccountID, ModelID, Effort string
	Mode                                        string
	ToolsEnabled                                bool
	ConnectorID, ConnectorGrantID               string
}

func (s Selection) Valid() bool {
	if s.Provider != "farol" || s.Alias != "chatgpt" || !conversationID(s.AccountID) || !conversationID(s.ModelID) {
		return false
	}
	// Effort is an already-resolved route value. Chat does not impose a new
	// universal vendor enum or silently translate legacy values.
	if len(s.Effort) < 1 || len(s.Effort) > 40 || strings.IndexFunc(s.Effort, func(c rune) bool {
		return !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')
	}) != -1 {
		return false
	}
	if s.Mode != "" && s.Mode != "standard" && s.Mode != "pro" {
		return false
	}
	if s.ToolsEnabled {
		return conversationID(s.ConnectorID) && conversationID(s.ConnectorGrantID)
	}
	return s.ConnectorID == "" && s.ConnectorGrantID == ""
}

type ConversationMode string

const (
	NewSaved   ConversationMode = "new-saved"
	OwnedSaved ConversationMode = "owned-saved"
)

// Target is selected only by Chat from a live owned conversation. A URL is not
// accepted. OwnedSaved must never create a replacement provider conversation.
type ConversationTarget struct {
	Mode                                ConversationMode
	ConversationID                      string
	PreviousUserTurnID, PreviousReplyID string
	Selection                           Selection
	Resolution                          ModelResolution
}

func (t ConversationTarget) Valid() bool {
	if !t.Selection.Valid() || !t.Resolution.Valid(t.Selection) {
		return false
	}
	switch t.Mode {
	case NewSaved:
		return t.ConversationID == "" && t.PreviousUserTurnID == "" && t.PreviousReplyID == ""
	case OwnedSaved:
		return conversationID(t.ConversationID) && conversationID(t.PreviousUserTurnID) && conversationID(t.PreviousReplyID)
	}
	return false
}

// Verification is a fresh one-Send witness for the exact lease/document and
// immutable intent. Desktop rechecks it atomically with composer insertion/Send;
// a changed model/account/attachment must produce NotSent, never a fallback.
// Observed is revalidated each turn, not inherited from the first conversation.
type VerifySendRequest struct {
	Binding                             BrowserBinding
	Requested                           Selection
	PreviousUserTurnID, PreviousReplyID string
	IntentDigest                        string
	DeadlineMillis                      uint64
}
type SendVerification struct {
	Binding                             BrowserBinding
	Observed                            Selection
	PreviousUserTurnID, PreviousReplyID string
	IntentDigest, EvidenceID            string
}
type VerifiedBrowser interface {
	Browser
	VerifySend(VerifySendRequest) (*SendVerification, error)
}

func ValidVerification(request VerifySendRequest, proof *SendVerification) bool {
	return proof != nil && proof.Binding == request.Binding && proof.Observed == request.Requested && proof.Observed.Valid() && proof.PreviousUserTurnID == request.PreviousUserTurnID && proof.PreviousReplyID == request.PreviousReplyID && proof.IntentDigest == request.IntentDigest && conversationID(proof.EvidenceID)
}

// IntentDigester returns lowercase SHA-256 of the complete canonical input.
// App prepares the bytes; concrete hashing stays injected. Hashing performs no
// provider/native IO. A digest includes identity, target, selection and prompt.
type IntentDigester interface{ Digest([]byte) (string, error) }

type ConversationInput struct {
	Binding    TurnBinding
	Selection  Selection
	Resolution ModelResolution
	Prompt     string
}

// Output events and retained content are explicit authorized consumer data,
// never Activity/default progress or journal fields. No usage/reasoning/token
// fields exist. Frames are observed/replayed through this SAME Chat executor.
type ConversationResult struct {
	Binding                                                               TurnBinding
	ProviderConversationID, ProviderUserTurnID, ProviderReplyID, ResultID string
	Requested, Observed                                                   Selection
	Text                                                                  string
	Phase, Outcome, Code                                                  string
	Evidence                                                              SelectionEvidence
	Complete, Acknowledged                                                bool
}
type ConversationState struct {
	Binding                TurnBinding
	ProviderConversationID string
	Requested              Selection
	Evidence               SelectionEvidence
	Prepared               bool
	Phase                  string
}

type ConversationOwner interface {
	WithConversation(context.Context, func(ConversationState) error) error
}

func conversationID(s string) bool {
	if len(s) < 1 || len(s) > 120 || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c <= 32 || c == 127 {
			return false
		}
	}
	return true
}

// ModelResolution is an explicit mapping of the existing owner configuration,
// supplied by trusted composition. Zero means no resolution proof was supplied;
// requested selection alone never becomes configured/provider-verified evidence.
type ModelResolution struct {
	RequestedAlias, RequestedExecutor, RequestedEffort, RequestedMode string
	Resolved                                                          Selection
	ConfigSHA256, TranslationID                                       string
}

func (r ModelResolution) Valid(selection Selection) bool {
	if r == (ModelResolution{}) {
		return true
	}
	if !conversationID(r.RequestedAlias) || !conversationID(r.RequestedExecutor) || r.Resolved != selection || !conversationID(r.TranslationID) || len(r.ConfigSHA256) != 64 {
		return false
	}
	if r.RequestedEffort != "" && !conversationID(r.RequestedEffort) {
		return false
	}
	if r.RequestedMode != "" && r.RequestedMode != selection.Mode {
		return false
	}
	return strings.IndexFunc(r.ConfigSHA256, func(c rune) bool { return !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) }) == -1
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
