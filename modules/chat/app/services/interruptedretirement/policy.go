// Package interruptedretirement selects preservation of an exact empty retired
// Chat incarnation with a known ACK and unknown terminal. It performs no IO,
// invents no terminal and cannot supply CleanRetirement or replay authority.
package interruptedretirement

import (
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const Refused Code = "CHAT_INTERRUPTED_RETIREMENT_REFUSED"

func id(s string) bool {
	return len(s) > 0 && len(s) <= 120 && utf8.ValidString(s) && strings.IndexFunc(s, func(r rune) bool { return r <= 32 || r == 127 }) < 0
}

func operation(s string) bool {
	if len(s) != 36 {
		return false
	}
	for n, c := range s {
		if n == 8 || n == 13 || n == 18 || n == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= 'a' && c <= 'f' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func root(r port.JournalRoot) bool { return r.Device != 0 && r.Inode != 0 }

func selection(s port.InterruptedRetirementSelection) bool {
	b := s.Current
	if s.OperationID == s.OriginalHandoffID {
		return false
	}
	return operation(s.OperationID) && id(b.ProfileID) && id(b.BackendGeneration) && id(b.BuildID) && id(b.HostLifetimeID) && id(b.ChildLaunchID) && root(b.ParentRoot) && root(b.ChatRoot) && b.ParentRoot != b.ChatRoot && b.ParentRoot.Device == b.ChatRoot.Device && b.ParentRoot.OwnerUID == b.ChatRoot.OwnerUID && s.HeadDigest != ([32]byte{}) && s.LifecycleDigest != ([32]byte{}) && id(s.OriginalHandoffID) && s.ExpectedACKDigest == s.HeadDigest && id(s.BuildID) && id(s.HostLifetimeID) && id(s.ChildLaunchID) && s.HostLifetimeID != b.HostLifetimeID && s.ChildLaunchID != b.ChildLaunchID && s.Next.ProfileID == b.ProfileID && id(s.Next.BackendGeneration) && s.Next.BackendGeneration != b.BackendGeneration
}

func incarnations(used []string, current, next string) bool {
	if len(used) == 0 || len(used) > 4096 || used[len(used)-1] != current {
		return false
	}
	seen := make(map[string]bool, len(used))
	for _, generation := range used {
		if !id(generation) || seen[generation] || generation == next {
			return false
		}
		seen[generation] = true
	}
	return true
}

// Select admits only preservation of the exact selected original incarnation.
// The old ACK and unknown terminal remain unchanged in an archive. A separate
// fresh live owner must produce its own retirement; this plan cannot retire it.
// Native leases, full profile inventory, process closure, Computer preservation
// and effect execution remain prerequisites owned by trusted composition.
func Select(s port.InterruptedRetirementSelection, o port.InterruptedRetirementObservation, validator port.EmptyRecoveryRecordValidator) (*port.EmptyRecoveryPlan, error) {
	if !selection(s) || validator == nil {
		return nil, Refused
	}
	b, h := s.Current, o.Head
	scope := port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
	if h.Record == nil || h.Digest != s.HeadDigest || h.Digest != s.ExpectedACKDigest || !h.EmptyRetirementChain {
		return nil, Refused
	}
	r := h.Record
	if validator.Validate(copyRecord(*r)) != nil || r.Stage != port.HandoffAcknowledged || r.Origin != port.HandoffLiveOwner || r.Publication.Binding != b || r.Publication.HandoffID != s.OriginalHandoffID || r.ACK == nil || r.ACK.Publication != r.Publication || r.Terminal != nil || r.Consumption != nil {
		return nil, Refused
	}
	if o.Scope != scope || o.Root != b.ChatRoot || o.LifecycleDigest != s.LifecycleDigest || o.WriteCount != 0 || o.TurnCount != 0 || !o.RetirementPresent || o.Retirement == nil || o.ResultCount != 0 || o.ResultsRoot != b.ChatRoot || !root(o.ResultsStorageRoot) || o.ResultsStorageRoot == b.ChatRoot || o.ResultsStorageRoot.Device != b.ChatRoot.Device || o.ResultsStorageRoot.OwnerUID != b.ChatRoot.OwnerUID {
		return nil, Refused
	}
	w := o.Retirement
	if w.Scope != scope || w.Root != b.ChatRoot || w.PreviousRevision != 0 || w.Revision != 1 || w.Turns == nil || len(w.Turns) != 0 || !port.SameRetirement(*w, r.Receipt.Write) || r.Receipt.PublicationDigest != o.LifecycleDigest || r.Publication.ReceiptDigest != o.LifecycleDigest || !incarnations(o.Incarnations, b.BackendGeneration, s.Next.BackendGeneration) {
		return nil, Refused
	}
	return &port.EmptyRecoveryPlan{Selection: s.EmptyRecoverySelection, ArchiveName: "chat-retired-" + s.OperationID}, nil
}

// The injected record owner receives independent values, never observation
// pointers. No neighboring application service or second codec is imported.
func copyRecord(r port.HandoffRecord) port.HandoffRecord {
	r.Receipt.Write = port.CopyRetirement(r.Receipt.Write)
	if r.ACK != nil {
		a := *r.ACK
		r.ACK = &a
	}
	if r.Terminal != nil {
		t := *r.Terminal
		if t.ExitCode != nil {
			n := *t.ExitCode
			t.ExitCode = &n
		}
		r.Terminal = &t
	}
	if r.Consumption != nil {
		c := *r.Consumption
		r.Consumption = &c
	}
	return r
}
