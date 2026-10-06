package process

import (
	"context"
	"strconv"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

// WorkspaceObservation holds only the original approved workspace values. It
// owns no process, execution lease, admission, clock, policy or retained native
// descriptor. Application read admission must gate every call outside owners.
type WorkspaceObservation struct {
	selected processsvc.ObservedWorkspace
	observe  func(context.Context, port.Root) (port.Root, error)
}

var _ processsvc.ObservationWorkspace = (*WorkspaceObservation)(nil)

// NewObservationWorkspace is trusted composition, not a request/lookup API.
// original must be the SAME workspace/root/identity captured for the admitted
// process. Construction copies values without observing the host. Every later
// call reuses filesystem's actual no-follow root opener and final recheck;
// neither this constructor nor observation qualifies Shell or refreshes rights.
func NewObservationWorkspace(original processsvc.ObservedWorkspace) (*WorkspaceObservation, error) {
	return newObservationWorkspace(original, filesystem.ObserveRoot)
}

// The private boundary exists for CPU fixtures only. No caller/request can
// install a mutable callback or select another measurement mechanism.
func newObservationWorkspace(original processsvc.ObservedWorkspace, observe func(context.Context, port.Root) (port.Root, error)) (*WorkspaceObservation, error) {
	decimal := func(value string) bool {
		n, err := strconv.ParseUint(value, 10, 64)
		return err == nil && strconv.FormatUint(n, 10) == value
	}
	if observe == nil || !bindingID(original.WorkspaceID) || !absolutePolicyPath(original.Root) ||
		!decimal(original.RootIdentity.Device) || !decimal(original.RootIdentity.Inode) {
		return nil, &processsvc.NativeFailure{}
	}
	return &WorkspaceObservation{selected: original, observe: observe}, nil
}

// ObserveWorkspace reobserves one fixed selection on EVERY call, including
// after the original execution lease expires. A missing/replaced/link/type/owner
// root is refused by the existing filesystem adapter. Failure returns no
// positive observation and causes no automatic retry, alternate path or effect.
func (w *WorkspaceObservation) ObserveWorkspace(ctx context.Context) (*processsvc.ObservedWorkspace, error) {
	if w == nil || w.observe == nil || ctx == nil || ctx.Err() != nil {
		return nil, &processsvc.NativeFailure{}
	}
	selected := port.Root{Path: w.selected.Root, Device: w.selected.RootIdentity.Device, Inode: w.selected.RootIdentity.Inode}
	measured, err := w.observe(ctx, selected)
	if err != nil || measured != selected || ctx.Err() != nil {
		// Native errors/paths remain private. Observation refusal cannot be
		// interpreted as a process outcome or permission to execute again.
		return nil, &processsvc.NativeFailure{}
	}
	out := w.selected
	return &out, nil
}
