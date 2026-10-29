package mutation

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type ExecuteRequest = CheckRequest
type Receipt struct {
	Operation, RelativePath string
	Bytes                   uint64
	Replacements            uint32
	BeforeSHA256            *string
	AfterSHA256             string
	Directory               state.DirectoryIdentity
}
type ExecuteResponse struct {
	OperationID, WorkspaceID, CallID, TurnID string
	Generation                               uint64
	Phase, Publication                       string
	Receipt                                  *Receipt
	Failure                                  *Failure
}
type Failure struct {
	Code, Source string
	Directory    state.DirectoryIdentity
}

func (s *Service) Execute(ctx context.Context, r ExecuteRequest) (*ExecuteResponse, error) {
	if !s.matches(r) {
		return nil, invalid()
	}
	if _, err := s.Check(ctx, r); err != nil {
		return nil, err
	}
	op := convert(r.Operation)
	digest, err := s.digester.Digest(port.MutationDigestInput{WorkspaceID: r.WorkspaceID, Operation: op.Clone()})
	if err != nil || !state.SHA256(digest) {
		return nil, authority.Fail("COMPUTER_MUTATION_FINGERPRINT_FAILED", "operation-store")
	}
	binding := state.Binding{Identity: identity(r), WorkspaceID: r.WorkspaceID, RequestDigest: digest}
	out, err := s.executeBound(ctx, binding, op)
	if err != nil {
		return nil, err
	}
	return taskResponse(r, out), nil
}

