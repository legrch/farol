// Package modelruntime connects the current Browser application capture to the
// account-scoped model policy. It owns no account, catalogue, grant or executor.
package modelruntime

import (
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	selection "github.com/legrch/farol/modules/chat/domain/modelselection"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid Code = "CHAT_MODEL_RUNTIME_INVALID"
	Changed Code = "CHAT_MODEL_RUNTIME_CHANGED"
)

// BrowserSource is the original value projection from the existing account
// owner. Its positive revision provides the catalogue epoch for this one
// retained capture. Copying these values cannot create a private account Grant.
type BrowserSource struct {
	Approval    port.AccountApproval
	Observation port.AccountObservation
}

// BrowserCapture keeps the whole existing app mapping and account projection
// beside the Models pin. Neither a Pin nor a model DTO contains all this identity.
// The private selected-profile snapshot is not a provider discovery catalogue.
type BrowserCapture struct {
	capture  port.ModelSelectionCapture
	source   BrowserSource
	resolved selection.Resolved
	valid    bool
}

func (c BrowserCapture) Capture() port.ModelSelectionCapture { return c.capture }
func (c BrowserCapture) Source() BrowserSource               { return c.source }
func (c BrowserCapture) Resolved() selection.Resolved        { return c.resolved }

// CaptureBrowser runs after the original account owner's Approve. The actual
// app resolver already mapped settings aliases, compiled controls and explicit
// effort into capture. This adapter never resolves another default or reads IO.
func CaptureBrowser(capture port.ModelSelectionCapture, source BrowserSource, nowMillis uint64) (BrowserCapture, error) {
	snapshot, err := browserSnapshot(capture, source, nowMillis)
	if err != nil {
		return BrowserCapture{}, err
	}
	resolved, err := selection.Resolve(snapshot, snapshot.Scope, nowMillis, selection.Request{
		Slug: capture.Selection.ModelID, Effort: capture.Selection.Effort,
		Requirements: selection.Requirements{Text: true},
	})
	if err != nil {
		return BrowserCapture{}, err
	}
	return BrowserCapture{capture: capture, source: source, resolved: resolved, valid: true}, nil
}

// RecheckBrowser is a first-dispatch correlation check, not account authority or
// permission to replay a refused/UNKNOWN Send. A new observation, approval or
// configuration requires a separately owned new capture; it cannot renew this
// original value's expiry or mutate a running conversation.
func RecheckBrowser(original BrowserCapture, current port.ModelSelectionCapture, source BrowserSource, nowMillis uint64) error {
	if !original.valid {
		return Invalid
	}
	if original.capture != current || original.source != source {
		return Changed
	}
	snapshot, err := browserSnapshot(current, source, nowMillis)
	if err != nil {
		return err
	}
	return selection.RecheckBeforeStart(original.resolved, snapshot, snapshot.Scope, nowMillis)
}

func browserSnapshot(capture port.ModelSelectionCapture, source BrowserSource, nowMillis uint64) (selection.Snapshot, error) {
	s, a, o := capture.Selection, source.Approval, source.Observation
	if !s.Valid() || !capture.Resolution.Valid(s) || !capture.Required.Valid(s) ||
		s.Provider != "farol" || s.Alias != "chatgpt" || s.ToolsEnabled ||
		a.Revision == 0 || a.ApprovalID == "" || a.Scope.ProfileID == "" ||
		a.Scope.BackendGeneration == "" || a.Scope.OwnerID == "" || a.Scope.SessionID == "" ||
		a.PrincipalKey != s.AccountID || o.PrincipalKey != a.PrincipalKey ||
		o.State != "observed" || o.Source != "provider-session-v1" || !principal(o.PrincipalKey) {
		return selection.Snapshot{}, Invalid
	}
	// Use the same conservative observation bounds as the original account owner.
	// This does not approve an observation or discover the signed-in account.
	const maxSafeMillis = uint64(1<<53 - 1)
	if o.ObservedAtMillis == 0 || o.ObservedAtMillis > maxSafeMillis || o.ExpiresAtMillis > maxSafeMillis ||
		o.ExpiresAtMillis <= o.ObservedAtMillis || nowMillis == 0 || nowMillis > maxSafeMillis ||
		nowMillis < o.ObservedAtMillis || nowMillis >= o.ExpiresAtMillis ||
		nowMillis-o.ObservedAtMillis > accountapproval.MaxObservationAgeMs {
		return selection.Snapshot{}, accountapproval.Stale
	}
	// Software evidence comes from the exact compiled translation and existing
	// browser text-turn protocol. It says nothing about provider entitlement,
	// image/tool support, subscription inference or current live public controls.
	snapshot := selection.Snapshot{
		Scope: selection.Scope{Route: selection.Route{Provider: "farol", Backend: selection.BrowserChat, Billing: selection.Plan}, AccountID: s.AccountID},
		Epoch: a.Revision, Revision: capture.Resolution.ConfigSHA256,
		ObservedAtMillis: o.ObservedAtMillis, ExpiresAtMillis: o.ExpiresAtMillis,
		Source: selection.Browser, Complete: true,
		Entries: []selection.Entry{{
			Slug: s.ModelID, DisplayName: s.ModelID, Efforts: []string{s.Effort},
			Capabilities: selection.Capabilities{Text: selection.Yes, Image: selection.Unknown, Tools: selection.Unknown,
				Revision: capture.Resolution.TranslationID, Provenance: "farol-browser-text-turn-v1"},
		}},
	}
	if selection.ValidateSnapshot(snapshot) != nil {
		return selection.Snapshot{}, Invalid
	}
	return snapshot, nil
}

func principal(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'f' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
