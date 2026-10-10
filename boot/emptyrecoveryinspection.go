package boot

import (
	"context"
	"errors"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/emptyrecovery"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/app/services/interruptedretirement"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

type emptyRecoveryInspectionInput struct {
	Profile             ProfileBinding
	Selection           chatport.EmptyRecoverySelection
	OwnerID, ComputerID string
	AccessDigest        [32]byte
	Mutations           []mutationrepo.ExpectedSettledRecord
	Interrupted         *interruptedRetirementInput `json:",omitempty"`
	UnacknowledgedDev   bool                        `json:",omitempty"`
	InstalledEmpty      bool                        `json:",omitempty"`
}

type interruptedRetirementInput struct {
	OriginalHandoffID string
	ExpectedACKDigest [32]byte
}

type emptyRecoveryInspection struct {
	Plan                 chatport.EmptyRecoveryPlan
	Computer, Chat, Task NativeRoot
	Access               accessrepo.ClosedInspection
	Retained             mutationrepo.SettledInspection
	InterruptedRetained  *mutationrepo.InterruptedChatSettledInspection
	EmptyRetained        *mutationrepo.EmptyInspection
	HandoffSteps         int
}

type emptyRecoveryRecordValidator struct{}

func (emptyRecoveryRecordValidator) Validate(r chatport.HandoffRecord) error {
	return handoff.ValidateRecord(r)
}

// One composite READ-ONLY observation, not process-closure or maintenance
// authorization. Exact locks stay held in access -> handoff -> lifecycle ->
// results -> mutation order through the visitor and every final recheck. A full
// fixed namespace inventory is mandatory; empty snapshots alone are insufficient.
func inspectEmptyRecovery(ctx context.Context, in emptyRecoveryInspectionInput, visit func(emptyRecoveryInspection) error) (resultErr error) {
	if visit == nil {
		return emptyrecovery.Refused
	}
	return withEmptyRecoveryClaims(ctx, in, func(v emptyRecoveryInspection, _ *emptyRecoveryChatClaims) error { return visit(v) })
}

// Only trusted maintenance composition receives the retained claims. Ordinary
// inspection exposes observations only and always rechecks the original paths.
type emptyRecoveryChatClaims struct {
	h         *handoffrepo.ClosedLease
	l         *lifecyclerepo.ClosedLease
	r         *results.ClosedLease
	preserved *emptyRecoveryPreservation
}

func withEmptyRecoveryClaims(ctx context.Context, in emptyRecoveryInspectionInput, visit func(emptyRecoveryInspection, *emptyRecoveryChatClaims) error) (resultErr error) {
	if in.InstalledEmpty && (in.UnacknowledgedDev || in.Interrupted != nil || !emptyRecoveryInstalledRoot(in.Profile.Root) || len(in.Mutations) != 0) {
		return emptyrecovery.Refused
	}
	if in.UnacknowledgedDev && (in.Interrupted != nil || !emptyRecoveryDevRoot(in.Profile.Root)) {
		return emptyrecovery.Refused
	}
	if ctx == nil || ctx.Err() != nil || visit == nil || !validProfileBinding(in.Profile) || !validIngressID(in.OwnerID) || !validIngressID(in.ComputerID) || in.Selection.BuildID != BuildID || in.Selection.Current.ProfileID != in.Profile.ProfileID || in.Selection.Current.ParentRoot.Device != in.Profile.Device || in.Selection.Current.ParentRoot.Inode != in.Profile.Inode {
		return emptyrecovery.Refused
	}
	qualified, err := QualifyProfile(in.Profile)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, qualified.Close()) }()
	computer, chat, err := qualified.Roots()
	if err != nil {
		return err
	}
	task, err := qualified.TaskRoot()
	if err != nil {
		return err
	}
	chatIdentity := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	if chatIdentity != in.Selection.Current.ChatRoot {
		return emptyrecovery.Refused
	}
	scope := chatport.JournalScope{ProfileID: in.Profile.ProfileID, BackendGeneration: in.Selection.Current.BackendGeneration}
	return withEmptyRecoveryTask(ctx, task, func() error {
		return accessrepo.WithClosedInspection(ctx, computer.Path, accessrepo.Binding{ProfileID: in.Profile.ProfileID, OwnerID: in.OwnerID, ComputerID: in.ComputerID}, in.AccessDigest, func(access accessrepo.ClosedInspection) (resultErr error) {
			acquireHandoff := handoffrepo.AcquireClosedInspection
			acquireLifecycle := lifecyclerepo.AcquireClosedInspection
			if in.Interrupted != nil {
				acquireHandoff = handoffrepo.AcquireInterruptedRetirementInspection
				acquireLifecycle = lifecyclerepo.AcquireInterruptedRetirementInspection
			}
			h, err := acquireHandoff(ctx, handoffRoots(NativeLaunch{Profile: in.Profile}, chat), scope)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, h.Close()) }()
			l, err := acquireLifecycle(ctx, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, scope, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, l.Close()) }()
			r, err := results.AcquireClosedInspection(ctx, results.Root{Path: chat.Path, ProfileID: chat.ProfileID, Identity: chatIdentity}, scope)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, r.Close()) }()
			claims := &emptyRecoveryChatClaims{h: h, l: l, r: r}
			hv, err := h.Observation()
			if err != nil {
				return err
			}
			lv, err := l.Observation()
			if err != nil {
				return err
			}
			rv, err := r.Observation()
			if err != nil {
				return err
			}
			if hv.Head == nil {
				return emptyrecovery.Refused
			}
			observation := chatport.EmptyRecoveryObservation{Head: *hv.Head, Scope: lv.Scope, Root: lv.Root, LifecycleDigest: lv.SnapshotDigest, Incarnations: lv.Incarnations, ResultsRoot: rv.Root, ResultsStorageRoot: rv.StorageRoot, ResultCount: rv.ResultCount, RetirementPresent: lv.Retirement != nil}
			var plan *chatport.EmptyRecoveryPlan
			if in.Interrupted == nil {
				plan, err = emptyrecovery.Select(in.Selection, observation, emptyRecoveryRecordValidator{})
			} else {
				plan, err = interruptedretirement.Select(chatport.InterruptedRetirementSelection{EmptyRecoverySelection: in.Selection, OriginalHandoffID: in.Interrupted.OriginalHandoffID, ExpectedACKDigest: in.Interrupted.ExpectedACKDigest}, chatport.InterruptedRetirementObservation{EmptyRecoveryObservation: observation, Retirement: lv.Retirement}, emptyRecoveryRecordValidator{})
			}
			if err != nil {
				return err
			}
			verify := func() error {
				if ctx.Err() != nil {
					return emptyrecovery.Refused
				}
				if claims.preserved != nil {
					return verifyEmptyRecoveryPreservation(ctx, in.Profile, computer, task, claims.preserved)
				}
				c, ch, e := qualified.Roots()
				if e != nil || c != computer || ch != chat {
					return emptyrecovery.Refused
				}
				t, e := qualified.TaskRoot()
				if e != nil || t != task {
					return emptyrecovery.Refused
				}
				if e = errors.Join(h.Verify(), l.Verify(), r.Verify()); e != nil {
					return e
				}
				return inspectEmptyRecoveryNamespaces(ctx, computer, chat, task, len(hv.Stages))
			}
			if err := verify(); err != nil {
				return err
			}
			if in.InstalledEmpty {
				return mutationrepo.WithClosedEmptyInspection(ctx, mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}, func(retained mutationrepo.EmptyInspection) error {
					if err := verify(); err != nil {
						return err
					}
					callbackErr := visit(emptyRecoveryInspection{Plan: *plan, Computer: computer, Chat: chat, Task: task, Access: access, EmptyRetained: &retained, HandoffSteps: len(hv.Stages)}, claims)
					return errors.Join(callbackErr, verify())
				})
			}
			// Explicit Dev recovery reuses the same exact known five-result guard.
			// Ordinary exact-two Completed qualification is unchanged.
			if in.Interrupted != nil || in.UnacknowledgedDev {
				_, err = mutationrepo.InspectInterruptedChatSettled(ctx, mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}, mutationrepo.SettledSelection{OwnerID: in.OwnerID, ProfileID: in.Profile.ProfileID, ComputerID: in.ComputerID}, in.Mutations, func(retained mutationrepo.InterruptedChatSettledInspection) error {
					if err := verify(); err != nil {
						return err
					}
					callbackErr := visit(emptyRecoveryInspection{Plan: *plan, Computer: computer, Chat: chat, Task: task, Access: access, InterruptedRetained: &retained, HandoffSteps: len(hv.Stages)}, claims)
					return errors.Join(callbackErr, verify())
				})
				return err
			}
			_, err = mutationrepo.InspectSettled(ctx, mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}, mutationrepo.SettledSelection{OwnerID: in.OwnerID, ProfileID: in.Profile.ProfileID, ComputerID: in.ComputerID}, in.Mutations, func(retained mutationrepo.SettledInspection) error {
				if err := verify(); err != nil {
					return err
				}
				callbackErr := visit(emptyRecoveryInspection{Plan: *plan, Computer: computer, Chat: chat, Task: task, Access: access, Retained: retained, HandoffSteps: len(hv.Stages)}, claims)
				return errors.Join(callbackErr, verify())
			})
			return err
		})
	})
}
