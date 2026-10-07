package boot

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/gate"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
)

const emptyRecoveryPending = ".empty-recovery.pending"

// Sibling intent leaves the original Go parent/Chat snapshots untouched while
// their strict inspection claims are held. It is bound to this exact root name.
func emptyRecoveryPendingPath(root string) string {
	return filepath.Join(filepath.Dir(root), filepath.Base(root)+emptyRecoveryPending)
}

// This is trusted closed maintenance, never a runtime method. The initiating
// host must hold the profile's existing promotion lease and independently prove
// the failed desktop/connector/backend closed. Inspection cannot supply that
// authority. Pending remains through original child AND terminal-recorder close;
// only the qualified host may complete its existing desktop-marker handoff.
func prepareEmptyRecovery(ctx context.Context, in emptyRecoveryInspectionInput, hostACK func(chatport.HandoffPublication) error) (ack wire.CoreRetirementAcknowledged, resultErr error) {
	if hostACK == nil {
		return ack, handoff.Invalid
	}
	var preparationErr error
	preservedSuccessfully := false
	err := withEmptyRecoveryClaims(ctx, in, func(v emptyRecoveryInspection, claims *emptyRecoveryChatClaims) (resultErr error) {
		defer func() { preparationErr = resultErr }()
		preserved, err := preserveEmptyRecoveryChat(ctx, in, v, claims)
		if err != nil {
			return fmt.Errorf("empty recovery preservation: %w", err)
		}
		claims.preserved = preserved
		preservedSuccessfully = true
		// Every subsequent failure leaves the durable pending fence and old
		// physical archive. No partial owner or complete-looking handoff licenses
		// a new runtime, retry, deletion or restoration of the old claim.
		defer func() {
			if resultErr != nil || ctx.Err() != nil {
				resultErr = errors.Join(handoff.Unknown, resultErr, ctx.Err())
			}
		}()
		chat := preserved.NewChat
		root := chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}
		journal, err := lifecyclerepo.New(ctx, lifecyclerepo.Root{Path: chat.Path, ProfileID: chat.ProfileID, Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}, lifecyclerepo.Limits{Bytes: 1048576, Records: 4096})
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, journal.Close()) }()
		retained, err := results.NewNative(ctx, ctx, results.Root{Path: chat.Path, ProfileID: chat.ProfileID, Identity: root}, in.Selection.Next, results.TextLimits(), "create")
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, retained.Close()) }()
		owner, err := lifecycle.New(ctx, in.Selection.Next, lifecycle.Dependencies{Gate: gate.New(), Journal: journal})
		if err != nil {
			return err
		}
		origin, err := owner.Retire(ctx)
		if err != nil {
			return err
		}
		launch := NativeLaunch{Profile: in.Profile, HostLifetimeID: in.Selection.HostLifetimeID, ChildLaunchID: in.Selection.ChildLaunchID}
		repo, err := handoffrepo.New(ctx, handoffRoots(launch, chat))
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, repo.Close()) }()
		service, err := handoff.New(repo)
		if err != nil {
			return err
		}
		publication, err := service.Capture(ctx, chatport.HandoffBinding{ProfileID: chat.ProfileID, BackendGeneration: in.Selection.Next.BackendGeneration, BuildID: BuildID, HostLifetimeID: launch.HostLifetimeID, ChildLaunchID: launch.ChildLaunchID, ParentRoot: in.Selection.Current.ParentRoot, ChatRoot: root}, in.Selection.OperationID, origin)
		if err != nil {
			return err
		}
		if err = hostACK(*publication); err != nil || ctx.Err() != nil {
			return errors.Join(handoff.Unknown, err, repo.Fence(context.WithoutCancel(ctx)))
		}
		head, err := service.Acknowledge(ctx, chatport.HandoffACK{Publication: *publication})
		if err != nil {
			return err
		}
		ack = wire.CoreRetirementAcknowledged{HandoffId: publication.HandoffID, ReceiptDigest: hex.EncodeToString(publication.ReceiptDigest[:]), AckDigest: hex.EncodeToString(head[:])}
		return nil
	})
	if err != nil {
		if preservedSuccessfully {
			err = errors.Join(err, handoff.Unknown)
		}
		return wire.CoreRetirementAcknowledged{}, errors.Join(err, preparationErr)
	}
	return ack, nil
}

type emptyRecoveryPreservation struct {
	Archive         NativeRoot
	NewChat         NativeRoot
	Files           map[string]emptyRecoveryFile
	PendingDigest   [32]byte
	PendingIdentity emptyRecoveryFile
}

type emptyRecoveryFile struct {
	Device, Inode  uint64
	Mode, OwnerUID uint32
	SHA256         [32]byte
}
