package boot

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// runScratchFileCleanup joins the profile owner around one native cleanup.
// Both original handles are closed before the service saves its terminal.
type runScratchFileCleanup struct {
	owner          *computerStageOwner
	native         port.ScratchFileCleanupWorkspace
	directory      port.ScratchDirectoryCustody
	file           port.ScratchFileCustody
	closeAttempted bool
	closed         bool
}

func (w *runScratchFileCleanup) RemoveScratchFile(ctx context.Context, request port.ScratchFileCleanupRequest) error {
	if w == nil || w.owner == nil || w.native == nil || w.directory == nil || w.file == nil {
		return authority.Fail("WORKSPACE_PATH_REFUSED", "native-workspace")
	}
	request.DirectoryHold, request.FileHold = w.directory, w.file
	entered := false
	var callbackErr error
	err := w.owner.run(ctx, func(ctx context.Context, _ int, _ NativeRoot) error {
		entered = true
		callbackErr = w.native.RemoveScratchFile(ctx, request)
		return callbackErr
	})
	if entered && err != nil {
		if callbackErr != nil && onlyCleanupCallbackError(err, callbackErr) {
			return callbackErr
		}
		return authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
	}
	if err != nil {
		return err
	}
	w.closeAttempted = true
	fileErr := w.file.Close()
	dirErr := w.directory.Close()
	if fileErr != nil || dirErr != nil {
		return authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "native-workspace")
	}
	w.closed = true
	return nil
}
