package boot

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// The request selects input inside an existing workspace, never an executable,
// environment, root, deadline, authority or native qualification. Trusted root
// must provide the actual qualified producer. Normal startup leaves it absent.
type connectorShellRequest struct {
	WorkspaceID, RelativeCwd, Command, Stdin string
	Write                                    bool
}
type connectorShellSelection func(context.Context, *execution.Lease, connectorShellRequest) (processsvc.Prepared, processsvc.ObservationWorkspace, error)

func shellRelativeCwd(value string) bool {
	if value == "." {
		return true
	}
	if value == "" || strings.ContainsAny(value, "\\\x00\r\n\t") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	for _, r := range value {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}

func connectorProcessOutcome(value any, err error) (*desktop.Outcome, error) {
	if err == nil {
		return ingressOutcome(value, nil)
	}
	var failure *processct.Failure
	if errors.As(err, &failure) {
		status := "refused"
		if failure.Outcome == "outcome_unknown" {
			status = "unknown"
		}
		return &desktop.Outcome{Status: status, Code: failure.Code}, nil
	}
	var local *processsvc.Failure
	if errors.As(err, &local) {
		status := "refused"
		if local.Unknown {
			status = "unknown"
		}
		return &desktop.Outcome{Status: status, Code: local.Code}, nil
	}
	var denied *authority.Failure
	if errors.As(err, &denied) {
		return &desktop.Outcome{Status: "refused", Code: denied.Code}, nil
	}
	return &desktop.Outcome{Status: "unknown", Code: "PROCESS_OUTCOME_UNKNOWN"}, nil
}

func processReadWire(slot *connectorSlot, in wire.ComputerConnectorProcessRead, out *processct.ReadResponse) (*wire.ComputerConnectorProcessResult, error) {
	invalid := func() (*wire.ComputerConnectorProcessResult, error) { return nil, connectorProcessUnknown() }
	if slot == nil || out == nil || out.Handle != in.Handle || out.StdoutOffset != mustProcessOffset(in.StdoutOffset) || out.StderrOffset != mustProcessOffset(in.StderrOffset) ||
		out.StdoutBytes > processsvc.MaximumOutput || out.StderrBytes > processsvc.MaximumOutput || out.StdoutBytes+out.StderrBytes > processsvc.MaximumOutput || out.ExitSignal < 0 || out.ExitSignal > 128 {
		return invalid()
	}
	page := func(encoded string, offset, next, total uint64) bool {
		bytes, err := base64.StdEncoding.Strict().DecodeString(encoded)
		return err == nil && base64.StdEncoding.EncodeToString(bytes) == encoded && len(bytes) <= processsvc.WindowBytes && next == offset+uint64(len(bytes)) && next <= total
	}
	if !page(out.StdoutBase64, out.StdoutOffset, out.StdoutNext, out.StdoutBytes) || !page(out.StderrBase64, out.StderrOffset, out.StderrNext, out.StderrBytes) {
		return invalid()
	}
	result := &wire.ComputerConnectorProcessResult{Execution: slot.opened.Execution, CallId: in.CallId, OperationId: in.OperationId, Handle: in.Handle,
		State: string(out.State), RootState: string(out.RootState), RootWaited: out.RootWaited, ExitSignal: uint32(out.ExitSignal),
		GroupCleanup: string(out.GroupCleanup), DescendantCleanup: string(out.DescendantCleanup),
		StdoutBase64: out.StdoutBase64, StderrBase64: out.StderrBase64, StdoutOffset: decimal(out.StdoutOffset), StderrOffset: decimal(out.StderrOffset),
		StdoutNext: decimal(out.StdoutNext), StderrNext: decimal(out.StderrNext), StdoutBytes: decimal(out.StdoutBytes), StderrBytes: decimal(out.StderrBytes),
		OutputLimitReached: out.OutputLimitReached, OutputDrained: out.OutputDrained, CancelRequested: out.CancelRequested, TimedOut: out.TimedOut, AuthorityLost: out.AuthorityLost}
	if out.ExitCode != nil {
		if *out.ExitCode < 0 || *out.ExitCode > 255 {
			return invalid()
		}
		code := uint32(*out.ExitCode)
		result.ExitCode = &code
	}
	if out.RootState == processct.RootRunning {
		if out.RootWaited || out.ExitCode != nil || out.ExitSignal != 0 || out.GroupCleanup == processct.CleanupConfirmed || out.DescendantCleanup == processct.CleanupConfirmed || out.State == processct.Terminal {
			return invalid()
		}
	} else if out.RootState == processct.RootExited {
		if !out.RootWaited || (out.ExitCode == nil) == (out.ExitSignal == 0) || out.GroupCleanup == processct.CleanupPending || out.DescendantCleanup == processct.CleanupPending || out.State == processct.Running {
			return invalid()
		}
	}
	if out.State == processct.Terminal && (out.GroupCleanup != processct.CleanupConfirmed || out.DescendantCleanup != processct.CleanupConfirmed || !out.OutputDrained) {
		return invalid()
	}
	if validateIngress("ComputerConnectorProcessResult", result) != nil {
		return invalid()
	}
	return result, nil
}

func processOffset(value string) (uint64, bool) {
	n, err := strconv.ParseUint(value, 10, 64)
	return n, err == nil && strconv.FormatUint(n, 10) == value && n <= processsvc.MaximumOutput
}
func mustProcessOffset(value string) uint64 { n, _ := processOffset(value); return n }

// Cancel is cleanup of the SAME live owner, not a fresh execution admission.
// A different connector lifetime may observe, but cannot recover a control
// handle from stored bytes. The service keeps its one-shot cancellation ACK.
func (s *computerConnector) cancelProcess(ctx context.Context, slot *connectorSlot, cancelOperation, operation, handle string) (*processct.CancelResponse, error) {
	if ctx == nil || ctx.Err() != nil || !s.processSlot(slot) || !validIngressID(cancelOperation) || !validIngressID(operation) || !validIngressID(handle) || cancelOperation == operation {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	ledger := s.mutations
	ledger.mu.Lock()
	record := ledger.operations[operation]
	if ledger.frozen || record == nil || record.pending || record.process == nil || record.process.contract == nil {
		ledger.mu.Unlock()
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	p := record.process
	// Host metadata is correlation, not the original connector instance. Even
	// an identical Open cannot adopt a previous slot's retained control handle.
	if p.owner != slot || p.origin.Host != slot.guard.host {
		ledger.mu.Unlock()
		return nil, connectorProcessRefusal("PROCESS_CONTROL_LIFETIME_MISMATCH")
	}
	if p.cancelling || p.cancelUnknown || p.capturing || p.publishAttempted && p.publication == "" {
		ledger.mu.Unlock()
		return nil, connectorProcessUnknown()
	}
	p.cancelling = true
	p.cancelDone = make(chan struct{})
	settled := record.settled
	record.settled = false // Retirement cannot pass while control is in flight.
	contract := p.contract
	ledger.mu.Unlock()
	finish := func(unknown bool) {
		ledger.mu.Lock()
		p.cancelling = false
		close(p.cancelDone)
		p.cancelUnknown = p.cancelUnknown || unknown
		record.settled = settled && !p.cancelUnknown
		ledger.mu.Unlock()
	}
	if err := slot.guard.WithConnectorCurrent(ctx, slot.guard.host, func(current bool) error {
		if !current {
			return connectorProcessRefusal("PROCESS_UNAVAILABLE")
		}
		return nil
	}); err != nil {
		finish(false)
		return nil, err
	}
	if err := s.root.claim(cancelOperation); err != nil {
		finish(false)
		return nil, err
	}
	// No owner/ledger lock spans a child call. Stop may remain necessary after
	// the original execution lease expires; it never renews or dispatches work.
	out, err := contract.Cancel(ctx, processct.CancelRequest{Handle: handle})
	if err != nil {
		var failure *processct.Failure
		if errors.As(err, &failure) && failure.Outcome == "refused" {
			finish(false)
			return nil, err
		}
	}
	unknown := err != nil || out == nil || out.Status == processct.CancelUnknown || ctx.Err() != nil
	if !unknown {
		// A late withdrawal cannot disclose an ACK as a current success. The
		// attempted cleanup stays consumed; another current read cannot reset it.
		unknown = slot.guard.WithConnectorCurrent(ctx, slot.guard.host, func(current bool) error {
			if !current {
				return connectorProcessUnknown()
			}
			return nil
		}) != nil
	}
	finish(unknown)
	if unknown {
		return nil, connectorProcessUnknown()
	}
	return out, nil
}

func (s *computerConnector) processMethods(slot *connectorSlot, selectLaunch connectorShellSelection) map[string]desktop.Method {
	if selectLaunch == nil || s.mutations == nil {
		return nil
	}
	valid := func(r desktop.Request, name string, effect bool) bool {
		return (r.OperationID != "") == effect && len(r.Body) <= 512*1024 && ipc.ValidateJSON(r.Body) == nil && wire.Validate(name, r.Body) == nil
	}
	return map[string]desktop.Method{
		"computer.process.start": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ComputerConnectorProcessStart
			if !valid(r, "ComputerConnectorProcessStart", true) || json.Unmarshal(r.Body, &in) != nil || !shellRelativeCwd(in.RelativeCwd) || strings.ContainsRune(in.Command, 0) {
				return invalidIngress()
			}
			if err := s.checkMutationSlot(ctx, slot, in.Execution); err != nil {
				return connectorProcessOutcome(nil, err)
			}
			request := connectorShellRequest{WorkspaceID: in.WorkspaceId, RelativeCwd: in.RelativeCwd, Command: in.Command, Write: in.Write}
			if in.Stdin != nil {
				request.Stdin = *in.Stdin
			}
			out, err := s.startProcess(ctx, slot, r.OperationID, in.CallId, func(ctx context.Context, lease *execution.Lease) (processsvc.Prepared, processsvc.ObservationWorkspace, error) {
				prepared, workspace, err := selectLaunch(ctx, lease, request)
				if err != nil || prepared == nil || workspace == nil {
					return nil, nil, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
				}
				seal := prepared.Seal()
				cwd := seal.Root
				if request.RelativeCwd != "." {
					cwd += "/" + request.RelativeCwd
				}
				if seal.WorkspaceID != request.WorkspaceID || seal.Cwd != cwd || seal.Write != request.Write {
					return nil, nil, connectorProcessRefusal("PROCESS_PREPARATION_UNAVAILABLE")
				}
				return prepared, workspace, nil
			})
			if err != nil {
				return connectorProcessOutcome(nil, err)
			}
			if out == nil || out.OperationID != r.OperationID || !validIngressID(out.Handle) {
				return connectorProcessOutcome(nil, connectorProcessUnknown())
			}
			return connectorProcessOutcome(&wire.ComputerConnectorProcessStarted{Execution: slot.opened.Execution, CallId: in.CallId, OperationId: r.OperationID, Handle: out.Handle}, nil)
		}},
		"computer.process.read": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ComputerConnectorProcessRead
			if !valid(r, "ComputerConnectorProcessRead", false) || json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			stdout, stdoutOK := processOffset(in.StdoutOffset)
			stderr, stderrOK := processOffset(in.StderrOffset)
			if !stdoutOK || !stderrOK {
				return invalidIngress()
			}
			if err := s.checkMutationSlot(ctx, slot, in.Execution); err != nil {
				return connectorProcessOutcome(nil, err)
			}
			out, err := s.observeProcess(ctx, slot, in.OperationId, processct.ReadRequest{Handle: in.Handle, StdoutOffset: stdout, StderrOffset: stderr})
			if err != nil {
				return connectorProcessOutcome(nil, err)
			}
			result, err := processReadWire(slot, in, out)
			return connectorProcessOutcome(result, err)
		}},
		"computer.process.cancel": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var in wire.ComputerConnectorProcessCancel
			if !valid(r, "ComputerConnectorProcessCancel", true) || json.Unmarshal(r.Body, &in) != nil || r.OperationID == in.OperationId {
				return invalidIngress()
			}
			if err := s.checkMutationSlot(ctx, slot, in.Execution); err != nil {
				return connectorProcessOutcome(nil, err)
			}
			out, err := s.cancelProcess(ctx, slot, r.OperationID, in.OperationId, in.Handle)
			if err != nil {
				return connectorProcessOutcome(nil, err)
			}
			return connectorProcessOutcome(&wire.ComputerConnectorProcessCancelled{Execution: slot.opened.Execution, CallId: in.CallId, OperationId: in.OperationId, Handle: in.Handle, CancelOperationId: r.OperationID, Status: string(out.Status)}, nil)
		}},
	}
}
