package boot

import (
	"context"
	"errors"

	archivepolicy "github.com/legrch/farol/modules/chat/app/capabilities/archive"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// Discover only a candidate canonical scope. The later full observation retains
// all original claims, namespace checks and exact digest selection; neither read
// supplies recovery, process, retirement or replay authority.
func discoverPreservedProfile(ctx context.Context, in preservedProfileInspectionInput, visit func(preservedProfileInspection) error) error {
	if visit == nil || !preservedProfileDiscoveryInputValid(in) {
		return archivepolicy.Refused
	}
	ctx, err := bindPreservedProfileContext(ctx)
	if err != nil {
		return err
	}
	// Capture the complete caller selection before any native observation.
	in.Mutations = append([]mutationrepo.ExpectedOwnerRecord(nil), in.Mutations...)
	scope, err := discoverPreservedProfileScope(ctx, in)
	if err != nil || ctx.Err() != nil {
		return errors.Join(err, ctx.Err())
	}
	in.Selection.Current.Scope = scope
	return observePreservedProfile(ctx, in, visit)
}

func preservedProfileDiscoveryInputValid(in preservedProfileInspectionInput) bool {
	s := in.Selection
	return validProfileBinding(in.Profile) && validIngressID(in.OwnerID) && validIngressID(in.ComputerID) &&
		s.BuildID == BuildID && validIngressID(s.OperationID) && validIngressID(s.HostLifetimeID) && validIngressID(s.ChildLaunchID) &&
		s.Current.Scope.ProfileID == in.Profile.ProfileID && s.Current.Scope.BackendGeneration == "" &&
		s.Next.ProfileID == in.Profile.ProfileID && validIngressID(s.Next.BackendGeneration) &&
		s.HandoffDigest == ([32]byte{}) && s.LifecycleDigest == ([32]byte{}) && s.ResultsDigest == ([32]byte{}) &&
		in.AccessDigest != ([32]byte{}) && len(in.Mutations) <= 128
}

// Qualify/close this diagnostic owner before reacquiring the complete canonical
// observation. Only the existing lifecycle decoder derives the generation.
// An unknown close, changed root or expired original budget publishes no scope.
func discoverPreservedProfileScope(ctx context.Context, in preservedProfileInspectionInput) (scope chatport.JournalScope, result error) {
	qualified, err := QualifyProfile(in.Profile)
	if err != nil {
		return scope, err
	}
	defer func() {
		result = errors.Join(result, qualified.Close())
		if ctx.Err() != nil {
			result = errors.Join(result, archivepolicy.Refused)
		}
	}()
	computer, chat, err := qualified.Roots()
	if err != nil {
		return scope, err
	}
	parent := chatport.JournalRoot{Device: in.Profile.Device, Inode: in.Profile.Inode, OwnerUID: chat.OwnerUID}
	identity := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
	if in.Selection.Current.ParentRoot != parent || in.Selection.Current.ChatRoot != identity {
		return scope, archivepolicy.Refused
	}
	observed, err := lifecyclerepo.Inspect(ctx, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
	if err != nil {
		return scope, err
	}
	if observed == nil || observed.Scope.ProfileID != in.Profile.ProfileID || !validIngressID(observed.Scope.BackendGeneration) || observed.Root != identity {
		return scope, archivepolicy.Refused
	}
	currentComputer, currentChat, err := qualified.Roots()
	if err != nil || currentComputer != computer || currentChat != chat || ctx.Err() != nil {
		return scope, errors.Join(err, archivepolicy.Refused)
	}
	return observed.Scope, nil
}
