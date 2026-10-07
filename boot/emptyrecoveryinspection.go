package boot

import (
	"context"
	"errors"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/emptyrecovery"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
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
}

type emptyRecoveryInspection struct {
	Plan                 chatport.EmptyRecoveryPlan
	Computer, Chat, Task NativeRoot
	Access               accessrepo.ClosedInspection
	Retained             mutationrepo.SettledInspection
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
			h, err := handoffrepo.AcquireClosedInspection(ctx, handoffRoots(NativeLaunch{Profile: in.Profile}, chat), scope)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, h.Close()) }()
			l, err := lifecyclerepo.AcquireClosedInspection(ctx, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, scope, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
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
			plan, err := emptyrecovery.Select(in.Selection, chatport.EmptyRecoveryObservation{Head: *hv.Head, Scope: lv.Scope, Root: lv.Root, LifecycleDigest: lv.SnapshotDigest, Incarnations: lv.Incarnations, ResultsRoot: rv.Root, ResultsStorageRoot: rv.StorageRoot, ResultCount: rv.ResultCount}, emptyRecoveryRecordValidator{})
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
