package boot

import (
	"context"
	"errors"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// Trusted composition selects the original publication/ACK and the complete
// exact-two mutation set independently. Persisted records cannot discover or
// enlarge this selection. No field conveys host closure or restore authority.
type terminatedProfileInspectionInput struct {
	Profile             ProfileBinding
	Publication         chatport.HandoffPublication
	KnownACKDigest      [32]byte
	OwnerID, ComputerID string
	AccessDigest        [32]byte
	Mutations           []mutationrepo.ExpectedSettledRecord
}

// Metadata only. In particular, neither a retirement receipt, an origin proof,
// a successor, nor a process-drain assertion is exposed to the visitor.
type terminatedProfileInspection struct {
	Scope                chatport.JournalScope
	Computer, Chat, Task NativeRoot
	Access               accessrepo.ClosedInspection
	Retained             mutationrepo.SettledInspection
	HandoffDigest        [32]byte
	HandoffSteps         int
	LifecycleDigest      [32]byte
	ResultClaimDigest    [32]byte
}

func terminatedProfileInputValid(in terminatedProfileInspectionInput) bool {
	b := in.Publication.Binding
	for _, id := range []string{in.OwnerID, in.ComputerID, b.ProfileID, b.BackendGeneration, b.BuildID, b.HostLifetimeID, b.ChildLaunchID, in.Publication.HandoffID} {
		if !validIngressID(id) {
			return false
		}
	}
	return validProfileBinding(in.Profile) && b.BuildID == BuildID && b.ProfileID == in.Profile.ProfileID &&
		b.ParentRoot.Device == in.Profile.Device && b.ParentRoot.Inode == in.Profile.Inode &&
		b.ChatRoot.Device == b.ParentRoot.Device && b.ChatRoot.Inode != 0 && b.ChatRoot != b.ParentRoot && b.ChatRoot.OwnerUID == b.ParentRoot.OwnerUID &&
		in.Publication.ReceiptDigest != ([32]byte{}) && in.KnownACKDigest != ([32]byte{}) && in.AccessDigest != ([32]byte{}) && len(in.Mutations) == 2
}

// The module scanners supply canonical observations under their original claims.
// This predicate only joins them to the independently selected original facts.
func terminatedProfileObservationsMatch(in terminatedProfileInspectionInput, chat NativeRoot, h handoffrepo.ClosedInspection, l lifecyclerepo.ClosedInspection, r results.ClosedInspection) bool {
	b := in.Publication.Binding
	scope := chatport.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
	root := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	if !terminatedProfileInputValid(in) || chat.ProfileID != b.ProfileID || root != b.ChatRoot || h.Scope != scope || h.ParentRoot != b.ParentRoot || h.ChatRoot != root ||
		h.Publication != in.Publication || h.HeadStage != chatport.HandoffTerminated || h.NextBinding != (chatport.HandoffBinding{}) || h.AttemptID != "" ||
		h.Head == nil || h.Head.Record == nil || !h.Head.EmptyRetirementChain || h.Head.Digest != h.HeadDigest || h.HeadDigest == ([32]byte{}) || len(h.Stages) < 3 || len(h.Stages) > 1024 || len(h.Stages)%4 != 3 {
		return false
	}
	record := h.Head.Record
	if handoff.ValidateRecord(*record) != nil || record.Stage != chatport.HandoffTerminated || record.Publication != in.Publication || record.Terminal.KnownACKDigest != in.KnownACKDigest || record.Consumption != nil ||
		l.Scope != scope || l.Root != root || l.Retirement == nil || l.Revision != 1 || l.SnapshotDigest != in.Publication.ReceiptDigest ||
		!chatport.SameRetirement(record.Receipt.Write, *l.Retirement) || len(l.Incarnations) != (len(h.Stages)+1)/4 || l.Incarnations[len(l.Incarnations)-1] != scope.BackendGeneration ||
		r.Scope != scope || r.Root != root || r.ResultCount != 0 || r.ClaimDigest == ([32]byte{}) || r.StorageRoot.Device != root.Device || r.StorageRoot.Inode == 0 || r.StorageRoot == root || r.StorageRoot.OwnerUID != root.OwnerUID {
		return false
	}
	return true
}

// Observe one existing normally terminated, completely empty Chat history and
// exact settled File outcomes. The existing task-directory pin, access lock,
// handoff/lifecycle/results claims and mutation writer lock span the synchronous
// visitor and every final recheck. Opening owners, Consume, recovery preparation,
// settings writes, profile replacement and helper dispatch are absent.
//
// The visitor is trusted observation code, not an effect callback. It must not
// change inspected roots/journals, reenter their owners or defer work. A successful
// return attests storage only; independently known host closure, current Settings
// bytes, exact app pair and original update authority remain separate gates.
func inspectTerminatedProfile(ctx context.Context, in terminatedProfileInspectionInput, visit func(terminatedProfileInspection) error) (resultErr error) {
	if ctx == nil || ctx.Err() != nil || visit == nil || !terminatedProfileInputValid(in) {
		return handoff.Refused
	}
	in.Mutations = append([]mutationrepo.ExpectedSettledRecord(nil), in.Mutations...)
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
	b := in.Publication.Binding
	if (chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}) != b.ChatRoot || chat.OwnerUID != b.ParentRoot.OwnerUID {
		return handoff.Refused
	}
	scope := chatport.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}
	return withEmptyRecoveryTask(ctx, task, func() error {
		return accessrepo.WithClosedInspection(ctx, computer.Path, accessrepo.Binding{ProfileID: in.Profile.ProfileID, OwnerID: in.OwnerID, ComputerID: in.ComputerID}, in.AccessDigest, func(access accessrepo.ClosedInspection) (resultErr error) {
			h, err := handoffrepo.AcquireTerminatedRetirementInspection(ctx, handoffRoots(NativeLaunch{Profile: in.Profile}, chat), scope)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, h.Close()) }()
			// Reuse the existing retired-empty inspector. Its name describes the
			// accepted snapshot shape; it supplies no interrupted-recovery action.
			l, err := lifecyclerepo.AcquireInterruptedRetirementInspection(ctx, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, scope, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, l.Close()) }()
			r, err := results.AcquireClosedInspection(ctx, results.Root{Path: chat.Path, ProfileID: chat.ProfileID, Identity: b.ChatRoot}, scope)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, r.Close()) }()
			hv, he := h.Observation()
			lv, le := l.Observation()
			rv, re := r.Observation()
			if err := errors.Join(he, le, re); err != nil {
				return err
			}
			if !terminatedProfileObservationsMatch(in, chat, hv, lv, rv) {
				return handoff.Refused
			}
			verify := func() error {
				c, ch, e := qualified.Roots()
				t, te := qualified.TaskRoot()
				if ctx.Err() != nil || e != nil || te != nil || c != computer || ch != chat || t != task {
					return handoff.Refused
				}
				if err := errors.Join(h.Verify(), l.Verify(), r.Verify()); err != nil {
					return err
				}
				return inspectEmptyRecoveryNamespaces(ctx, computer, chat, task, len(hv.Stages))
			}
			_, err = mutationrepo.InspectSettled(ctx, mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}, mutationrepo.SettledSelection{OwnerID: in.OwnerID, ProfileID: in.Profile.ProfileID, ComputerID: in.ComputerID}, in.Mutations, func(retained mutationrepo.SettledInspection) error {
				if err := verify(); err != nil {
					return err
				}
				callbackErr := visit(terminatedProfileInspection{Scope: scope, Computer: computer, Chat: chat, Task: task, Access: access, Retained: retained,
					HandoffDigest: hv.HeadDigest, HandoffSteps: len(hv.Stages), LifecycleDigest: lv.SnapshotDigest, ResultClaimDigest: rv.ClaimDigest})
				return errors.Join(callbackErr, verify())
			})
			return err
		})
	})
}
