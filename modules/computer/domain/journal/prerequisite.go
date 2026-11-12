package journal

import (
	"errors"
	"strconv"

	"github.com/legrch/farol/modules/computer/domain/observation"
)

// StopLedger is original prerequisite custody, not Computer authority. Native
// lifecycle, connector closure and the sole Settings writer retain their effects.
// No observation or duplicate request authorizes another dispatch.
const MaxStopEntries = 32

type StopPhase string

const (
	StopAdmissionIntent         StopPhase = "admission_intent"
	StopEffectIntent            StopPhase = "stop_intent"
	StopAcknowledged            StopPhase = "stop_ack"
	StoppedSettingsIntent       StopPhase = "settings_intent"
	StoppedSettingsAcknowledged StopPhase = "settings_ack"
	StopCleanupIntent           StopPhase = "cleanup_intent"
	StopCleanupAcknowledged     StopPhase = "cleanup_ack"
	StopComplete                StopPhase = "prerequisite_complete"
	StopRefusedBeforeDispatch   StopPhase = "refused_before_stop"
	StopUnresolved              StopPhase = "unresolved"
)

var ErrStopRefused = errors.New("COMPUTER_STOP_PREREQUISITE_REFUSED")
var ErrStopPending = errors.New("COMPUTER_STOP_PREREQUISITE_PENDING")
var ErrStopCapacity = errors.New("COMPUTER_STOP_PREREQUISITE_CAPACITY")
var ErrStopUnknown = errors.New("COMPUTER_STOP_PREREQUISITE_UNKNOWN")

// StopRequest is captured before the first Stop. Effect identities are distinct
// from the parent and from RPC request IDs. Child fields are all absent for an
// ordinary non-migration command; a migration fixes all of them before Stop.
type StopRequest struct {
	OperationID         string `json:"operationId"`
	RequestDigest       string `json:"requestDigest"`
	CommandKind         string `json:"commandKind"`
	CommandDigest       string `json:"commandDigest"`
	Purpose             string `json:"purpose"`
	ProfileID           string `json:"profileId"`
	OwnerID             string `json:"ownerId"`
	ComputerID          string `json:"computerId"`
	WorkspaceID         string `json:"workspaceId"`
	Root                string `json:"root"`
	ConsentDigest       string `json:"consentDigest"`
	ExpectedRevision    string `json:"expectedRevision"`
	ComputerGeneration  string `json:"computerGeneration"`
	ConnectorGeneration string `json:"connectorGeneration"`
	SettingsDigest      string `json:"settingsDigest"`
	BootUUID            string `json:"bootUuid"`
	HostLifetimeID      string `json:"hostLifetimeId"`
	BackendGeneration   string `json:"backendGeneration"`
	RuntimeID           string `json:"runtimeId"`
	BuildID             string `json:"buildId"`
	StopEffectID        string `json:"stopEffectId"`
	SettingsEffectID    string `json:"settingsEffectId"`
	CleanupEffectID     string `json:"cleanupEffectId"`
	ChildOperationID    string `json:"childOperationId,omitempty"`
	ChildMode           string `json:"childMode,omitempty"`
	ChildIntentDigest   string `json:"childIntentDigest,omitempty"`
}

// StopClosure is positive evidence supplied by the original native owners.
// Go composition also checks ClosureOperationID/Digest against its own retained
// connector-close receipt, not just a desktop's claim that the process stopped.
type StopClosure struct {
	EffectID            string `json:"effectId"`
	BackendGeneration   string `json:"backendGeneration"`
	RuntimeID           string `json:"runtimeId"`
	LifecycleID         string `json:"lifecycleId"`
	StopRevision        string `json:"stopRevision"`
	PreparationRevision string `json:"preparationRevision"`
	ClosureOperationID  string `json:"closureOperationId"`
	ClosureDigest       string `json:"closureDigest"`
}

// StopSettingsPlan precedes the sole writer's conditional publication. A
// matching later document does not supply its original acknowledgement.
type StopSettingsPlan struct {
	EffectID            string `json:"effectId"`
	ExpectedRevision    string `json:"expectedRevision"`
	ExpectedDigest      string `json:"expectedDigest"`
	NextRevision        string `json:"nextRevision"`
	NextDigest          string `json:"nextDigest"`
	ComputerGeneration  string `json:"computerGeneration"`
	ConnectorGeneration string `json:"connectorGeneration"`
	ConsentDigest       string `json:"consentDigest"`
}

