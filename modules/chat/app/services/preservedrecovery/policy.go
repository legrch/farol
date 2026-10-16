// Package preservedrecovery selects metadata for later closed maintenance and
// preservation of nonempty original Chat. It performs no recovery or effects.
package preservedrecovery

import (
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const Refused Code = "CHAT_PRESERVED_RECOVERY_REFUSED"

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

func sameObject(a, b port.JournalRoot) bool {
	return a.Device == b.Device && a.Inode == b.Inode
}

// Select compares independently selected metadata with canonical observations.
// Locks, complete canonical scans, exact native maintenance/process exclusion,
// whole-profile custody and a new real owner's ACK/terminal remain prerequisites
// of the enclosing maintenance. Historical retirement and unresolved results
// settle nothing, and this plan cannot authorize recovery or current admission.
func Select(s port.PreservedRecoverySelection, o port.PreservedRecoveryObservation) (*port.PreservedRecoveryPlan, error) {
	b := s.Current
	if !operation(s.OperationID) || !id(b.Scope.ProfileID) || !id(b.Scope.BackendGeneration) || !id(s.Next.ProfileID) || !id(s.Next.BackendGeneration) || !id(s.BuildID) || !id(s.HostLifetimeID) || !id(s.ChildLaunchID) || s.Next.ProfileID != b.Scope.ProfileID || s.Next.BackendGeneration == b.Scope.BackendGeneration {
		return nil, Refused
	}
	if !root(b.ParentRoot) || !root(b.ChatRoot) || sameObject(b.ParentRoot, b.ChatRoot) || b.ParentRoot.Device != b.ChatRoot.Device || b.ParentRoot.OwnerUID != b.ChatRoot.OwnerUID || o.ParentRoot != b.ParentRoot || o.ChatRoot != b.ChatRoot || o.ResultsRoot != b.ChatRoot || !root(o.ResultsStorageRoot) || sameObject(o.ResultsStorageRoot, b.ChatRoot) || o.ResultsStorageRoot.Device != b.ChatRoot.Device || o.ResultsStorageRoot.OwnerUID != b.ChatRoot.OwnerUID || o.Scope != b.Scope {
		return nil, Refused
	}
	if s.LifecycleDigest == ([32]byte{}) || s.ResultsDigest == ([32]byte{}) || o.HandoffDigest != s.HandoffDigest || o.LifecycleDigest != s.LifecycleDigest || o.ResultsDigest != s.ResultsDigest || o.HandoffSteps < 0 || o.HandoffSteps > 1024 || (o.HandoffSteps == 0) != (s.HandoffDigest == ([32]byte{})) {
		return nil, Refused
	}
	// Validate each bound before checking presence; do not sum untrusted counts.
	for _, count := range [...]int{o.WriteCount, o.TurnCount, o.PlanCount, o.ResultCount} {
		if count < 0 || count > 4096 {
			return nil, Refused
		}
	}
	if o.WriteCount == 0 && o.TurnCount == 0 && o.PlanCount == 0 && o.ResultCount == 0 && !o.ResultsUnresolved {
		return nil, Refused
	}
	if len(o.Incarnations) == 0 || len(o.Incarnations) > 4096 || o.Incarnations[len(o.Incarnations)-1] != b.Scope.BackendGeneration {
		return nil, Refused
	}
	seen := make(map[string]bool, len(o.Incarnations))
	for _, generation := range o.Incarnations {
		if !id(generation) || seen[generation] || generation == s.Next.BackendGeneration {
			return nil, Refused
		}
		seen[generation] = true
	}
	return &port.PreservedRecoveryPlan{
		Selection:                s,
		ArchiveName:              "chat-retired-" + s.OperationID,
		RetainsUnresolvedResults: o.ResultsUnresolved,
	}, nil
}
