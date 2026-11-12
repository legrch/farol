// Package transition defines the closed, portable state machine for one
// Computer workspace continuity transition. This is custody, never authority.
// No process, filesystem, clock, or settings dependencies belong here.
package journal

import (
	"errors"
	"regexp"

	"github.com/legrch/farol/modules/computer/domain/observation"
)

const MaxEntries = 32

type Phase string

const (
	Intent               Phase = "intent"
	Prepared             Phase = "prepared"
	WithdrawIntent       Phase = "withdraw_intent"
	WithdrawAcknowledged Phase = "withdraw_ack"
	SettingsIntent       Phase = "settings_intent"
	SettingsAcknowledged Phase = "settings_ack"
	PublishIntent        Phase = "publish_intent"
	PublishAcknowledged  Phase = "publish_ack"
	CloseIntent          Phase = "close_intent"
	CloseAcknowledged    Phase = "close_ack"
	Committed            Phase = "committed"
	Refused              Phase = "refused"
)

var ErrRefused = errors.New("WORKSPACE_TRANSITION_REFUSED")
var ErrPending = errors.New("WORKSPACE_TRANSITION_PENDING")
var ErrUnknown = errors.New("WORKSPACE_TRANSITION_OUTCOME_UNKNOWN")

var identity = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$`)
var digest = regexp.MustCompile(`^[0-9a-f]{64}$`)
var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Request is the original immutable scope. ConsentDigest excludes ephemeral
// ShellVerified/current native readiness. RequestDigest includes the original
// selected operation and fields. Both are computed by trusted composition.
type Request struct {
	OperationID        string `json:"operationId"`
	RequestDigest      string `json:"requestDigest"`
	ConsentDigest      string `json:"consentDigest"`
	ProfileID          string `json:"profileId"`
	OwnerID            string `json:"ownerId"`
	ComputerID         string `json:"computerId"`
	WorkspaceID        string `json:"workspaceId"`
	Root               string `json:"root"`
	ExpectedRevision   string `json:"expectedRevision"`
	ExpectedGeneration string `json:"expectedGeneration"`
	BootUUID           string `json:"bootUuid"`
	HostLifetimeID     string `json:"hostLifetimeId"`
	RecoveryParent     string `json:"recoveryParent,omitempty"`
}

// Receipt retains one effect's exact original-operation acknowledgement. A
// receipt is never synthesized from current Settings or Store bytes.
type Receipt struct {
	EffectID string `json:"effectId"`
	Digest   string `json:"digest"`
}

// Certificate is a completed logical transition, not an acknowledgement that
// its publication, fsync/readback or caller RPC delivery was observed.
type Certificate struct {
	Kind          Phase   `json:"kind"`
	RequestDigest string  `json:"requestDigest"`
	ConsentDigest string  `json:"consentDigest"`
	Settings      Receipt `json:"settings"`
	Publication   Receipt `json:"publication"`
	Cleanup       Receipt `json:"cleanup"`
}

// AdmissionLink is part of the ONE durable C4 child-admission publication.
// It is not a consumed flag on the separately owned prerequisite file.
// Schema-1 entries have no link and can never inherit an original Stop ACK.
type AdmissionLink struct {
	ParentOperationID  string `json:"parentOperationId"`
	CertificateDigest  string `json:"certificateDigest"`
	Mode               string `json:"mode"`
	ChildIntentDigest  string `json:"childIntentDigest"`
	FullRequestDigest  string `json:"fullRequestDigest"`
	SettingsRevision   string `json:"settingsRevision"`
	SettingsGeneration string `json:"settingsGeneration"`
	SettingsDigest     string `json:"settingsDigest"`
}

func ValidAdmissionLink(r Request, link AdmissionLink) bool {
	return uuid.MatchString(link.ParentOperationID) && link.ParentOperationID != r.OperationID &&
		digest.MatchString(link.CertificateDigest) &&
		(link.Mode == "legacy-confirm" || link.Mode == "enrolled-rebind") &&
		digest.MatchString(link.ChildIntentDigest) &&
		link.FullRequestDigest == r.RequestDigest &&
		link.SettingsRevision == r.ExpectedRevision &&
		link.SettingsGeneration == r.ExpectedGeneration &&
		digest.MatchString(link.SettingsDigest) && r.RecoveryParent == ""
}

type Entry struct {
	Request        Request        `json:"request"`
	Parent         *AdmissionLink `json:"parent,omitempty"`
	Phase          Phase          `json:"phase"`
	Native         Receipt        `json:"native,omitempty"`
	Withdraw       Receipt        `json:"withdrawIntent,omitempty"`
	WithdrawAck    Receipt        `json:"withdrawAck,omitempty"`
	Settings       Receipt        `json:"settingsIntent,omitempty"`
	SettingsAck    Receipt        `json:"settingsAck,omitempty"`
	Publication    Receipt        `json:"publishIntent,omitempty"`
	PublicationAck Receipt        `json:"publishAck,omitempty"`
	Cleanup        Receipt        `json:"closeIntent,omitempty"`
	CleanupAck     Receipt        `json:"closeAck,omitempty"`
	Certificate    *Certificate   `json:"certificate,omitempty"`
	DischargedBy   string         `json:"dischargedBy,omitempty"`
}

type Journal struct {
	Entries []Entry `json:"entries"`
}

func ValidRequest(v Request) bool {
	return uuid.MatchString(v.OperationID) && digest.MatchString(v.RequestDigest) && digest.MatchString(v.ConsentDigest) &&
		identity.MatchString(v.ProfileID) && identity.MatchString(v.OwnerID) && identity.MatchString(v.ComputerID) && identity.MatchString(v.WorkspaceID) &&
		observation.CanonicalPath(v.Root) &&
		decimal(v.ExpectedRevision) && decimal(v.ExpectedGeneration) && uuid.MatchString(v.BootUUID) &&
		identity.MatchString(v.HostLifetimeID) && (v.RecoveryParent == "" || uuid.MatchString(v.RecoveryParent))
}
func decimal(s string) bool {
	if s == "" || len(s) > 20 || (len(s) > 1 && s[0] == '0') || s == "0" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
func validReceipt(r Receipt) bool {
	return identity.MatchString(r.EffectID) && digest.MatchString(r.Digest)
}
func emptyReceipt(r Receipt) bool { return r.EffectID == "" && r.Digest == "" }
func terminal(p Phase) bool       { return p == Committed || p == Refused }
func (j Journal) Find(id string) (Entry, bool) {
	for _, e := range j.Entries {
		if e.Request.OperationID == id {
			return e, true
		}
	}
	return Entry{}, false
}
func (j Journal) Unresolved() bool {
	for _, e := range j.Entries {
		if !terminal(e.Phase) && e.DischargedBy == "" {
			return true
		}
	}
	return false
}
func (j Journal) Valid() bool {
	if j.Entries == nil || len(j.Entries) > MaxEntries {
		return false
	}
	seen := map[string]bool{}
	linkedParents := map[string]bool{}
	for _, e := range j.Entries {
		if !ValidRequest(e.Request) || seen[e.Request.OperationID] || !validEntry(e) {
			return false
		}
		seen[e.Request.OperationID] = true
		if e.Parent != nil {
			if !ValidAdmissionLink(e.Request, *e.Parent) || linkedParents[e.Parent.ParentOperationID] {
				return false
			}
			linkedParents[e.Parent.ParentOperationID] = true
		}
	}
	for _, e := range j.Entries {
		if e.DischargedBy != "" {
			successor, ok := j.Find(e.DischargedBy)
			if !ok || successor.Phase != Committed || successor.Request.RecoveryParent != e.Request.OperationID ||
				successor.Request.ProfileID != e.Request.ProfileID || successor.Request.ComputerID != e.Request.ComputerID ||
				successor.Request.WorkspaceID != e.Request.WorkspaceID || successor.Request.Root != e.Request.Root ||
				successor.Request.BootUUID == e.Request.BootUUID || terminal(e.Phase) {
				return false
			}
		}
		if e.Request.RecoveryParent != "" {
			parent, ok := j.Find(e.Request.RecoveryParent)
			if !ok || parent.Request.BootUUID == e.Request.BootUUID || parent.Request.ProfileID != e.Request.ProfileID ||
				parent.Request.ComputerID != e.Request.ComputerID || parent.Request.WorkspaceID != e.Request.WorkspaceID || parent.Request.Root != e.Request.Root {
				return false
			}
			// Exactly the original pending parent is recoverable, not a chain
			// with an already discharged/terminal unrelated operation.
			if terminal(parent.Phase) {
				return false
			}
			if terminal(e.Phase) && e.Phase == Committed && parent.DischargedBy != e.Request.OperationID {
				return false
			}
		}
	}
	// There is at most one live undischarged operation. Recovery successors
	// can coexist with their named unresolved parent, but not third parties.
	active := 0
	for _, e := range j.Entries {
		if !terminal(e.Phase) && e.DischargedBy == "" {
			active++
		}
	}
	if active > 2 {
		return false
	}
	if active == 2 {
		// Two active records are permitted only for the ORIGINAL unknown and
		// its one explicit different-boot recovery operation.
		var first, second Entry
		found := false
		for _, e := range j.Entries {
			if terminal(e.Phase) || e.DischargedBy != "" {
				continue
			}
			if !found {
				first, found = e, true
			} else {
				second = e
			}
		}
		if !(first.Request.RecoveryParent == second.Request.OperationID || second.Request.RecoveryParent == first.Request.OperationID) {
			return false
		}
	}
	return true
}
func validEntry(e Entry) bool {
	if e.DischargedBy != "" && !uuid.MatchString(e.DischargedBy) {
		return false
	}
	if !emptyReceipt(e.Native) && !validReceipt(e.Native) {
		return false
	}
	for _, r := range []Receipt{e.Withdraw, e.WithdrawAck, e.Settings, e.SettingsAck, e.Publication, e.PublicationAck, e.Cleanup, e.CleanupAck} {
		if !emptyReceipt(r) && !validReceipt(r) {
			return false
		}
	}
	stages := []Phase{Intent, Prepared, WithdrawIntent, WithdrawAcknowledged, SettingsIntent, SettingsAcknowledged, PublishIntent, PublishAcknowledged, CloseIntent, CloseAcknowledged, Committed}
	idx := -1
	for i, p := range stages {
		if e.Phase == p {
			idx = i
			break
		}
	}
	if idx < 0 && e.Phase != Refused {
		return false
	}
	if idx > 0 && emptyReceipt(e.Native) {
		return false
	}
	if idx >= 2 && emptyReceipt(e.Withdraw) {
		return false
	}
	if idx >= 3 && emptyReceipt(e.WithdrawAck) {
		return false
	}
	if idx >= 4 && emptyReceipt(e.Settings) {
		return false
	}
	if idx >= 5 && emptyReceipt(e.SettingsAck) {
		return false
	}
	if idx >= 6 && emptyReceipt(e.Publication) {
		return false
	}
	if idx >= 7 && emptyReceipt(e.PublicationAck) {
		return false
	}
	if idx >= 8 && emptyReceipt(e.Cleanup) {
		return false
	}
	if idx >= 9 && emptyReceipt(e.CleanupAck) {
		return false
	}
	// Persisted documents must not contain receipts for effects which the
	// journal has not reached. Reject corrupt/mutated future fields rather than
	// letting a later transition inherit a fabricated ACK.
	if idx >= 0 {
		future := []struct {
			min     int
			receipt Receipt
		}{{1, e.Native}, {2, e.Withdraw}, {3, e.WithdrawAck}, {4, e.Settings}, {5, e.SettingsAck}, {6, e.Publication}, {7, e.PublicationAck}, {8, e.Cleanup}, {9, e.CleanupAck}}
		for _, field := range future {
			if idx < field.min && !emptyReceipt(field.receipt) {
				return false
			}
		}
	}
	if e.Phase == Refused && (!emptyReceipt(e.Withdraw) || !emptyReceipt(e.WithdrawAck) || !emptyReceipt(e.Settings) || !emptyReceipt(e.SettingsAck) || !emptyReceipt(e.Publication) || !emptyReceipt(e.PublicationAck) || !emptyReceipt(e.Cleanup) || emptyReceipt(e.CleanupAck)) {
		return false
	}
	for _, pair := range [][2]Receipt{{e.Withdraw, e.WithdrawAck}, {e.Settings, e.SettingsAck}, {e.Publication, e.PublicationAck}, {e.Cleanup, e.CleanupAck}} {
		// Early refusal closes acquired handles without a close intent.
		if !emptyReceipt(pair[1]) && !(e.Phase == Refused && emptyReceipt(pair[0])) && pair[0].EffectID != pair[1].EffectID {
			return false
		}
	}
	if e.Phase == Committed || e.Phase == Refused {
		c := e.Certificate
		if c == nil || c.Kind != e.Phase || c.RequestDigest != e.Request.RequestDigest || c.ConsentDigest != e.Request.ConsentDigest || c.Cleanup != e.CleanupAck {
			return false
		}
		if e.Phase == Committed && (c.Settings != e.SettingsAck || c.Publication != e.PublicationAck) {
			return false
		}
		if e.Phase == Refused && (!emptyReceipt(c.Settings) || !emptyReceipt(c.Publication)) {
			return false
		}
	} else if e.Certificate != nil {
		return false
	}
	return true
}

// Begin returns an existing copy for a replay of the exact request; it never
// dispatches an effect or permits a new attempt while another is unresolved.
func (j Journal) Begin(r Request) (Journal, error) {
	return j.begin(r, nil)
}

// BeginLinked admits only one original intended child, with immutable
// certificate reference in the same C4 append. Future children cannot claim
// the same parent; no separate parent-consumed publication is needed.
func (j Journal) BeginLinked(r Request, link AdmissionLink) (Journal, error) {
	if !ValidAdmissionLink(r, link) {
		return Journal{}, ErrRefused
	}
	return j.begin(r, &link)
}

func (j Journal) begin(r Request, link *AdmissionLink) (Journal, error) {
	if !j.Valid() || !ValidRequest(r) {
		return Journal{}, ErrRefused
	}
	if old, ok := j.Find(r.OperationID); ok {
		if old.Request != r || (old.Parent == nil) != (link == nil) ||
			(link != nil && *old.Parent != *link) {
			return Journal{}, ErrRefused
		}
		return j, nil
	}
	if link != nil {
		for _, old := range j.Entries {
			if old.Parent != nil && old.Parent.ParentOperationID == link.ParentOperationID {
				return Journal{}, ErrRefused
			}
		}
	}
	if len(j.Entries) >= MaxEntries {
		return Journal{}, ErrRefused
	}
	if r.RecoveryParent == "" {
		if j.Unresolved() {
			return Journal{}, ErrPending
		}
	} else {
		p, ok := j.Find(r.RecoveryParent)
		if !ok || terminal(p.Phase) || p.DischargedBy != "" || p.Request.BootUUID == r.BootUUID ||
			p.Request.Root != r.Root || p.Request.ComputerID != r.ComputerID || p.Request.WorkspaceID != r.WorkspaceID ||
			p.Request.ProfileID != r.ProfileID {
			return Journal{}, ErrRefused
		}
		for _, e := range j.Entries {
			if !terminal(e.Phase) && e.Request.OperationID != r.RecoveryParent {
				return Journal{}, ErrPending
			}
		}
	}
	next := j.Clone()
	next.Entries = append(next.Entries, Entry{Request: r, Parent: link, Phase: Intent})
	if !next.Valid() {
		return Journal{}, ErrRefused
	}
	return next, nil
}

// Advance accepts only the next durable phase and its exact trusted receipt.
// Every intent must be persisted BEFORE its corresponding covered effect; a
// missing acknowledgement is a sticky nonterminal fence, not retry permission.
func (j Journal) Advance(id string, want Phase, receipt Receipt) (Journal, error) {
	if !j.Valid() || !validReceipt(receipt) {
		return Journal{}, ErrRefused
	}
	next := j.Clone()
	index := -1
	for i, e := range next.Entries {
		if e.Request.OperationID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return Journal{}, ErrRefused
	}
	e := &next.Entries[index]
	transitions := map[Phase]Phase{Intent: Prepared, Prepared: WithdrawIntent, WithdrawIntent: WithdrawAcknowledged, WithdrawAcknowledged: SettingsIntent, SettingsIntent: SettingsAcknowledged, SettingsAcknowledged: PublishIntent, PublishIntent: PublishAcknowledged, PublishAcknowledged: CloseIntent, CloseIntent: CloseAcknowledged}
	if transitions[e.Phase] != want {
		return Journal{}, ErrRefused
	}
	switch want {
	case Prepared:
		e.Native = receipt
	case WithdrawIntent:
		e.Withdraw = receipt
	case SettingsIntent:
		e.Settings = receipt
	case PublishIntent:
		e.Publication = receipt
	case CloseIntent:
		e.Cleanup = receipt
	case WithdrawAcknowledged:
		if receipt.EffectID != e.Withdraw.EffectID {
			return Journal{}, ErrRefused
		}
		e.WithdrawAck = receipt
	case SettingsAcknowledged:
		if receipt.EffectID != e.Settings.EffectID {
			return Journal{}, ErrRefused
		}
		e.SettingsAck = receipt
	case PublishAcknowledged:
		if receipt.EffectID != e.Publication.EffectID {
			return Journal{}, ErrRefused
		}
		e.PublicationAck = receipt
	case CloseAcknowledged:
		if receipt.EffectID != e.Cleanup.EffectID {
			return Journal{}, ErrRefused
		}
		e.CleanupAck = receipt
	}
	e.Phase = want
	if !next.Valid() {
		return Journal{}, ErrRefused
	}
	return next, nil
}

// Certify is purely logical. Its WAL publication must independently be synced
// and read back by the native owner before any current activation.
func (j Journal) Certify(id string, kind Phase, cleanup Receipt) (Journal, error) {
	if !j.Valid() || !validReceipt(cleanup) {
		return Journal{}, ErrRefused
	}
	next := j.Clone()
	index := -1
	for i, e := range next.Entries {
		if e.Request.OperationID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return Journal{}, ErrRefused
	}
	e := &next.Entries[index]
	if kind == Committed {
		if e.Phase != CloseAcknowledged || e.CleanupAck != cleanup {
			return Journal{}, ErrRefused
		}
	} else if kind == Refused {
		if e.Phase != Intent && e.Phase != Prepared {
			return Journal{}, ErrRefused
		}
		e.CleanupAck = cleanup
	} else {
		return Journal{}, ErrRefused
	}
	e.Phase = kind
	e.Certificate = &Certificate{Kind: kind, RequestDigest: e.Request.RequestDigest, ConsentDigest: e.Request.ConsentDigest, Settings: e.SettingsAck, Publication: e.PublicationAck, Cleanup: e.CleanupAck}
	if e.Request.RecoveryParent != "" && kind == Committed {
		for i := range next.Entries {
			if next.Entries[i].Request.OperationID == e.Request.RecoveryParent {
				next.Entries[i].DischargedBy = id
				break
			}
		}
	}
	if !next.Valid() {
		return Journal{}, ErrRefused
	}
	return next, nil
}
func (j Journal) Clone() Journal {
	out := Journal{Entries: make([]Entry, len(j.Entries))}
	for i, e := range j.Entries {
		out.Entries[i] = e
		if e.Parent != nil {
			link := *e.Parent
			out.Entries[i].Parent = &link
		}
		if e.Certificate != nil {
			c := *e.Certificate
			out.Entries[i].Certificate = &c
		}
	}
	return out
}
