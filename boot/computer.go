package boot

import (
	"context"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	execution "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	filesystem "github.com/legrch/farol/modules/computer/infra/filesystem"
	admissionpeer "github.com/legrch/farol/modules/computer/infra/peer/admission"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	taskct "github.com/legrch/farol/modules/task/contracts/admission"
	"github.com/legrch/farol/transport/desktop"
)

// ComputerRoute belongs to trusted root composition. It captures the selected
// live Task/Chat owner and native Computer owner; wire IDs select neither.
// It owns no positive admission cache and never opens, restores or repairs state.
type ComputerRoute struct {
	issuer    *execution.Service
	workspace computerport.Workspace
	clock     computerport.Clock
}

// ComputerForChat takes the actual admitted handle's published facade and the
// already qualified native state owner. The immutable seal comes from its
// original admission, never decoded startup metadata or request correlation.
func ComputerForChat(store *accessrepo.Store, current *chatct.Current, seal execution.Ceiling, native *filesystem.Workspace) (*ComputerRoute, error) {
	if store == nil || current == nil || native == nil {
		return nil, computerUnavailable()
	}
	peer, err := admissionpeer.NewChat(current)
	if err != nil {
		return nil, computerFailure(err)
	}
	return computerRoute(store, peer, seal, native, accessrepo.Clock{})
}

// ComputerForTask selects the exact delegated task facade once, independently
// of every desktop request. Boot keeps this route for that owner's lifetime.
func ComputerForTask(store *accessrepo.Store, current *taskct.Contract, seal execution.Ceiling, native *filesystem.Workspace) (*ComputerRoute, error) {
	if store == nil || current == nil || native == nil {
		return nil, computerUnavailable()
	}
	peer, err := admissionpeer.NewTask(current)
	if err != nil {
		return nil, computerFailure(err)
	}
	return computerRoute(store, peer, seal, native, accessrepo.Clock{})
}

// Interfaces below are existing consumer ports, permitting explicitly labelled
// aggregate doubles. Public production constructors require concrete owners.
func computerRoute(access computerport.AccessRepository, current computerport.CurrentTaskAdmission, seal execution.Ceiling, native computerport.Workspace, clock computerport.Clock) (*ComputerRoute, error) {
	if native == nil {
		return nil, computerUnavailable()
	}
	issuer, err := execution.New(access, current, clock, seal)
	if err != nil {
		return nil, computerFailure(err)
	}
	return &ComputerRoute{issuer: issuer, workspace: native, clock: clock}, nil
}
func computerUnavailable() error {
	return &workspacect.Failure{Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", Source: "authority-store", Retry: "never"}
}
func computerFailure(err error) error {
	var failure *authority.Failure
	if errors.As(err, &failure) && failure != nil {
		// Connector lifetime withdrawal is an unavailable current authority,
		// expressed through the existing public workspace refusal vocabulary.
		if failure.Code == "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" && failure.Source == "connector-owner" {
			return computerUnavailable()
		}
		return &workspacect.Failure{Code: failure.Code, Source: failure.Source, Retry: "never"}
	}
	return err // No unclassified error establishes an absent owner or replay.
}
func (r *ComputerRoute) selectContract(ctx context.Context, expected computerport.TaskBinding, kind authority.Capability) (*workspacect.Contract, error) {
	if r == nil || r.issuer == nil {
		return nil, computerUnavailable()
	}
	// Exactly one immutable ordinary read lease for this entire parsed operation.
	// Computer's snapshot gate encloses the existing Task/Chat no-IO owner gate.
	lease, err := r.issuer.Admit(ctx, kind)
	if err != nil {
		return nil, computerFailure(err)
	}
	if lease.Binding() != expected {
		return nil, &workspacect.Failure{Code: "AUTHORITY_TASK_MISMATCH", Source: "task-grant", Retry: "never"}
	}
	service, err := workspacesvc.NewForExecution(lease, r.workspace, r.clock)
	if err != nil {
		return nil, computerFailure(err)
	}
	return workspacect.New(service), nil
}
func operationBinding(owner, session, task string, epoch uint64, participant, turn string) computerport.TaskBinding {
	return computerport.TaskBinding{Identity: authority.Identity{OwnerID: owner, SessionID: session, TaskID: task, TaskEpoch: epoch}, ParticipantID: participant, TurnID: turn}
}

// Methods is explicit registration for a previously selected live route. Missing
// legitimate state is not filled by a default participant or latest-task lookup.
// Root Serve does not adopt this preparation until its trusted ingress is wired.
func (r *ComputerRoute) Methods(peer wire.Context) map[string]desktop.Method {
	return map[string]desktop.Method{
		"computer.workspace.search": desktop.SearchMethod(func(ctx context.Context, in workspacect.SearchRequest) (*workspacect.Contract, error) {
			return r.selectContract(ctx, operationBinding(in.OwnerID, in.SessionID, in.TaskID, in.TaskEpoch, in.ParticipantID, in.TurnID), authority.Search)
		}, peer),
		"computer.workspace.list": desktop.ListMethod(func(ctx context.Context, in workspacect.ListRequest) (*workspacect.Contract, error) {
			return r.selectContract(ctx, operationBinding(in.OwnerID, in.SessionID, in.TaskID, in.TaskEpoch, in.ParticipantID, in.TurnID), authority.List)
		}, peer),
		"computer.workspace.read": desktop.ReadMethodForOperation(func(ctx context.Context, op desktop.ReadOperation) (*workspacect.Contract, error) {
			in := op.Input
			return r.selectContract(ctx, operationBinding(in.OwnerID, in.SessionID, in.TaskID, in.TaskEpoch, in.ParticipantID, in.TurnID), authority.Read)
		}, peer),
		"computer.workspace.catalogue": desktop.CatalogueMethod(func(ctx context.Context, in workspacect.CatalogueRequest) (*workspacect.Contract, error) {
			return r.selectContract(ctx, operationBinding(in.OwnerID, in.SessionID, in.TaskID, in.TaskEpoch, in.ParticipantID, in.TurnID), authority.List)
		}, peer),
		"computer.workspace.bootstrap": desktop.BootstrapMethod(func(ctx context.Context, in workspacect.BootstrapRequest) (*workspacect.Contract, error) {
			return r.selectContract(ctx, operationBinding(in.OwnerID, in.SessionID, in.TaskID, in.TaskEpoch, in.ParticipantID, in.TurnID), authority.Read)
		}, peer),
	}
}
