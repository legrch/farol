package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"github.com/legrch/farol/modules/computer/app/port"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

const selfTestFileBefore = "Farol self-test\n"
const selfTestFileAfter = "Farol self-test verified\n"

type selfTestBoundWorkspace struct {
	native  port.ScratchBoundMutableWorkspace
	binding state.ScratchCleanupBinding
}

func (w *selfTestBoundWorkspace) Mutate(ctx context.Context, request port.MutationRequest) (*port.MutationReceipt, error) {
	if w == nil || w.native == nil || request.ScratchParent != nil {
		return nil, computerUnavailable()
	}
	return w.native.MutateScratch(ctx, request, w.binding)
}

func selfTestFileHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func validSelfTestFileOperation(op mutationct.Operation) bool {
	switch v := op.(type) {
	case mutationct.Write:
		return v.Content == selfTestFileBefore && v.ExpectedSHA256 == nil
	case mutationct.Edit:
		return v.ExpectedSHA256 == selfTestFileHash(selfTestFileBefore) && len(v.Edits) == 1 && v.Edits[0].OldText == selfTestFileBefore && v.Edits[0].NewText == selfTestFileAfter
	default:
		return false
	}
}

// mutateFixture runs one fixed write or edit under the original run fence and
// connector owner. The parent binding comes from the original durable creation,
// never a renderer, path supplied by a caller or a persisted marker alone.
func (r *selfTestRunLease) mutateFixture(ctx context.Context, connector *computerConnector, slot *connectorSlot, operation, call string, edit bool) (*mutationct.ConnectorResponse, error) {
	if r == nil || r.ledger == nil || r.ledger.computer == nil || ctx == nil || ctx.Err() != nil || connector == nil || connector.mutations != r.ledger || slot == nil || !validIngressID(operation) || !validIngressID(call) || operation == r.operation {
		return nil, mutationInvalid()
	}
	s := r.ledger
	s.mu.Lock()
	original := s.operations[r.operation]
	if s.selfTestRun != r || r.active || r.cleanupStarted || r.ctx.Err() != nil || s.stagePending || s.stageClosed || s.frozen || s.processDraining || s.recoveryReserved || s.retirementErr != nil || original == nil || !original.stageScratch || !original.scratchCreated || original.selfTestRun != r || original.pending || !original.settled || original.scratch == nil || original.workspace != r.workspace || (edit && (r.fixtureEditStarted || r.fixtureWriteHash != selfTestFileHash(selfTestFileBefore))) || (!edit && r.fixtureWriteStarted) {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	for id, previous := range s.operations {
		if id != r.operation && !stagingPriorEligible(previous) {
			s.mu.Unlock()
			return nil, computerUnavailable()
		}
	}
	if edit {
		r.fixtureEditStarted = true
	} else {
		r.fixtureWriteStarted = true
	}
	r.active = true
	r.callDone = make(chan struct{})
	done, generation := r.callDone, original.generation
	s.mu.Unlock()
	bounded, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(r.ctx, cancel)
	defer func() {
		stop()
		cancel()
		s.mu.Lock()
		r.active = false
		close(done)
		s.mu.Unlock()
	}()
	identity := state.Identity{Scope: state.ScopeOwnerSettings, OperationID: r.operation, OwnerID: s.computer.ownerID, ProfileID: s.computer.peer.ProfileId, ComputerID: s.computer.computerID}
	creation, err := s.dependencies.repository.Load(bounded, identity)
	if err != nil {
		return nil, computerUnavailable()
	}
	prepared, err := state.NewScratchCleanup(creation)
	if err != nil {
		return nil, computerUnavailable()
	}
	binding := prepared.Binding()
	if binding.Creation.Identity != identity || binding.Creation.ComputerGeneration != generation || binding.Creation.WorkspaceID != r.workspace || binding.Creation.RelativePath != state.ScratchPath(r.operation) {
		return nil, computerUnavailable()
	}
	path := binding.Creation.RelativePath + "/check.txt"
	var op mutationct.Operation = mutationct.Write{RelativePath: path, Content: selfTestFileBefore}
	if edit {
		op = mutationct.Edit{RelativePath: path, ExpectedSHA256: selfTestFileHash(selfTestFileBefore), Edits: []mutationct.TextEdit{{OldText: selfTestFileBefore, NewText: selfTestFileAfter}}}
	}
	out, err := connector.mutateForSelfTest(bounded, slot, operation, call, mutationct.ConnectorRequest{WorkspaceID: r.workspace, Operation: op}, r, &binding)
	if err != nil || out == nil {
		return out, err
	}
	if !edit && out.Phase == "completed" && out.Publication == "durable" && out.OperationID == operation && out.RelativePath == path && out.Receipt != nil && out.Receipt.Operation == "write" && out.Receipt.AfterSHA256 == selfTestFileHash(selfTestFileBefore) {
		s.mu.Lock()
		r.fixtureWriteHash = out.Receipt.AfterSHA256
		s.mu.Unlock()
	}
	return out, nil
}
