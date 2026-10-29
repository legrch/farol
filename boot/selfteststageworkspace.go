package boot

import (
	"context"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

type stagedScratchNative interface {
	port.MutableWorkspace
	CreateStagedScratch(context.Context, port.MutationRequest, int, port.Root) (*port.MutationReceipt, error)
}

// stagedScratchWorkspace is private composition for an already selected owner
// operation. Ordinary writes remain on their existing native path.
type stagedScratchWorkspace struct {
	ledger    *SettingsMutationIngress
	operation string
	native    stagedScratchNative
	hold      bool
	custody   port.ScratchDirectoryCustody
}

var _ port.MutableWorkspace = (*stagedScratchWorkspace)(nil)
var _ port.StagedMutableWorkspace = (*stagedScratchWorkspace)(nil)

func (w *stagedScratchWorkspace) Mutate(ctx context.Context, request port.MutationRequest) (*port.MutationReceipt, error) {
	if w == nil || w.native == nil {
		return nil, computerUnavailable()
	}
	return w.native.Mutate(ctx, request)
}

func (w *stagedScratchWorkspace) BeginStage(ctx context.Context, request port.MutationRequest) (port.StagedMutation, error) {
	if w == nil || w.ledger == nil || w.native == nil || ctx == nil || ctx.Err() != nil {
		return nil, computerUnavailable()
	}
	scratch, ok := request.Operation.(mutation.Scratch)
	if !ok || !scratch.Binding.Valid() || scratch.Binding.RunID != w.operation {
		return nil, computerUnavailable()
	}
	lease, err := w.ledger.beginSelfTestStageForWorkspace(ctx, w.operation, request.Workspace.WorkspaceID)
	if err != nil {
		return nil, err
	}
	request.HoldScratchDirectory = w.hold
	return &stagedScratchAttempt{lease: lease, native: w.native, request: request, parent: w}, nil
}

type stagedScratchAttempt struct {
	lease   *selfTestStageLease
	native  stagedScratchNative
	request port.MutationRequest
	parent  *stagedScratchWorkspace
}

func (a *stagedScratchAttempt) Execute(ctx context.Context) (*port.MutationReceipt, error) {
	if a == nil || a.lease == nil || a.native == nil || ctx == nil || ctx.Err() != nil {
		return nil, computerUnavailable()
	}
	stop := context.AfterFunc(ctx, a.lease.cancel)
	defer stop()
	var receipt *port.MutationReceipt
	err := a.lease.run(func(ctx context.Context, fd int, root NativeRoot) error {
		var err error
		receipt, err = a.native.CreateStagedScratch(ctx, a.request, fd, port.Root{Path: root.Path, Device: strconv.FormatUint(root.Device, 10), Inode: strconv.FormatUint(root.Inode, 10)})
		return err
	})
	if receipt != nil && receipt.ScratchDirectory != nil {
		a.parent.custody = receipt.ScratchDirectory
		receipt.ScratchDirectory = nil
	}
	if a.parent.hold && err == nil && (receipt == nil || a.parent.custody == nil || a.parent.custody.Check(receipt.Directory) != nil) {
		err = authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
	}
	if err != nil && a.parent.custody != nil {
		if closeErr := a.parent.custody.Close(); closeErr != nil {
			err = authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
		}
		a.parent.custody = nil
	}
	return receipt, err
}

func (a *stagedScratchAttempt) Release() {
	if a != nil {
		a.lease.release()
	}
}
