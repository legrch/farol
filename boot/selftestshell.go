package boot

import (
	"context"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
)

type selfTestShellKind uint8

const (
	selfTestShellQuick selfTestShellKind = iota + 1
	selfTestShellCancel
)

// selfTestShell owns one foreground canary in the already admitted connector.
// It cannot be restored from history or moved to a replacement connector.
type selfTestShell struct {
	mu                                          sync.Mutex
	owner                                       *computerConnector
	slot                                        *connectorSlot
	execution                                   wire.ComputerConnectorExecution
	selectLaunch                                connectorShellSelection
	workspace, operation, call, cancelOperation string
	kind                                        selfTestShellKind
	attempted, cancelAttempted                  bool
	handle                                      string
	run                                         *selfTestRunLease
}

func newSelfTestShell(owner *computerConnector, slot *connectorSlot, workspace, operation, call, cancelOperation string, kind selfTestShellKind) (*selfTestShell, error) {
	if owner == nil || slot == nil || owner.processes == nil || !validIngressID(workspace) || !validIngressID(operation) || !validIngressID(call) || !validIngressID(cancelOperation) || operation == cancelOperation || (kind != selfTestShellQuick && kind != selfTestShellCancel) {
		return nil, connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	return &selfTestShell{owner: owner, slot: slot, execution: slot.opened.Execution, selectLaunch: owner.processes, workspace: workspace, operation: operation, call: call, cancelOperation: cancelOperation, kind: kind}, nil
}

func (s *selfTestShell) start(ctx context.Context) (*processct.StartResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.attempted {
		return nil, connectorProcessRefusal("PROCESS_SELF_TEST_ALREADY_ATTEMPTED")
	}
	s.attempted = true
	command := "printf 'farol self-test\\n'"
	if s.kind == selfTestShellCancel {
		command = "/bin/sleep 30"
	}
	request := connectorShellRequest{WorkspaceID: s.workspace, RelativeCwd: ".", Command: command, Write: false}
	out, err := s.owner.startQualifiedShellForRun(ctx, s.slot, s.execution, s.operation, s.call, request, s.selectLaunch, s.run)
	if err != nil {
		return nil, err
	}
	s.handle = out.Handle
	return out, nil
}

func (s *selfTestShell) read(ctx context.Context, stdout, stderr uint64) (*processct.ReadResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.handle == "" {
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	if err := s.owner.checkMutationSlot(ctx, s.slot, s.execution); err != nil {
		return nil, err
	}
	return s.owner.observeProcess(ctx, s.slot, s.operation, processct.ReadRequest{Handle: s.handle, StdoutOffset: stdout, StderrOffset: stderr})
}

func (s *selfTestShell) cancel(ctx context.Context) (*processct.CancelResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.kind != selfTestShellCancel || s.handle == "" || s.cancelAttempted {
		return nil, connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	s.cancelAttempted = true
	if err := s.owner.checkMutationSlot(ctx, s.slot, s.execution); err != nil {
		return nil, err
	}
	return s.owner.cancelProcess(ctx, s.slot, s.cancelOperation, s.operation, s.handle)
}
