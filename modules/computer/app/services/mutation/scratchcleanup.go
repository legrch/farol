package mutation

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type ScratchCleanupResponse struct {
	Phase, Publication string
	Failure            *Failure
}

// CleanupScratch is for the private self-test composition only. Its caller
// must hold the same whole-run process exclusion through this call and its
// return, and must join all possible writers before calling it. The journal,
// native port and owner lease do not establish those facts. It never cleans an
// unknown creation or executes an existing cleanup record.
func (s *OwnerService) CleanupScratch(ctx context.Context, workspaceID string, native port.ScratchCleanupWorkspace) (*ScratchCleanupResponse, error) {
	if s == nil || s.engine == nil || ctx == nil || ctx.Err() != nil || native == nil || !state.Identifier(workspaceID, 120) {
		return nil, invalid()
	}
	repo, ok := s.engine.repository.(port.ScratchCleanupRepository)
	if !ok {
		return nil, storeUnavailable()
	}
	s.engine.gate.Lock()
	if s.engine.pending {
		s.engine.gate.Unlock()
		return nil, authority.Fail("COMPUTER_MUTATION_IN_PROGRESS", "operation-store")
	}
	if s.cleanupStarted {
		if workspaceID != s.cleanupWorkspace || s.cleanupInventory != nil {
			s.engine.gate.Unlock()
			return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
		}
		out, err := copyCleanupResponse(s.cleanupResult), s.cleanupError
		s.engine.gate.Unlock()
		return out, err
	}
	s.cleanupStarted = true
	s.cleanupWorkspace = workspaceID
	s.engine.pending = true
	s.engine.gate.Unlock()
	finish := func(out *ScratchCleanupResponse, err error) (*ScratchCleanupResponse, error) {
		s.engine.gate.Lock()
		s.engine.pending = false
		s.cleanupResult, s.cleanupError = copyCleanupResponse(out), err
		s.engine.gate.Unlock()
		return copyCleanupResponse(out), err
	}
	creation, err := s.engine.repository.Load(ctx, s.selected.identity())
	if err != nil {
		return finish(nil, unknown("operation-store"))
	}
	prepared, err := state.NewScratchCleanup(creation)
	if err != nil {
		return finish(nil, storeUnavailable())
	}
	b := prepared.Binding().Creation
	if b.Identity != s.selected.identity() || b.ComputerGeneration != s.selected.ComputerGeneration || b.WorkspaceID != workspaceID || b.Scratch.RunID != s.selected.OperationID || b.RelativePath != state.ScratchPath(s.selected.OperationID) {
		return finish(nil, authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store"))
	}
	descriptor, err := s.engine.current(ctx, workspaceID, b.RelativePath, nil, nil)
	if err != nil {
		return finish(nil, err)
	}
	if descriptor.Root != b.Scratch.Root || descriptor.ApprovedRoot.Path != b.Scratch.Root || descriptor.ApprovedRoot.Device != b.Scratch.RootIdentity.Device || descriptor.ApprovedRoot.Inode != b.Scratch.RootIdentity.Inode {
		return finish(nil, authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy"))
	}
	admission, err := repo.AdmitScratchCleanup(ctx, prepared)
	if err != nil || admission.Record == nil || admission.Record.Binding() != prepared.Binding() {
		return finish(nil, unknown("operation-store"))
	}
	if admission.Status == port.MutationExisting {
		if _, err := state.RestoreScratchCleanup(admission.Record.Binding(), admission.Record.Phase(), admission.Record.Failure()); err != nil {
			return finish(nil, unknown("operation-store"))
		}
		return finish(cleanupResult(admission.Record, "durable"), nil)
	}
	if admission.Status != port.MutationAdmitted || admission.Record.Phase() != state.Prepared {
		return finish(nil, unknown("operation-store"))
	}
	guard := func(ctx context.Context) error {
		_, err := s.engine.current(ctx, workspaceID, b.RelativePath, &descriptor, nil)
		return err
	}
	request := port.ScratchCleanupRequest{Workspace: descriptor, Binding: prepared.Binding(), BeforePublish: guard,
		WithPublication: func(ctx context.Context, publish func() error) error {
			_, err := s.engine.current(ctx, workspaceID, b.RelativePath, &descriptor, publish)
			return err
		}}
	err = guard(ctx)
	if err == nil {
		err = native.RemoveEmptyScratch(ctx, request)
	}
	phase := state.Completed
	var failure *state.Failure
	if err != nil {
		f := state.NativeFailure("")
		var classified *authority.Failure
		if errors.As(err, &classified) {
			if classified.Source == "native-workspace" {
				f = state.NativeFailure(classified.Code)
			} else {
				f = state.Failure{Code: classified.Code, Source: classified.Source}
			}
		}
		phase = state.Failed
		if f.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
			phase = state.OutcomeUnknown
		}
		failure = &f
	}
	terminal, err := state.RestoreScratchCleanup(prepared.Binding(), phase, failure)
	if err != nil {
		terminal, _ = state.RestoreScratchCleanup(prepared.Binding(), state.OutcomeUnknown, &state.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"})
	}
	publication := "durable"
	if terminal == nil || repo.SaveScratchCleanup(ctx, terminal) != nil {
		publication = "memory_only"
	}
	if terminal == nil {
		return finish(nil, unknown("operation-store"))
	}
	return finish(cleanupResult(terminal, publication), nil)
}

func cleanupResult(record *state.ScratchCleanupState, publication string) *ScratchCleanupResponse {
	out := &ScratchCleanupResponse{Phase: string(record.Phase()), Publication: publication}
	if f := record.Failure(); f != nil {
		out.Failure = &Failure{Code: f.Code, Source: f.Source}
	}
	if record.Phase() == state.Prepared {
		out.Phase = string(state.OutcomeUnknown)
		out.Failure = &Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
	}
	return out
}

func copyCleanupResponse(in *ScratchCleanupResponse) *ScratchCleanupResponse {
	if in == nil {
		return nil
	}
	out := *in
	if in.Failure != nil {
		f := *in.Failure
		out.Failure = &f
	}
	return &out
}
