package mutation

import (
	"bytes"
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

var _ port.SelfTestMarkerRepository = (*Repository)(nil)

func (r *Repository) loadSelfTestMarker(key string, binding domain.SelfTestBinding) (*domain.SelfTestMarker, []byte, error) {
	raw, err := r.disk.read(key)
	if err != nil {
		return nil, nil, unavailable()
	}
	if raw == nil {
		return nil, nil, nil
	}
	marker, err := decodeSelfTestMarker(raw)
	if err != nil {
		return nil, nil, err
	}
	if marker.Binding() != binding {
		return nil, nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return marker, raw, nil
}

func (r *Repository) AdmitSelfTestMarker(ctx context.Context, marker *domain.SelfTestMarker) (port.SelfTestMarkerAdmission, error) {
	var out port.SelfTestMarkerAdmission
	raw, err := encodeSelfTestMarker(marker)
	if err != nil {
		return out, err
	}
	if marker.Phase() != domain.SelfTestMarkerSelected {
		return out, failure("WORKSPACE_MUTATION_ADMISSION_NOT_PREPARED")
	}
	binding := marker.Binding()
	key, err := selfTestMarkerKey(binding)
	if err != nil || r == nil {
		return out, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	existing, _, err := r.loadSelfTestMarker(key, binding)
	if err != nil {
		return out, err
	}
	if existing != nil {
		return port.SelfTestMarkerAdmission{Status: port.MutationExisting, Record: existing}, r.ready(ctx)
	}
	markers := make([]port.SelfTestMarkerHistoryEntry, 0)
	var stats selfTestInventoryStats
	entries, err := r.listSelfTestInventoryLocked(ctx, binding.Identity.OwnerID, binding.Identity.ProfileID, binding.Identity.ComputerID, &markers, &stats)
	if err != nil {
		return out, err
	}
	// Never publish a record that would make the next complete inventory
	// unreadable. Capacity refusal does not delete or reinterpret history.
	if len(markers) >= maxSelfTestHistory || len(stats.names) >= maxSelfTestInventory || stats.bytes+len(raw) > maxSelfTestInventoryBytes {
		return out, failure("COMPUTER_SELFTEST_HISTORY_FULL")
	}
	for _, prior := range markers {
		if prior.Binding.WorkspaceID == binding.WorkspaceID && prior.Phase != domain.SelfTestMarkerSettled {
			return out, failure("COMPUTER_SELFTEST_UNRESOLVED")
		}
	}
	for _, prior := range entries {
		if prior.Binding.WorkspaceID == binding.WorkspaceID && (prior.Phase == domain.Prepared || prior.Phase == domain.OutcomeUnknown) {
			return out, failure("COMPUTER_SELFTEST_UNRESOLVED")
		}
	}
	if err = r.disk.create(key, bytes.Clone(raw)); errors.Is(err, errExists) {
		// Collision can never confer an admission permit.
		existing, _, err = r.loadSelfTestMarker(key, binding)
		if err == nil && existing != nil && ctx.Err() == nil && r.disk.check() == nil {
			return port.SelfTestMarkerAdmission{Status: port.MutationExisting, Record: existing}, nil
		}
		r.fenced = true
		return out, unknown()
	}
	if err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	observed, observedRaw, err := r.loadSelfTestMarker(key, binding)
	if err != nil || observed == nil || !bytes.Equal(raw, observedRaw) || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	return port.SelfTestMarkerAdmission{Status: port.MutationAdmitted, Record: observed}, nil
}

func (r *Repository) LoadSelfTestMarker(ctx context.Context, binding domain.SelfTestBinding) (*domain.SelfTestMarker, error) {
	key, err := selfTestMarkerKey(binding)
	if err != nil || r == nil {
		return nil, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.ready(ctx); err != nil {
		return nil, err
	}
	marker, _, err := r.loadSelfTestMarker(key, binding)
	if err != nil {
		return nil, err
	}
	if err := r.ready(ctx); err != nil {
		return nil, err
	}
	return marker, nil
}

func (r *Repository) BeginSelfTestMarkerSettlement(ctx context.Context, binding domain.SelfTestBinding) error {
	return r.transitionSelfTestMarker(ctx, binding, false)
}

func (r *Repository) FinishSelfTestMarker(ctx context.Context, binding domain.SelfTestBinding) error {
	return r.transitionSelfTestMarker(ctx, binding, true)
}

func (r *Repository) transitionSelfTestMarker(ctx context.Context, binding domain.SelfTestBinding, finish bool) error {
	key, err := selfTestMarkerKey(binding)
	if err != nil || r == nil {
		return unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return err
	}
	marker, previous, err := r.loadSelfTestMarker(key, binding)
	if err != nil {
		return err
	}
	if marker == nil {
		return failure("WORKSPACE_MUTATION_STATE_MISSING")
	}
	parentKey, err := selfTestKey(binding.Identity)
	if err != nil {
		return err
	}
	parent, _, err := r.loadSelfTest(parentKey, binding)
	if err != nil {
		return err
	}
	if parent == nil || (parent.Phase() != domain.Completed && parent.Phase() != domain.Failed) {
		return failure("WORKSPACE_MUTATION_STATE_MISSING")
	}
	var next *domain.SelfTestMarker
	if finish {
		next, err = marker.ConfirmSettlement(parent)
	} else {
		next, err = marker.BeginSettlement()
	}
	if err != nil {
		return failure("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	}
	raw, err := encodeSelfTestMarker(next)
	if err != nil {
		return err
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