// executeBound is the single admission/native/publication engine. Task and
// owner Settings select different authority owners, never different retries.
func (s *Service) executeBound(ctx context.Context, binding state.Binding, op state.Operation) (*attemptResult, error) {
	s.gate.Lock()
	if s.binding != nil && *s.binding != binding {
		s.gate.Unlock()
		return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
	}
	if s.pending {
		s.gate.Unlock()
		return nil, authority.Fail("COMPUTER_MUTATION_IN_PROGRESS", "operation-store")
	}
	if s.terminal != nil {
		record, publication := s.terminal.Clone(), s.publication
		s.gate.Unlock()
		return s.discloseResult(ctx, binding.WorkspaceID, op.Path(), &record, publication)
	}
	if s.blocked != nil {
		err := s.blocked
		s.gate.Unlock()
		return nil, err
	}
	s.binding = &binding
	s.pending = true
	s.gate.Unlock()
	finish := func(record *state.State, publication string, err error) (*attemptResult, error) {
		s.gate.Lock()
		s.pending = false
		if record != nil {
			copy := record.Clone()
			s.terminal = &copy
			s.publication = publication
		} else {
			s.blocked = err
		}
		s.gate.Unlock()
		if err != nil {
			return nil, err
		}
		return s.discloseResult(ctx, binding.WorkspaceID, op.Path(), record, publication)
	}
	descriptor, err := s.current(ctx, binding.WorkspaceID, op.Path(), nil, nil)
	if err != nil {
		return finish(nil, "", err)
	}
	prepared, err := state.NewPrepared(binding)
	if err != nil {
		return finish(nil, "", invalid())
	}
	admitted, err := s.repository.Admit(ctx, prepared)
	if err != nil || admitted.Record == nil {
		return finish(nil, "", unknown("operation-store"))
	}
	if admitted.Record.Binding() != binding {
		if admitted.Status == port.MutationExisting && admitted.Record.Binding().Identity == binding.Identity {
			return finish(nil, "", authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store"))
		}
		return finish(nil, "", unknown("operation-store"))
	}
	record := admitted.Record.Clone()
	if admitted.Status == port.MutationExisting {
		if _, err := record.Recover(binding); err != nil {
			return finish(nil, "", storeUnavailable())
		}
		// Prepared may still belong to an active peer. Observe unknown without
		// rewriting/tombstoning it or dispatching another execution.
		return finish(&record, "durable", nil)
	}
	if admitted.Status != port.MutationAdmitted || record.Phase() != state.Prepared {
		return finish(nil, "", unknown("operation-store"))
	}
	var native *port.MutationReceipt
	errGuard := func(ctx context.Context) error {
		_, err := s.current(ctx, binding.WorkspaceID, op.Path(), &descriptor, nil)
		return err
	}
	request := port.MutationRequest{Workspace: descriptor, Operation: op.Clone(), BeforePublish: errGuard,
		WithPublication: func(ctx context.Context, publish func() error) error {
			_, err := s.current(ctx, binding.WorkspaceID, op.Path(), &descriptor, publish)
			return err
		}}
	if err = errGuard(ctx); err == nil {
		if _, scratch := op.(state.Scratch); scratch {
			terminal, publication, finalErr := s.stagedNative(ctx, op, record, request)
			return finish(terminal, publication, finalErr)
		}
		native, err = s.native.Mutate(ctx, request)
	}
	terminal, publication, err := s.terminalNative(ctx, op, record, native, err)
	return finish(terminal, publication, err)
}

// stagedNative owns the gate across native execution and the single terminal
// save. No producer callback can outlive the gate or write a late result.
func (s *Service) stagedNative(ctx context.Context, op state.Operation, record state.State, request port.MutationRequest) (*state.State, string, error) {
	stage, ok := s.native.(port.StagedMutableWorkspace)
	if !ok {
		return nil, "", unknown("native-workspace")
	}
	attempt, err := stage.BeginStage(ctx, request)
	if err != nil || attempt == nil {
		if attempt != nil {
			attempt.Release()
		}
		// No late write: retain the original durable Prepared evidence.
		return nil, "", unknown("native-workspace")
	}
	defer attempt.Release()
	receipt, nativeErr := attempt.Execute(ctx)
	return s.terminalNative(ctx, op, record, receipt, nativeErr)
}

// terminalNative classifies the original attempt and makes one terminal save.
// It is called only after the native lifetime has finished.
func (s *Service) terminalNative(ctx context.Context, op state.Operation, record state.State, native *port.MutationReceipt, err error) (*state.State, string, error) {
	var terminal *state.State
	if err == nil && native != nil {
		receipt := state.Receipt{Operation: state.Kind(native.Operation), RelativePath: native.RelativePath, Bytes: native.Bytes, Replacements: native.Replacements, BeforeSHA256: cloneHash(native.BeforeSHA256), AfterSHA256: native.AfterSHA256, Directory: native.Directory}
		if state.ValidNativeReceipt(receipt, op) && preimageMatches(op, receipt.BeforeSHA256) {
			terminal, err = record.Complete(receipt)
		} else {
			err = unknown("native-workspace")
		}
	} else if err == nil {
		err = unknown("native-workspace")
	}
	if terminal == nil {
		var f *authority.Failure
		failure := state.NativeFailure("")
		if errors.As(err, &f) {
			if f.Source == "native-workspace" {
				failure = state.NativeFailure(f.Code)
			} else {
				failure = state.Failure{Code: f.Code, Source: f.Source}
			}
		}
		if _, ok := op.(state.Scratch); ok && native != nil && native.Directory != (state.DirectoryIdentity{}) {
			failure = state.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"}
			if native.Directory.Valid() {
				failure.Directory = native.Directory
			}
		}
		terminal, err = record.Refuse(failure)
		if err != nil {
			terminal, _ = record.Refuse(state.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"})
		}
	}
	if terminal == nil {
		return nil, "", unknown("operation-store")
	}
	publication := "durable"
	// One terminal publication attempt. Memory retains the known result even
	// when persistence acknowledgement is lost; restart never executes Prepared.
	copy := terminal.Clone()
	if err := s.repository.Save(ctx, &copy); err != nil {
		publication = "memory_only"
	}
	return terminal, publication, nil
}
func preimageMatches(op state.Operation, observed *string) bool {
	switch v := op.(type) {
	case state.Scratch:
		return observed == nil
	case state.Write:
		return v.ExpectedSHA256 == nil && observed == nil || v.ExpectedSHA256 != nil && observed != nil && *v.ExpectedSHA256 == *observed
	case state.Edit:
		return observed != nil && v.ExpectedSHA256 == *observed
	}
	return false
}

type attemptResult struct {
	Phase, Publication string
	Receipt            *Receipt
	Failure            *Failure
}

func resultOf(record *state.State, publication string) *attemptResult {
	out := &attemptResult{Phase: string(record.Phase()), Publication: publication}
	if receipt := record.Receipt(); receipt != nil {
		out.Receipt = &Receipt{Operation: string(receipt.Operation), RelativePath: receipt.RelativePath, Bytes: receipt.Bytes, Replacements: receipt.Replacements, BeforeSHA256: cloneHash(receipt.BeforeSHA256), AfterSHA256: receipt.AfterSHA256, Directory: receipt.Directory}
	}
	if failure := record.Failure(); failure != nil {
		out.Failure = &Failure{Code: failure.Code, Source: failure.Source, Directory: failure.Directory}
	}
	if record.Phase() == state.Prepared {
		out.Phase = string(state.OutcomeUnknown)
		out.Failure = &Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
	}
	return out
}

func taskResponse(r CheckRequest, out *attemptResult) *ExecuteResponse {
	return &ExecuteResponse{OperationID: r.OperationID, WorkspaceID: r.WorkspaceID, CallID: r.CallID, TurnID: r.TurnID, Generation: r.Generation,
		Phase: out.Phase, Publication: out.Publication, Receipt: out.Receipt, Failure: out.Failure}
}

func (s *Service) discloseResult(ctx context.Context, workspaceID, path string, record *state.State, publication string) (*attemptResult, error) {
	var response *attemptResult
	_, err := s.current(ctx, workspaceID, path, nil, func() error {
		response = resultOf(record, publication)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

func (s *Service) disclose(ctx context.Context, r CheckRequest, path string, record *state.State, publication string) (*ExecuteResponse, error) {
	out, err := s.discloseResult(ctx, r.WorkspaceID, path, record, publication)
	if err != nil {
		return nil, err
	}
	return taskResponse(r, out), nil
}
