// Package emptyrecovery selects a bounded empty-storage maintenance operation.
// It never manufactures retirement, restores a handle or authorizes provider IO.
package emptyrecovery

import (
	opaque "github.com/legrch/farol/pkg/kernel/domain/id"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const Refused Code = "CHAT_EMPTY_RECOVERY_REFUSED"

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

// Select compares a previously selected exact failed incarnation with current
// canonical observations. Its success is only one prerequisite: native locks,
// process absence, enclosing profile lease, Computer settlement and durable
// preservation are still required before an effect. Historical terminal/ACK
// fields do not establish the closure of the consumed successor.
func Select(s port.EmptyRecoverySelection, o port.EmptyRecoveryObservation, validator port.EmptyRecoveryRecordValidator) (*port.EmptyRecoveryPlan, error) {
	b := s.Current
	if !operation(s.OperationID) || !opaque.Valid(b.ProfileID) || !opaque.Valid(b.BackendGeneration) || !opaque.Valid(b.BuildID) || !opaque.Valid(b.HostLifetimeID) || !opaque.Valid(b.ChildLaunchID) || !b.ParentRoot.Valid() || !b.ChatRoot.Valid() || b.ParentRoot == b.ChatRoot || b.ParentRoot.Device != b.ChatRoot.Device || b.ParentRoot.OwnerUID != b.ChatRoot.OwnerUID || s.HeadDigest == ([32]byte{}) || s.LifecycleDigest == ([32]byte{}) || !opaque.Valid(s.BuildID) || !opaque.Valid(s.HostLifetimeID) || !opaque.Valid(s.ChildLaunchID) || s.HostLifetimeID == b.HostLifetimeID || s.ChildLaunchID == b.ChildLaunchID || s.Next.ProfileID != b.ProfileID || !opaque.Valid(s.Next.BackendGeneration) || s.Next.BackendGeneration == b.BackendGeneration {
		return nil, Refused
	}
	h := o.Head
	if h.Record == nil || validator == nil || h.Digest != s.HeadDigest || !h.EmptyRetirementChain || validator.Validate(copyRecord(*h.Record)) != nil || h.Record.Stage != port.HandoffConsumed || h.Record.Consumption == nil || h.Record.Consumption.NextBinding != b || h.Record.Consumption.Next != o.Scope || o.Scope != (port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}) || o.Root != b.ChatRoot || o.LifecycleDigest != s.LifecycleDigest || o.WriteCount != 0 || o.TurnCount != 0 || o.RetirementPresent || o.ResultCount != 0 || o.ResultsRoot != b.ChatRoot || !o.ResultsStorageRoot.Valid() || o.ResultsStorageRoot == b.ChatRoot || o.ResultsStorageRoot.Device != b.ChatRoot.Device || o.ResultsStorageRoot.OwnerUID != b.ChatRoot.OwnerUID {
		return nil, Refused
	}
	// Preserve incarnation tombstones and refuse reuse even from an earlier
	// empty cycle. A current empty snapshot does not erase historical identity.
	if len(o.Incarnations) == 0 || len(o.Incarnations) > 4096 || o.Incarnations[len(o.Incarnations)-1] != b.BackendGeneration {
		return nil, Refused
	}
	seen := make(map[string]bool, len(o.Incarnations))
	for _, generation := range o.Incarnations {
		if !opaque.Valid(generation) || seen[generation] || generation == s.Next.BackendGeneration {
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
