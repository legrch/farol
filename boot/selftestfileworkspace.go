package boot

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// This adapter is lifetime-local to one connector mutation. It borrows the
// run's existing handles and retains the new published handle before the
// ordinary mutation engine saves its terminal result.
type selfTestBoundWorkspace struct {
	native                 port.ScratchBoundMutableWorkspace
	binding                mutation.ScratchCleanupBinding
	directory              port.ScratchDirectoryCustody
	previous               port.ScratchFileCustody
	expected               *mutation.DirectoryIdentity
	published              mutation.DirectoryIdentity
	custody                port.ScratchFileCustody
	previousCloseAttempted bool
	attempted              bool
}

func (w *selfTestBoundWorkspace) Mutate(ctx context.Context, request port.MutationRequest) (*port.MutationReceipt, error) {
	if w == nil || w.native == nil || w.directory == nil || request.ScratchParent != nil || request.ScratchDirectoryHold != nil || request.ScratchExpectedFile != nil || request.ScratchPreviousFile != nil || request.HoldScratchFile || w.attempted {
		return nil, computerUnavailable()
	}
	if w.directory.Check(w.binding.Directory) != nil || (w.expected == nil) != (w.previous == nil) {
		return nil, computerUnavailable()
	}
	request.ScratchDirectoryHold = w.directory
	request.HoldScratchFile = true
	if w.expected != nil {
		copy := *w.expected
		if !copy.Valid() || w.previous.Check(copy) != nil {
			return nil, computerUnavailable()
		}
		request.ScratchExpectedFile = &copy
		request.ScratchPreviousFile = w.previous
	}
	w.attempted = true
	out, err := w.native.MutateScratch(ctx, request, w.binding)
	if out != nil && out.ScratchFileHold != nil {
		w.custody, w.published = out.ScratchFileHold, out.ScratchFile
		out.ScratchFileHold = nil
	}
	if err != nil {
		return nil, err
	}
	if out == nil || w.custody == nil || !w.published.Valid() || w.custody.Check(w.published) != nil {
		return nil, authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
	}
	if w.previous != nil {
		w.previousCloseAttempted = true
		if err := w.previous.Close(); err != nil {
			return nil, authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
		}
	}
	return out, nil
}
