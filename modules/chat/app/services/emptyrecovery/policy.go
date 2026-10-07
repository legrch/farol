// Package emptyrecovery selects a bounded empty-storage maintenance operation.
// It never manufactures retirement, restores a handle or authorizes provider IO.
package emptyrecovery

import (
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const Refused Code = "CHAT_EMPTY_RECOVERY_REFUSED"

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

// Select compares a previously selected exact failed incarnation with current
// canonical observations. Its success is only one prerequisite: native locks,
// process absence, enclosing profile lease, Computer settlement and durable
// preservation are still required before an effect. Historical terminal/ACK
// fields do not establish the closure of the consumed successor.
func Select(s port.EmptyRecoverySelection, o port.EmptyRecoveryObservation, validator port.EmptyRecoveryRecordValidator) (*port.EmptyRecoveryPlan, error) {
	b := s.Current
	if !operation(s.OperationID) || !id(b.ProfileID) || !id(b.BackendGeneration) || !id(b.BuildID) || !id(b.HostLifetimeID) || !id(b.ChildLaunchID) || !root(b.ParentRoot) || !root(b.ChatRoot) || b.ParentRoot == b.ChatRoot || b.ParentRoot.Device != b.ChatRoot.Device || b.ParentRoot.OwnerUID != b.ChatRoot.OwnerUID || s.HeadDigest == ([32]byte{}) || s.LifecycleDigest == ([32]byte{}) || !id(s.BuildID) || !id(s.HostLifetimeID) || !id(s.ChildLaunchID) || s.HostLifetimeID == b.HostLifetimeID || s.ChildLaunchID == b.ChildLaunchID || s.Next.ProfileID != b.ProfileID || !id(s.Next.BackendGeneration) || s.Next.BackendGeneration == b.BackendGeneration {
		return nil, Refused
	}
	h := o.Head
	if h.Record == nil || validator == nil || h.Digest != s.HeadDigest || !h.EmptyRetirementChain || validator.Validate(copyRecord(*h.Record)) != nil || h.Record.Stage != port.HandoffConsumed || h.Record.Consumption == nil || h.Record.Consumption.NextBinding != b || h.Record.Consumption.Next != o.Scope || o.Scope != (port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}) || o.Root != b.ChatRoot || o.LifecycleDigest != s.LifecycleDigest || o.WriteCount != 0 || o.TurnCount != 0 || o.RetirementPresent || o.ResultCount != 0 || o.ResultsRoot != b.ChatRoot || !root(o.ResultsStorageRoot) || o.ResultsStorageRoot == b.ChatRoot || o.ResultsStorageRoot.Device != b.ChatRoot.Device || o.ResultsStorageRoot.OwnerUID != b.ChatRoot.OwnerUID {
		return nil, Refused
	}
	// Preserve incarnation tombstones and refuse reuse even from an earlier
	// empty cycle. A current empty snapshot does not erase historical identity.
	if len(o.Incarnations) == 0 || len(o.Incarnations) > 4096 || o.Incarnations[len(o.Incarnations)-1] != b.BackendGeneration {
		return nil, Refused
	}
	seen := make(map[string]bool, len(o.Incarnations))
	for _, generation := range o.Incarnations {
		if !id(generation) || seen[generation] || generation == s.Next.BackendGeneration {
			return nil, Refused
		}
		seen[generation] = true
	}
	return &port.EmptyRecoveryPlan{Selection: s, ArchiveName: "chat-retired-" + s.OperationID}, nil
}

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
