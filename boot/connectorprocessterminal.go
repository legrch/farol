package boot

import (
	"context"
	"encoding/hex"
	"strings"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

type connectorProcessPublisher interface {
	PublishProcessTerminal(context.Context, processsvc.TerminalResult) (string, error)
}

var _ connectorProcessPublisher = (*mutationrepo.Repository)(nil)

// retainProcess is root's explicit terminal-preservation step, not a public READ
// handler. It uses the SAME operation and repository; a known durable complete
// result can settle that ledger entry. Native confinement/cleanup, normal startup
// activation and cold-result authority/disclosure remain separate gates.
func (s *computerConnector) retainProcess(ctx context.Context, slot *connectorSlot, operation string) (string, error) {
	if !validIngressID(operation) {
		return "", connectorProcessRefusal("PROCESS_INPUT_INVALID")
	}
	current, err := s.processObservation(ctx, slot)
	if err != nil {
		return "", err
	}
	ledger := s.mutations
	publisher, ok := ledger.dependencies.repository.(connectorProcessPublisher)
	if !ok {
		return "", connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	ledger.mu.Lock()
	record := ledger.operations[operation]
	if ledger.frozen || record == nil || record.pending || record.process == nil || record.process.cancelling || record.process.cancelUnknown || record.process.service == nil || record.process.workspace == nil {
		ledger.mu.Unlock()
		return "", connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	retained := record.process
	if retained.capturing || retained.publishAttempted {
		ledger.mu.Unlock()
		return "", connectorProcessRefusal("PROCESS_RESULT_ATTEMPT_CONSUMED")
	}
	retained.capturing = true
	service, workspace := retained.service, retained.workspace
	ledger.mu.Unlock()
	result, err := service.CaptureTerminal(ctx, current, workspace)
	ledger.mu.Lock()
	retained.capturing = false
	if err != nil || result == nil {
		ledger.mu.Unlock()
		if err != nil {
			return "", err
		}
		return "", connectorProcessUnknown()
	}
	if ledger.frozen || ctx.Err() != nil {
		ledger.mu.Unlock()
		return "", connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	copy := result.Clone()
	retained.result, retained.publishAttempted = &copy, true
	ledger.mu.Unlock()
	// Publication is outside current-owner/app/ledger gates. The retained copy
	// survives any late error, but visible stored bytes cannot settle a lost ACK.
	digest, err := publisher.PublishProcessTerminal(ctx, result.Clone())
	decoded, decodeErr := hex.DecodeString(digest)
	if err != nil || ctx.Err() != nil || decodeErr != nil || len(decoded) != 32 || strings.ToLower(digest) != digest {
		err = connectorProcessUnknown()
		ledger.mu.Lock()
		record.failure = err
		ledger.mu.Unlock()
		return "", err
	}
	ledger.mu.Lock()
	retained.publication = digest
	record.settled = !retained.cancelling && !retained.cancelUnknown
	ledger.mu.Unlock()
	return digest, nil
}