type StopSettingsReceipt struct {
	EffectID            string `json:"effectId"`
	Revision            string `json:"revision"`
	DocumentDigest      string `json:"documentDigest"`
	ComputerGeneration  string `json:"computerGeneration"`
	ConnectorGeneration string `json:"connectorGeneration"`
	ConsentDigest       string `json:"consentDigest"`
}

type StopCleanupReceipt struct {
	EffectID          string `json:"effectId"`
	BackendGeneration string `json:"backendGeneration"`
	RuntimeID         string `json:"runtimeId"`
	Digest            string `json:"digest"`
}

type StopEntry struct {
	Request        StopRequest          `json:"request"`
	Phase          StopPhase            `json:"phase"`
	Closure        *StopClosure         `json:"closure,omitempty"`
	SettingsIntent *StopSettingsPlan    `json:"settingsIntent,omitempty"`
	SettingsAck    *StopSettingsReceipt `json:"settingsAck,omitempty"`
	CleanupAck     *StopCleanupReceipt  `json:"cleanupAck,omitempty"`
	Refusal        string               `json:"refusal,omitempty"`
	UnresolvedAt   StopPhase            `json:"unresolvedAt,omitempty"`
	Uncertainty    string               `json:"uncertainty,omitempty"`
}

type StopLedger struct {
	Entries []StopEntry `json:"entries"`
}

// This projection contains only previously acknowledged effects. Its protected
// publication/qualification and historical caller delivery are separate facts.
type StopCertificate struct {
	Request  StopRequest         `json:"request"`
	Closure  StopClosure         `json:"closure"`
	Settings StopSettingsReceipt `json:"settings"`
	Cleanup  StopCleanupReceipt  `json:"cleanup"`
}

