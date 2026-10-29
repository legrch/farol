package mutation

import (
	"bytes"
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

var _ port.SelfTestRepository = (*Repository)(nil)

func (r *Repository) loadSelfTest(key string, binding domain.SelfTestBinding) (*domain.SelfTestState, []byte, error) {
	raw, err := r.disk.read(key)
	if err != nil {
		return nil, nil, unavailable()
	}
	if raw == nil {
		return nil, nil, nil
	}
	state, err := decodeSelfTest(raw)
	if err != nil {
		return nil, nil, err
	}
	if state.Binding() != binding {
		return nil, nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return state, raw, nil
}

func (r *Repository) AdmitSelfTest(ctx context.Context, state *domain.SelfTestState) (port.SelfTestAdmission, error) {
	var out port.SelfTestAdmission
	raw, err := encodeSelfTest(state)
	if err != nil {
		return out, err
	}
	if state.Phase() != domain.Prepared {
		return out, failure("WORKSPACE_MUTATION_ADMISSION_NOT_PREPARED")
	}
	binding := state.Binding()
	key, err := selfTestKey(binding.Identity)
	if err != nil || r == nil {
		return out, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	existing, _, err := r.loadSelfTest(key, binding)
	if err != nil {
		return out, err
	}
	if existing != nil {
		if err = r.ready(ctx); err != nil {
			return out, err
		}
		return port.SelfTestAdmission{Status: port.MutationExisting, Record: existing}, nil
	}
	if binding.Version == 2 {
		markerKey, err := selfTestMarkerKey(binding)
		if err != nil {
			return out, err
		}
		marker, _, err := r.loadSelfTestMarker(markerKey, binding)
		if err != nil {
			return out, err
		}
		if marker == nil || marker.Phase() != domain.SelfTestMarkerSelected {
			return out, failure("COMPUTER_SELFTEST_MARKER_REQUIRED")
		}
		markers := make([]port.SelfTestMarkerHistoryEntry, 0)
		var stats selfTestInventoryStats
		history, err := r.listSelfTestInventoryLocked(ctx, binding.Identity.OwnerID, binding.Identity.ProfileID, binding.Identity.ComputerID, &markers, &stats)
		if err != nil {
			return out, err
		}
		if len(history) >= maxSelfTestHistory || len(stats.names) >= maxSelfTestInventory || stats.bytes+len(raw) > maxSelfTestInventoryBytes {
			return out, failure("COMPUTER_SELFTEST_HISTORY_FULL")
		}
		for _, other := range markers {
			if other.Binding.WorkspaceID == binding.WorkspaceID && other.Binding != binding && !selfTestMarkerHasKnownTerminal(other, history) {
				return out, failure("COMPUTER_SELFTEST_UNRESOLVED")
			}
		}
		for _, other := range history {
			if other.Binding.WorkspaceID == binding.WorkspaceID && (other.Phase == domain.Prepared || other.Phase == domain.OutcomeUnknown) {
				return out, failure("COMPUTER_SELFTEST_UNRESOLVED")
			}
		}
	}
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	err = r.disk.create(key, bytes.Clone(raw))
	if errors.Is(err, errExists) {
		existing, _, err = r.loadSelfTest(key, binding)
		if err == nil && existing != nil && ctx.Err() == nil && r.disk.check() == nil {
			return port.SelfTestAdmission{Status: port.MutationExisting, Record: existing}, nil
		}
		r.fenced = true
		return out, unknown()
	}
	if err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	observed, observedRaw, err := r.loadSelfTest(key, binding)
	if err != nil || observed == nil || !bytes.Equal(observedRaw, raw) || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	return port.SelfTestAdmission{Status: port.MutationAdmitted, Record: observed}, nil
}

func (r *Repository) LoadSelfTest(ctx context.Context, binding domain.SelfTestBinding) (*domain.SelfTestState, error) {
	key, err := selfTestKey(binding.Identity)
	if err != nil || !binding.Valid() || r == nil {
		return nil, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	state, _, err := r.loadSelfTest(key, binding)
	if err != nil {
		return nil, err
	}
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	return state, nil
}

// One terminal save only; lost publication fences this writer and must never
// cause another save or execution of the original attempt.
func (r *Repository) SaveSelfTest(ctx context.Context, state *domain.SelfTestState) error {
	raw, err := encodeSelfTest(state)
	if err != nil {
		return err
	}
	binding := state.Binding()
	key, err := selfTestKey(binding.Identity)
	if err != nil || r == nil {
		return unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return err
	}
	existing, previous, err := r.loadSelfTest(key, binding)
	if err != nil {
		return err
	}
	if existing == nil {
		return failure("WORKSPACE_MUTATION_STATE_MISSING")
	}
	if _, err = existing.Apply(*state); err != nil {
		return failure("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	}
	if err = r.ready(ctx); err != nil {
		return err
	}
	if err = r.disk.replace(key, bytes.Clone(raw), bytes.Clone(previous)); err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return unknown()
	}
	observed, err := r.disk.read(key)
	if err != nil || !bytes.Equal(raw, observed) || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return unknown()
	}
	return nil
}
