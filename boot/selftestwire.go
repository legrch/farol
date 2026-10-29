package boot

import (
	"context"
	"encoding/json"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func (s *computerConnector) currentSelfTestSlot(ctx context.Context) (*connectorSlot, error) {
	if s == nil {
		return nil, computerUnavailable()
	}
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer func() { <-s.effects }()
	if s.current == nil || s.current.closing || s.current.startupUncertain {
		return nil, computerUnavailable()
	}
	return s.current, nil
}

func selfTestWireResult(binding state.SelfTestBinding, report selfTestReport) (*wire.ComputerSelfTestReport, error) {
	out := &wire.ComputerSelfTestReport{OperationId: binding.Identity.OperationID, WorkspaceId: binding.WorkspaceID, ComputerGeneration: decimal(binding.ComputerGeneration), Status: report.Status, Steps: make([]wire.ComputerSelfTestStep, 0, len(report.Steps))}
	optional := func(v string) *string {
		if v == "" {
			return nil
		}
		copy := v
		return &copy
	}
	out.PlanVersion = optional(strconv.FormatUint(uint64(binding.Version), 10))
	for _, step := range report.Steps {
		out.Steps = append(out.Steps, wire.ComputerSelfTestStep{Name: step.Name, Status: step.Status, Code: optional(step.Code), OperationId: optional(step.Operation), Handle: optional(step.Handle), CancelOperationId: optional(step.CancelOperation), DescendantCleanup: optional(step.DescendantCleanup)})
	}
	if validateIngress("ComputerSelfTestReport", out) != nil {
		return nil, computerUnavailable()
	}
	return out, nil
}

func (s *computerConnector) selfTestMethods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"computer.selftest.reserve": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerSelfTestStart", r.Body) != nil {
				return invalidIngress()
			}
			var in wire.ComputerSelfTestStart
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			slot, err := s.currentSelfTestSlot(ctx)
			if err != nil {
				return &desktop.Outcome{Status: "unavailable", Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"}, nil
			}
			execution, err := s.selectSelfTest(ctx, slot, in.WorkspaceId, r.OperationID, in.Publication)
			if err != nil {
				return &desktop.Outcome{Status: "refused", Code: "COMPUTER_SELFTEST_UNAVAILABLE"}, nil
			}
			if !execution.reserveForStart(ctx) || s.checkMutationSlot(ctx, slot, slot.opened.Execution) != nil {
				return &desktop.Outcome{Status: "unknown", Code: "COMPUTER_SELFTEST_RESERVATION_UNKNOWN"}, nil
			}
			version := "2"
			return ingressOutcome(&wire.ComputerSelfTestObserve{OperationId: r.OperationID, WorkspaceId: in.WorkspaceId, ComputerGeneration: in.Publication.Generation, PlanVersion: &version}, nil)
		}},
		"computer.selftest.start": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerSelfTestStart", r.Body) != nil {
				return invalidIngress()
			}
			var in wire.ComputerSelfTestStart
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			slot, err := s.currentSelfTestSlot(ctx)
			if err != nil {
				return &desktop.Outcome{Status: "unavailable", Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"}, nil
			}
			execution, err := s.reservedSelfTest(slot, in.WorkspaceId, r.OperationID, in.Publication)
			if err != nil {
				return &desktop.Outcome{Status: "refused", Code: "COMPUTER_SELFTEST_UNAVAILABLE"}, nil
			}
			_ = execution.executeReserved(ctx)
			// Only a freshly authorized read of the durable parent is disclosed.
			report, err := s.observeConnectorSelfTest(ctx, slot, execution.binding)
			if err != nil {
				report = selfTestReport{Status: "unknown"}
			}
			result, err := selfTestWireResult(execution.binding, report)
			return ingressOutcome(result, err)
		}},
		"computer.selftest.observe": {Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerSelfTestObserve", r.Body) != nil {
				return invalidIngress()
			}
			var in wire.ComputerSelfTestObserve
			if json.Unmarshal(r.Body, &in) != nil {
				return invalidIngress()
			}
			generation, err := strconv.ParseUint(in.ComputerGeneration, 10, 64)
			if err != nil || generation > state.MaxSafeInteger || strconv.FormatUint(generation, 10) != in.ComputerGeneration {
				return invalidIngress()
			}
			slot, err := s.currentSelfTestSlot(ctx)
			if err != nil {
				return &desktop.Outcome{Status: "unavailable", Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"}, nil
			}
			version := uint8(1)
			if in.PlanVersion != nil && *in.PlanVersion == "2" {
				version = 2
			}
			binding := state.SelfTestBinding{Identity: state.Identity{Scope: state.ScopeOwnerSettings, OperationID: in.OperationId, OwnerID: s.root.ownerID, ProfileID: s.root.peer.ProfileId, ComputerID: s.root.computerID}, WorkspaceID: in.WorkspaceId, ComputerGeneration: generation, Version: version}
			report, err := s.observeConnectorSelfTest(ctx, slot, binding)
			if err != nil {
				return &desktop.Outcome{Status: "unavailable", Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE"}, nil
			}
			result, err := selfTestWireResult(binding, report)
			return ingressOutcome(result, err)
		}},
	}
}
