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

// retainProcessResult is the lifecycle owner's one publication step. The private
// capture closure retains the SAME started service; it is never selected by a
// READ request. Publication has no current-connector dependency and grants no
// disclosure. Reconnect still needs a fresh admitted READ and physical checks.
func (s *computerConnector) retainProcessResult(ctx context.Context, operation string, original *settingsMutationOperation, capture func(context.Context) (*processsvc.TerminalResult, error)) (string, error) {
	ledger := s.mutations
	publisher, ok := ledger.dependencies.repository.(connectorProcessPublisher)
	if !ok {
		return "", connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	ledger.mu.Lock()
	record := ledger.operations[operation]
	for record != nil && record == original && record.process != nil && record.process.cancelling {
		done := record.process.cancelDone
		ledger.mu.Unlock()
		if done == nil {
			return "", connectorProcessUnknown()
		}
		select {
		case <-done:
		case <-ctx.Done():
			return "", connectorProcessUnknown()
		}
		ledger.mu.Lock()
		record = ledger.operations[operation]
	}
	if ledger.frozen || record == nil || record != original || record.pending || record.process == nil || record.process.cancelUnknown || record.process.collectionErr != nil || record.process.service == nil || capture == nil {
		ledger.mu.Unlock()
		return "", connectorProcessRefusal("PROCESS_UNAVAILABLE")
	}
	retained := record.process
	if retained.capturing || retained.publishAttempted {
		ledger.mu.Unlock()
		return "", connectorProcessRefusal("PROCESS_RESULT_ATTEMPT_CONSUMED")
	}
	retained.capturing = true
	ledger.mu.Unlock()
	result, err := capture(ctx)
	ledger.mu.Lock()
	if err != nil || result == nil {
		retained.capturing = false
		ledger.mu.Unlock()
		if err != nil {
			return "", err
		}
		return "", connectorProcessUnknown()
	}
	if ledger.frozen || ctx.Err() != nil || ledger.operations[operation] != original || record.process != retained ||
		retained.cancelling || retained.cancelUnknown || retained.collectionErr != nil ||
		!processsvc.ValidTerminalResult(*result) || result.Scope != retained.origin || result.Intent.OperationID != operation {
		retained.capturing = false
		ledger.mu.Unlock()
		return "", connectorProcessUnknown()
	}
	copy := result.Clone()
	retained.result, retained.publishAttempted = &copy, true
	ledger.mu.Unlock()
	// Publication is outside current-owner/app/ledger gates. The retained copy
	// survives any late error, but visible stored bytes cannot settle a lost ACK.
	digest, err := publisher.PublishProcessTerminal(ctx, result.Clone())
	decoded, decodeErr := hex.DecodeString(digest)
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	retained.capturing = false
	if err != nil || ctx.Err() != nil || decodeErr != nil || len(decoded) != 32 || strings.ToLower(digest) != digest ||
		ledger.frozen || ledger.operations[operation] != original || record.process != retained || retained.cancelling || retained.cancelUnknown || retained.collectionErr != nil {
		err = connectorProcessUnknown()
		record.failure = err
		return "", err
	}
	retained.publication = digest
	record.settled = true
	return digest, nil
}
