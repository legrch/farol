package boot

import (
	archivepolicy "github.com/legrch/farol/modules/chat/app/capabilities/archive"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/emptyrecovery"
)

// Route canonical empty consumed history through the existing empty policy.
// This selects only archive metadata under the same retained native claims;
// process exclusion, durable intent and a new real ACK/terminal remain separate.
func selectPreservedProfilePlan(s chatport.PreservedRecoverySelection, o chatport.PreservedRecoveryObservation, head *chatport.HandoffHead) (*chatport.PreservedRecoveryPlan, error) {
	if o.WriteCount != 0 || o.TurnCount != 0 || o.PlanCount != 0 || o.ResultCount != 0 || o.ResultsUnresolved {
		return (archivepolicy.Policy{}).Select(s, o)
	}
	// The empty policy validates consumed history and lifetime uniqueness. Keep
	// the enclosing selection's additional complete-results/stage comparisons.
	if head == nil || head.Record == nil || head.Record.Consumption == nil || o.HandoffSteps < 1 || o.HandoffSteps > 1024 || s.HandoffDigest != o.HandoffDigest || s.LifecycleDigest != o.LifecycleDigest || s.ResultsDigest == ([32]byte{}) || s.ResultsDigest != o.ResultsDigest || s.Current.Scope != o.Scope || s.Current.ParentRoot != o.ParentRoot || s.Current.ChatRoot != o.ChatRoot {
		return nil, archivepolicy.Refused
	}
	e := chatport.EmptyRecoverySelection{OperationID: s.OperationID, Current: head.Record.Consumption.NextBinding, HeadDigest: s.HandoffDigest, LifecycleDigest: s.LifecycleDigest, Next: s.Next, BuildID: s.BuildID, HostLifetimeID: s.HostLifetimeID, ChildLaunchID: s.ChildLaunchID}
	v := chatport.EmptyRecoveryObservation{Head: *head, Scope: o.Scope, Root: o.ChatRoot, LifecycleDigest: o.LifecycleDigest, Incarnations: o.Incarnations, WriteCount: o.WriteCount, TurnCount: o.TurnCount, RetirementPresent: o.RetirementPresent, ResultsRoot: o.ResultsRoot, ResultsStorageRoot: o.ResultsStorageRoot, ResultCount: o.ResultCount}
	if e.Current.ParentRoot != s.Current.ParentRoot || e.Current.ChatRoot != s.Current.ChatRoot {
		return nil, archivepolicy.Refused
	}
	plan, err := emptyrecovery.Select(e, v, emptyRecoveryRecordValidator{})
	if err != nil {
		return nil, err
	}
	return &chatport.PreservedRecoveryPlan{Selection: s, ArchiveName: plan.ArchiveName}, nil
}