func stopDecimal(s string, zero bool) bool {
	if s == "" || len(s) > 20 || (len(s) > 1 && s[0] == '0') || (!zero && s == "0") {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	_, err := strconv.ParseUint(s, 10, 64)
	return err == nil
}

func ValidStopRequest(r StopRequest) bool {
	if !uuid.MatchString(r.OperationID) || !digest.MatchString(r.RequestDigest) || !digest.MatchString(r.CommandDigest) ||
		!digest.MatchString(r.ConsentDigest) || !digest.MatchString(r.SettingsDigest) || !digest.MatchString(r.BuildID) ||
		!identity.MatchString(r.ProfileID) || !identity.MatchString(r.OwnerID) || !identity.MatchString(r.ComputerID) ||
		!identity.MatchString(r.HostLifetimeID) || !identity.MatchString(r.BackendGeneration) || !identity.MatchString(r.RuntimeID) ||
		!uuid.MatchString(r.BootUUID) || !stopDecimal(r.ExpectedRevision, false) || !stopDecimal(r.ComputerGeneration, false) || !stopDecimal(r.ConnectorGeneration, false) {
		return false
	}
	var purpose string
	switch r.CommandKind {
	case "computer.add-workspace", "computer.update-access", "computer.update-commands", "computer.update-file-policy", "computer.remove-workspace", "computer.confirm-workspace", "computer.rebind-workspace":
		purpose = "workspace-change"
	case "connector.stop":
		purpose = "owner-stop"
	case "connector.repair":
		purpose = "repair"
	case "update":
		purpose = "update"
	case "quit":
		purpose = "quit"
	default:
		return false
	}
	if r.Purpose != purpose {
		return false
	}
	if (r.WorkspaceID == "") != (r.Root == "") {
		return false
	}
	// An add/global-policy change cannot invent a selected existing root;
	// a workspace-specific command cannot omit its original fixed root.
	switch r.CommandKind {
	case "computer.add-workspace", "computer.update-commands", "computer.update-file-policy":
		if r.WorkspaceID != "" {
			return false
		}
	case "computer.update-access", "computer.remove-workspace", "computer.confirm-workspace", "computer.rebind-workspace":
		if r.WorkspaceID == "" {
			return false
		}
	}
	if r.WorkspaceID != "" && (!identity.MatchString(r.WorkspaceID) || !validStopRoot(r.Root)) {
		return false
	}
	ids := map[string]bool{r.OperationID: true}
	for _, id := range []string{r.StopEffectID, r.SettingsEffectID, r.CleanupEffectID} {
		if !uuid.MatchString(id) || ids[id] {
			return false
		}
		ids[id] = true
	}
	childMode := ""
	switch r.CommandKind {
	case "computer.confirm-workspace":
		childMode = "legacy-confirm"
	case "computer.rebind-workspace":
		childMode = "enrolled-rebind"
	}
	if r.ChildOperationID == "" {
		return childMode == "" && r.ChildMode == "" && r.ChildIntentDigest == ""
	}
	return r.Purpose == "workspace-change" && r.WorkspaceID != "" && uuid.MatchString(r.ChildOperationID) && !ids[r.ChildOperationID] &&
		childMode != "" && r.ChildMode == childMode && digest.MatchString(r.ChildIntentDigest)
}

func validStopRoot(root string) bool {
	// Share the migration's canonical path predicate without consulting a host.
	return observation.CanonicalPath(root)
}

func stopRank(p StopPhase) int {
	switch p {
	case StopAdmissionIntent:
		return 0
	case StopEffectIntent:
		return 1
	case StopAcknowledged:
		return 2
	case StoppedSettingsIntent:
		return 3
	case StoppedSettingsAcknowledged:
		return 4
	case StopCleanupIntent:
		return 5
	case StopCleanupAcknowledged:
		return 6
	case StopComplete:
		return 7
	default:
		return -1
	}
}

func (e StopEntry) Terminal() bool {
	return e.Phase == StopComplete || e.Phase == StopRefusedBeforeDispatch
}
func (e StopEntry) Valid() bool {
	if !ValidStopRequest(e.Request) {
		return false
	}
	r := e.Request
	phase := e.Phase
	if phase == StopUnresolved {
		if stopRank(e.UnresolvedAt) < 0 || e.UnresolvedAt == StopComplete {
			return false
		}
		switch e.Uncertainty {
		case "stop_unconfirmed", "settings_unconfirmed", "cleanup_unconfirmed", "context_changed":
		default:
			return false
		}
		phase = e.UnresolvedAt
	} else if e.UnresolvedAt != "" || e.Uncertainty != "" {
		return false
	}
	if phase == StopRefusedBeforeDispatch {
		return (e.Refusal == "cancelled_before_dispatch" || e.Refusal == "stop_intent_not_written") &&
			e.Closure == nil && e.SettingsIntent == nil && e.SettingsAck == nil && e.CleanupAck == nil
	}
	rank := stopRank(phase)
	if rank < 0 || e.Refusal != "" || (e.Closure != nil) != (rank >= 2) || (e.SettingsIntent != nil) != (rank >= 3) ||
		(e.SettingsAck != nil) != (rank >= 4) || (e.CleanupAck != nil) != (rank >= 6) {
		return false
	}
	if a := e.Closure; a != nil {
		if a.EffectID != r.StopEffectID || a.BackendGeneration != r.BackendGeneration || a.RuntimeID != r.RuntimeID ||
			!uuid.MatchString(a.LifecycleID) || !stopDecimal(a.StopRevision, false) || !stopDecimal(a.PreparationRevision, true) ||
			!uuid.MatchString(a.ClosureOperationID) || !digest.MatchString(a.ClosureDigest) {
			return false
		}
	}
	if p := e.SettingsIntent; p != nil {
		rev, _ := strconv.ParseUint(r.ExpectedRevision, 10, 64)
		if rev == ^uint64(0) || p.EffectID != r.SettingsEffectID || p.ExpectedRevision != r.ExpectedRevision || p.ExpectedDigest != r.SettingsDigest ||
			p.NextRevision != strconv.FormatUint(rev+1, 10) || !digest.MatchString(p.NextDigest) || p.NextDigest == p.ExpectedDigest ||
			p.ComputerGeneration != r.ComputerGeneration || p.ConnectorGeneration != r.ConnectorGeneration || p.ConsentDigest != r.ConsentDigest {
			return false
		}
	}
	if a := e.SettingsAck; a != nil {
		p := e.SettingsIntent
		if a.EffectID != p.EffectID || a.Revision != p.NextRevision || a.DocumentDigest != p.NextDigest || a.ComputerGeneration != p.ComputerGeneration ||
			a.ConnectorGeneration != p.ConnectorGeneration || a.ConsentDigest != p.ConsentDigest {
			return false
		}
	}
	if a := e.CleanupAck; a != nil {
		if a.EffectID != r.CleanupEffectID || a.BackendGeneration != r.BackendGeneration || a.RuntimeID != r.RuntimeID || !digest.MatchString(a.Digest) {
			return false
		}
	}
	return true
}

func (l StopLedger) Valid() bool {
	if l.Entries == nil || len(l.Entries) > MaxStopEntries {
		return false
	}
	seen := map[string]bool{}
	pending := 0
	for _, e := range l.Entries {
		if !e.Valid() {
			return false
		}
		for _, id := range []string{e.Request.OperationID, e.Request.StopEffectID, e.Request.SettingsEffectID, e.Request.CleanupEffectID, e.Request.ChildOperationID} {
			if id == "" {
				continue
			}
			if seen[id] {
				return false
			}
			seen[id] = true
		}
		if !e.Terminal() {
			pending++
		}
	}
	return pending <= 1
}
func (l StopLedger) Pending() bool {
	for _, e := range l.Entries {
		if !e.Terminal() {
			return true
		}
	}
	return false
}
func (l StopLedger) Find(id string) (StopEntry, bool) {
	for _, e := range l.Entries {
		if e.Request.OperationID == id {
			return e.Clone(), true
		}
	}
	return StopEntry{}, false
}
func (e StopEntry) Clone() StopEntry {
	if e.Closure != nil {
		v := *e.Closure
		e.Closure = &v
	}
	if e.SettingsIntent != nil {
		v := *e.SettingsIntent
		e.SettingsIntent = &v
	}
	if e.SettingsAck != nil {
		v := *e.SettingsAck
		e.SettingsAck = &v
	}
	if e.CleanupAck != nil {
		v := *e.CleanupAck
		e.CleanupAck = &v
	}
	return e
}
func (l StopLedger) Clone() StopLedger {
	out := StopLedger{Entries: make([]StopEntry, len(l.Entries))}
	for i, e := range l.Entries {
		out.Entries[i] = e.Clone()
	}
	return out
}

func (l StopLedger) Begin(r StopRequest) (StopLedger, bool, error) {
	if !l.Valid() || !ValidStopRequest(r) {
		return StopLedger{}, false, ErrStopRefused
	}
	if old, ok := l.Find(r.OperationID); ok {
		if old.Request != r {
			return StopLedger{}, false, ErrStopRefused
		}
		return l.Clone(), false, nil
	}
	if l.Pending() {
		return StopLedger{}, false, ErrStopPending
	}
	if len(l.Entries) >= MaxStopEntries {
		return StopLedger{}, false, ErrStopCapacity
	}
	next := l.Clone()
	next.Entries = append(next.Entries, StopEntry{Request: r, Phase: StopAdmissionIntent})
	if !next.Valid() {
		return StopLedger{}, false, ErrStopRefused
	}
	return next, true, nil
}

// Update accepts only a single original next phase. Repeating an intent or ACK
// is observation-only and cannot produce a fresh effect permit.
func (l StopLedger) Update(id string, next StopEntry) (StopLedger, error) {
	if !l.Valid() || !next.Valid() || next.Request.OperationID != id {
		return StopLedger{}, ErrStopRefused
	}
	out := l.Clone()
	for i, old := range out.Entries {
		if old.Request.OperationID != id {
			continue
		}
		if old.Request != next.Request || old.Terminal() || old.Phase == StopUnresolved {
			return StopLedger{}, ErrStopRefused
		}
		if next.Phase == StopRefusedBeforeDispatch {
			if old.Phase != StopAdmissionIntent {
				return StopLedger{}, ErrStopRefused
			}
		} else if next.Phase == StopUnresolved {
			if next.UnresolvedAt != old.Phase {
				return StopLedger{}, ErrStopRefused
			}
		} else if stopRank(next.Phase) != stopRank(old.Phase)+1 {
			return StopLedger{}, ErrStopRefused
		}
		if old.Closure != nil && (next.Closure == nil || *old.Closure != *next.Closure) {
			return StopLedger{}, ErrStopRefused
		}
		if old.SettingsIntent != nil && (next.SettingsIntent == nil || *old.SettingsIntent != *next.SettingsIntent) {
			return StopLedger{}, ErrStopRefused
		}
		if old.SettingsAck != nil && (next.SettingsAck == nil || *old.SettingsAck != *next.SettingsAck) {
			return StopLedger{}, ErrStopRefused
		}
		if old.CleanupAck != nil && (next.CleanupAck == nil || *old.CleanupAck != *next.CleanupAck) {
			return StopLedger{}, ErrStopRefused
		}
		out.Entries[i] = next.Clone()
		if !out.Valid() {
			return StopLedger{}, ErrStopRefused
		}
		return out, nil
	}
	return StopLedger{}, ErrStopRefused
}
func (e StopEntry) Certificate() (StopCertificate, error) {
	if !e.Valid() || e.Phase != StopComplete {
		return StopCertificate{}, ErrStopRefused
	}
	return StopCertificate{Request: e.Request, Closure: *e.Closure, Settings: *e.SettingsAck, Cleanup: *e.CleanupAck}, nil
}
