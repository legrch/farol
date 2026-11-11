package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type stopAdvanceBody struct {
	ParentOperationID string                       `json:"parentOperationId"`
	Phase             journal.StopPhase            `json:"phase"`
	Closure           *journal.StopClosure         `json:"closure,omitempty"`
	SettingsIntent    *journal.StopSettingsPlan    `json:"settingsIntent,omitempty"`
	SettingsAck       *journal.StopSettingsReceipt `json:"settingsAck,omitempty"`
	CleanupAck        *journal.StopCleanupReceipt  `json:"cleanupAck,omitempty"`
}
type stopRefuseBody struct {
	ParentOperationID string `json:"parentOperationId"`
}

func stopOutcome(value any, err error) (*desktop.Outcome, error) {
	switch {
	case errors.Is(err, journal.ErrStopRefused):
		return &desktop.Outcome{Status: "refused", Code: "computer_stop_refused"}, nil
	case errors.Is(err, journal.ErrStopPending):
		return &desktop.Outcome{Status: "refused", Code: "computer_stop_pending"}, nil
	case errors.Is(err, journal.ErrStopCapacity):
		return &desktop.Outcome{Status: "refused", Code: "computer_stop_capacity"}, nil
	default:
		return ingressOutcome(value, err)
	}
}

// Explicit, trusted host-pipe operations only. All original effect decisions
// stay with the Go app owner and its protected existing Store. No renderer
// operation can manufacture a certificate or bypass a pending original Stop.
func (s *ComputerIngress) stopMethods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"computer.stop.status": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerStopStatusRequest", r.Body) != nil {
				return invalidIngress()
			}
			if s == nil || s.stopOwner == nil {
				return nil, computerUnavailable()
			}
			ledger, err := s.stopOwner.Status(ctx)
			if err != nil {
				return stopOutcome(nil, err)
			}
			status := struct {
				Present            bool    `json:"present"`
				Restricted         bool    `json:"restricted"`
				EntryCount         uint32  `json:"entryCount"`
				Delivery           string  `json:"delivery"`
				PendingOperationID *string `json:"pendingOperationId,omitempty"`
				PendingPhase       *string `json:"pendingPhase,omitempty"`
			}{Present: len(ledger.Entries) != 0, Restricted: ledger.Pending(), EntryCount: uint32(len(ledger.Entries)), Delivery: "not_recorded"}
			for _, item := range ledger.Entries {
				if !item.Terminal() {
					if status.PendingOperationID != nil {
						return nil, computerUnavailable()
					}
					id, phase := item.Request.OperationID, string(item.Phase)
					if item.Phase == journal.StopUnresolved {
						phase = "unresolved"
					}
					status.PendingOperationID, status.PendingPhase = &id, &phase
				}
			}
			return ingressOutcome(status, nil)
		}},
		"computer.stop.admit": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerStopAdmitRequest", r.Body) != nil {
				return invalidIngress()
			}
			if s == nil || s.stopOwner == nil {
				return nil, computerUnavailable()
			}
			var req journal.StopRequest
			if json.Unmarshal(r.Body, &req) != nil || req.OperationID != r.OperationID {
				return invalidIngress()
			}
			entry, first, err := s.stopOwner.Begin(ctx, req)
			if err != nil {
				return stopOutcome(nil, err)
			}
			if !first || entry.Phase != journal.StopEffectIntent {
				return stopOutcome(nil, journal.ErrStopRefused)
			}
			return ingressOutcome(struct {
				ParentOperationID string `json:"parentOperationId"`
				Phase             string `json:"phase"`
				First             bool   `json:"first"`
				StopEffectID      string `json:"stopEffectId"`
				RuntimeID         string `json:"runtimeId"`
				BackendGeneration string `json:"backendGeneration"`
				BuildID           string `json:"buildId"`
			}{entry.Request.OperationID, string(entry.Phase), true,
				entry.Request.StopEffectID, entry.Request.RuntimeID,
				entry.Request.BackendGeneration, entry.Request.BuildID}, nil)
		}},
		"computer.stop.advance": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerStopAdvanceRequest", r.Body) != nil {
				return invalidIngress()
			}
			if s == nil || s.stopOwner == nil {
				return nil, computerUnavailable()
			}
			var req stopAdvanceBody
			if json.Unmarshal(r.Body, &req) != nil || req.ParentOperationID == r.OperationID {
				return invalidIngress()
			}
			entry, err := s.stopOwner.Advance(ctx, req.ParentOperationID, req.Phase,
				req.Closure, req.SettingsIntent, req.SettingsAck, req.CleanupAck)
			if err != nil {
				return stopOutcome(nil, err)
			}
			return ingressOutcome(struct {
				ParentOperationID string `json:"parentOperationId"`
				Phase             string `json:"phase"`
				Delivery          string `json:"delivery"`
			}{entry.Request.OperationID, string(entry.Phase), "not_recorded"}, nil)
		}},
		"computer.stop.refuse": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerStopRefuseRequest", r.Body) != nil {
				return invalidIngress()
			}
			if s == nil || s.stopOwner == nil {
				return nil, computerUnavailable()
			}
			var req stopRefuseBody
			if json.Unmarshal(r.Body, &req) != nil || req.ParentOperationID == r.OperationID {
				return invalidIngress()
			}
			if err := s.stopOwner.RefuseBeforeStop(ctx, req.ParentOperationID); err != nil {
				return stopOutcome(nil, err)
			}
			return ingressOutcome(struct {
				ParentOperationID string `json:"parentOperationId"`
				Phase             string `json:"phase"`
			}{req.ParentOperationID, string(journal.StopRefusedBeforeDispatch)}, nil)
		}},
	}
}
