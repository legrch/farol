package boot

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/gate"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	lifecyclerepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/results"
)

// This is separately admitted closed maintenance. The host owns exact process
// absence, its original promotion/connector fences and durable initiating ACK.
// The old nonempty Chat is archived unchanged, including UNKNOWN. Only a wholly
// fresh empty generation is really retired here; no old receipt, effect outcome,
// host terminal or admission is inferred from its canonical recorded bytes.
func preparePreservedProfileRecovery(ctx context.Context, in preservedProfileInspectionInput, hostACK func(chatport.HandoffPublication) error) (ack wire.CoreRetirementAcknowledged, resultErr error) {
	var boundErr error
	ctx, boundErr = bindPreservedProfileContext(ctx)
	if boundErr != nil {
		return ack, boundErr
	}
	if hostACK == nil {
		return ack, handoff.Invalid
	}
	var preparationErr error
	preservedSuccessfully := false
	effectsStarted := false
	err := withPreservedProfileClaims(ctx, in, func(v preservedProfileInspection, claims *preservedProfileChatClaims) (resultErr error) {
		defer func() { preparationErr = resultErr; effectsStarted = claims.effectsStarted }()
		preserved, err := preserveNonemptyRecoveryChat(ctx, in, v, claims)
		if err != nil {
			return fmt.Errorf("preserved Chat archival: %w", err)
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
		if preservedSuccessfully || effectsStarted {
			err = errors.Join(err, handoff.Unknown)
		}
		return wire.CoreRetirementAcknowledged{}, errors.Join(err, preparationErr)
	}
	return ack, nil
}
