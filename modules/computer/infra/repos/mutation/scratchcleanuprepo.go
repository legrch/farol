package mutation

import (
	"bytes"
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

type ScratchCleanupAdmission = port.ScratchCleanupAdmission

var _ port.ScratchCleanupRepository = (*Repository)(nil)

// cleanupParent is called under the same exclusive writer lock as cleanup IO.
// Neither the supplied binding nor the presence of a name proves ownership.
func (r *Repository) cleanupParent(binding domain.ScratchCleanupBinding) error {
	id := binding.Creation.Identity
	key, err := recordKey(id)
	if err != nil {
		return err
	}
	parent, _, err := r.load(key, id)
	if err != nil {
		return err
	}
	if parent == nil || parent.Phase() != domain.Completed || parent.Binding() != binding.Creation || parent.Receipt() == nil || parent.Receipt().Operation != domain.ScratchKind || parent.Receipt().Directory != binding.Directory {
		return failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return nil
}

func (r *Repository) loadScratchCleanup(key string, binding domain.ScratchCleanupBinding) (*domain.ScratchCleanupState, []byte, error) {
	raw, err := r.disk.read(key)
	if err != nil {
		return nil, nil, unavailable()
	}
	if raw == nil {
		return nil, nil, nil
	}
	state, err := decodeScratchCleanup(raw)
	if err != nil {
		return nil, nil, err
	}
	if state.Binding() != binding {
		return nil, nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return state, raw, nil
}

// AdmitScratchCleanup admits one derived key for a completed original, never
// treating existing Prepared/UNKNOWN as authority to execute again.
func (r *Repository) AdmitScratchCleanup(ctx context.Context, state *domain.ScratchCleanupState) (ScratchCleanupAdmission, error) {
	var out ScratchCleanupAdmission
	raw, err := encodeScratchCleanup(state)
	if err != nil {
		return out, err
	}
	if state.Phase() != domain.Prepared {
		return out, failure("WORKSPACE_MUTATION_ADMISSION_NOT_PREPARED")
	}
	binding := state.Binding()
	key, err := scratchCleanupKey(binding.Creation.Identity)
	if err != nil || r == nil {
		return out, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	if err = r.cleanupParent(binding); err != nil {
		return out, err
	}
	existing, _, err := r.loadScratchCleanup(key, binding)
	if err != nil {
		return out, err
	}
	if existing != nil {
		if err = r.ready(ctx); err != nil {
			return out, err
		}
		if err = r.cleanupParent(binding); err != nil {
			return out, err
		}
		return ScratchCleanupAdmission{Status: port.MutationExisting, Record: existing}, nil
	}
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	err = r.disk.create(key, bytes.Clone(raw))
	if errors.Is(err, errExists) {
		existing, _, err = r.loadScratchCleanup(key, binding)
		if err == nil && existing != nil && ctx.Err() == nil && r.disk.check() == nil && r.cleanupParent(binding) == nil {
			return ScratchCleanupAdmission{Status: port.MutationExisting, Record: existing}, nil
		}
		r.fenced = true
		return out, unknown()
	}
	if err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	observed, observedRaw, err := r.loadScratchCleanup(key, binding)
	if err != nil || observed == nil || !bytes.Equal(observedRaw, raw) || ctx.Err() != nil || r.disk.check() != nil || r.cleanupParent(binding) != nil {
		r.fenced = true
		return out, unknown()
	}
	return ScratchCleanupAdmission{Status: port.MutationAdmitted, Record: observed}, nil
}

// LoadScratchCleanup is observation only; it never dispatches or repairs work.
func (r *Repository) LoadScratchCleanup(ctx context.Context, binding domain.ScratchCleanupBinding) (*domain.ScratchCleanupState, error) {
	key, err := scratchCleanupKey(binding.Creation.Identity)
	if err != nil || !binding.Valid() || r == nil {
		return nil, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	if err = r.cleanupParent(binding); err != nil {
		return nil, err
	}
	state, _, err := r.loadScratchCleanup(key, binding)
	if err != nil {
		return nil, err
	}
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	if err = r.cleanupParent(binding); err != nil {
		return nil, err
	}
	return state, nil
}

// SaveScratchCleanup performs one exact prepared-to-terminal publication. A
// failed replace or readback fences the original writer, never a retry.
func (r *Repository) SaveScratchCleanup(ctx context.Context, state *domain.ScratchCleanupState) error {
	raw, err := encodeScratchCleanup(state)
	if err != nil {
		return err
	}
	binding := state.Binding()
	key, err := scratchCleanupKey(binding.Creation.Identity)
	if err != nil || r == nil {
		return unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return err
	}
	if err = r.cleanupParent(binding); err != nil {
		return err
	}
	existing, previous, err := r.loadScratchCleanup(key, binding)
	if err != nil {
		return err
	}
	if existing == nil {
		return failure("WORKSPACE_MUTATION_STATE_MISSING")
	}
	if _, err = existing.Apply(*state); err != nil {
		return failure("WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
	}
	if bytes.Equal(raw, previous) {
		return r.ready(ctx)
	}
	if err = r.ready(ctx); err != nil {
		return err
	}
	if err = r.disk.replace(key, bytes.Clone(raw), bytes.Clone(previous)); err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return unknown()
	}
	observed, err := r.disk.read(key)
	if err != nil || !bytes.Equal(raw, observed) || ctx.Err() != nil || r.disk.check() != nil || r.cleanupParent(binding) != nil {
		r.fenced = true
		return unknown()
	}
	return nil
}
