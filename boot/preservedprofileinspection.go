package boot

import (
	"context"
	"errors"
	"time"

	archivepolicy "github.com/legrch/farol/modules/chat/app/capabilities/archive"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// A closed maintenance owner independently selects these comparisons before IO.
// None of the values supplies original process closure, effect success or current
// authority. The old empty/interrupted/installed recovery inputs stay separate.
type preservedProfileInspectionInput struct {
	Profile             ProfileBinding
	Selection           chatport.PreservedRecoverySelection
	OwnerID, ComputerID string
	AccessDigest        [32]byte
	Mutations           []mutationrepo.ExpectedOwnerRecord
}

type preservedProfileInspection struct {
	Plan                 chatport.PreservedRecoveryPlan
	Computer, Chat, Task NativeRoot
	Access               accessrepo.ClosedInspection
	Handoff              handoffrepo.PreservationInspection
	Lifecycle            lifecyclerepo.Inspection
	Results              results.PreservationInspection
	Mutations            *mutationrepo.OwnerInspection
	EmptyMutations       *mutationrepo.EmptyInspection
}

// The handles never leave trusted boot composition. Pure diagnostic visitors see
// only copied observations. A separately admitted native maintenance operation
// may record its fully verified physical archive after the exclusive rename;
// original path checks cannot be falsely claimed to pass after relocation.
type preservedProfileChatClaims struct {
	h              *handoffrepo.PreservationLease
	l              *lifecyclerepo.PreservationLease
	r              *results.PreservationLease
	preserved      *emptyRecoveryPreservation
	effectsStarted bool
	ctx            context.Context
	inventory      *preservedProfileInventory
}

func (c *preservedProfileChatClaims) verifyOriginal() error {
	if c == nil || c.h == nil || c.l == nil || c.r == nil {
		return archivepolicy.Refused
	}
	return errors.Join(c.h.Verify(), c.l.Verify(), c.r.Verify(), verifyPreservedProfileInventory(c.ctx, c.inventory, nil))
}

// Fix one original absolute budget before qualification or lock acquisition.
// Direct time comparison also catches expired contexts whose timer is delayed.
type preservedProfileContext struct {
	context.Context
	until time.Time
}

func (c preservedProfileContext) Deadline() (time.Time, bool) { return c.until, true }
func (c preservedProfileContext) Err() error {
	if err := c.Context.Err(); err != nil {
		return err
	}
	if !time.Now().Before(c.until) {
		return context.DeadlineExceeded
	}
	return nil
}

func bindPreservedProfileContext(ctx context.Context) (context.Context, error) {
	if ctx == nil {
		return nil, archivepolicy.Refused
	}
	if original, ok := ctx.(preservedProfileContext); ok {
		if original.Err() != nil {
			return nil, archivepolicy.Refused
		}
		return original, nil
	}
	until, ok := ctx.Deadline()
	if !ok || until.IsZero() {
		return nil, archivepolicy.Refused
	}
	bounded := preservedProfileContext{Context: ctx, until: until}
	if bounded.Err() != nil {
		return nil, archivepolicy.Refused
	}
	return bounded, nil
}

func inspectPreservedProfile(ctx context.Context, in preservedProfileInspectionInput, visit func(preservedProfileInspection) error) error {
	if visit == nil {
		return archivepolicy.Refused
	}
	return withPreservedProfileClaims(ctx, in, func(v preservedProfileInspection, _ *preservedProfileChatClaims) error { return visit(v) })
}

// Retain the complete task namespace and exact access -> handoff -> lifecycle ->
// results -> mutation lock order. All canonical scanners and original policies
// remain owned by their repositories. This observation supplies no maintenance
// or process authority; the initiating native host must own those separately.
func withPreservedProfileClaims(ctx context.Context, in preservedProfileInspectionInput, visit func(preservedProfileInspection, *preservedProfileChatClaims) error) (resultErr error) {
	if ctx == nil || visit == nil {
		return archivepolicy.Refused
	}
	var err error
	ctx, err = bindPreservedProfileContext(ctx)
	if err != nil {
		return err
	}
	in.Mutations = append([]mutationrepo.ExpectedOwnerRecord(nil), in.Mutations...)
	if ctx.Err() != nil || !validProfileBinding(in.Profile) || !validIngressID(in.OwnerID) || !validIngressID(in.ComputerID) || in.Selection.BuildID != BuildID || in.Selection.Current.Scope.ProfileID != in.Profile.ProfileID || !validIngressID(in.Selection.Current.Scope.BackendGeneration) || len(in.Mutations) > 128 {
		return archivepolicy.Refused
	}
	qualified, err := QualifyProfile(in.Profile)
	if err != nil {
		return err
	}
	defer func() {
		resultErr = errors.Join(resultErr, qualified.Close())
		if ctx.Err() != nil {
			resultErr = errors.Join(resultErr, archivepolicy.Refused)
		}
	}()
	computer, chat, err := qualified.Roots()
	if err != nil {
		return err
	}
	task, err := qualified.TaskRoot()
	if err != nil {
		return err
	}
	identity := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	parent := chatport.JournalRoot{Device: in.Profile.Device, Inode: in.Profile.Inode, OwnerUID: chat.OwnerUID}
	if identity != in.Selection.Current.ChatRoot || parent != in.Selection.Current.ParentRoot {
		return archivepolicy.Refused
	}
	scope := in.Selection.Current.Scope
	return withEmptyRecoveryTask(ctx, task, func() error {
		return accessrepo.WithClosedInspection(ctx, computer.Path, accessrepo.Binding{ProfileID: in.Profile.ProfileID, OwnerID: in.OwnerID, ComputerID: in.ComputerID}, in.AccessDigest, func(access accessrepo.ClosedInspection) (resultErr error) {
			h, err := handoffrepo.AcquirePreservationInspection(ctx, handoffRoots(NativeLaunch{Profile: in.Profile}, chat), scope)
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, h.Close()) }()
			l, err := lifecyclerepo.AcquirePreservationInspection(ctx, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, scope, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, l.Close()) }()
			r, err := results.AcquirePreservationInspection(ctx, results.Root{Path: chat.Path, ProfileID: chat.ProfileID, Identity: identity}, scope, results.TextLimits())
			if err != nil {
				return err
			}
			defer func() { resultErr = errors.Join(resultErr, r.Close()) }()
			claims := &preservedProfileChatClaims{h: h, l: l, r: r, ctx: ctx}
			hv, err := h.Observation()
			if err != nil {
				return err
			}
			lv, err := l.Observation()
			if err != nil || lv == nil {
				return errors.Join(err, archivepolicy.Refused)
			}
			rv, err := r.Observation()
			if err != nil {
				return err
			}
			if hv.Scope != scope || lv.Scope != scope || rv.Scope != scope || lv.Root != identity {
				return archivepolicy.Refused
			}
			claims.inventory, err = capturePreservedProfileInventory(ctx, in, chat)
			if err != nil {
				return err
			}
			steps := len(hv.Stages)
			observation := chatport.PreservedRecoveryObservation{Scope: lv.Scope, ParentRoot: hv.ParentRoot, ChatRoot: hv.ChatRoot, ResultsRoot: rv.Root, ResultsStorageRoot: rv.StorageRoot, HandoffDigest: hv.HeadDigest, LifecycleDigest: lv.SnapshotDigest, ResultsDigest: rv.SnapshotDigest, HandoffSteps: steps, WriteCount: lv.WriteCount, TurnCount: lv.TurnCount, PlanCount: lv.PlanCount, ResultCount: rv.ResultCount, Incarnations: lv.Incarnations, RetirementPresent: lv.Retirement != nil, ResultsUnresolved: rv.Unresolved}
			plan, err := (archivepolicy.Policy{}).Select(in.Selection, observation)
			if err != nil {
				return err
			}
			verify := func() error {
				if ctx.Err() != nil {
					return archivepolicy.Refused
				}
				if claims.preserved != nil {
					err := errors.Join(verifyEmptyRecoveryPreservation(ctx, in.Profile, computer, task, claims.preserved), verifyPreservedProfileInventory(ctx, claims.inventory, claims.preserved))
					if err != nil || ctx.Err() != nil {
						return errors.Join(err, archivepolicy.Refused)
					}
					return nil
				}
				currentComputer, currentChat, err := qualified.Roots()
				currentTask, taskErr := qualified.TaskRoot()
				if err != nil || taskErr != nil || currentComputer != computer || currentChat != chat || currentTask != task {
					return archivepolicy.Refused
				}
				if err := claims.verifyOriginal(); err != nil {
					return err
				}
				if err := inspectPreservedProfileNamespaces(ctx, computer, chat, task, steps); err != nil {
					return err
				}
				if ctx.Err() != nil {
					return archivepolicy.Refused
				}
				return nil
			}
			if err := verify(); err != nil {
				return err
			}
			value := preservedProfileInspection{Plan: *plan, Computer: computer, Chat: chat, Task: task, Access: access, Handoff: hv, Lifecycle: *lv, Results: rv}
			invoke := func() error {
				if err := verify(); err != nil {
					return err
				}
				callbackErr := visit(value, claims)
				if err := verify(); err != nil {
					return err
				}
				return callbackErr
			}
			root := mutationrepo.Root{Path: computer.Path, Device: computer.Device, Inode: computer.Inode, OwnerUID: computer.OwnerUID}
			if len(in.Mutations) == 0 {
				return mutationrepo.WithClosedEmptyInspection(ctx, root, func(empty mutationrepo.EmptyInspection) error {
					value.EmptyMutations = &empty
					return invoke()
				})
			}
			_, err = mutationrepo.InspectOwnerCompleted(ctx, root, mutationrepo.OwnerSelection{OwnerID: in.OwnerID, ProfileID: in.Profile.ProfileID, ComputerID: in.ComputerID}, in.Mutations, func(retained mutationrepo.OwnerInspection) error {
				value.Mutations = &retained
				return invoke()
			})
			return err
		})
	})
}
