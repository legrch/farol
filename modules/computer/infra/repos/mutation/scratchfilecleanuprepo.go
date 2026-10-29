package mutation

import (
	"bytes"
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

type ScratchFileCleanupAdmission = port.ScratchFileCleanupAdmission

var _ port.ScratchFileCleanupRepository = (*Repository)(nil)

// fileCleanupParents is called under the same exclusive writer lock as cleanup IO.
// Neither the supplied binding nor the presence of a name proves ownership.
func (r *Repository) fileCleanupParents(binding domain.ScratchFileInventory) error {
	if err := r.cleanupParent(binding.Creation); err != nil {
		return err
	}
	key, err := recordKey(binding.Mutation.Identity)
	if err != nil {
		return err
	}
	file, _, err := r.load(key, binding.Mutation.Identity)
	if err != nil {
		return err
	}
	parentKey, err := recordKey(binding.Creation.Creation.Identity)
	if err != nil {
		return err
	}
	parent, _, err := r.load(parentKey, binding.Creation.Creation.Identity)
	if err != nil {
		return err
	}
	witness, err := domain.NewScratchFileInventory(parent, file, binding.File)
	if err != nil || witness == nil || *witness != binding {
		return failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return nil
}

func (r *Repository) loadScratchFileCleanup(key string, binding domain.ScratchFileInventory) (*domain.ScratchFileCleanupState, []byte, error) {
	raw, err := r.disk.read(key)
	if err != nil {
		return nil, nil, unavailable()
	}
	if raw == nil {
		return nil, nil, nil
	}
	state, err := decodeScratchFileCleanup(raw)
	if err != nil {
		return nil, nil, err
	}
	if state.Inventory() != binding {
		return nil, nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return state, raw, nil
}

// AdmitScratchFileCleanup admits one derived key for a completed original, never
// treating existing Prepared/UNKNOWN as authority to execute again.
func (r *Repository) AdmitScratchFileCleanup(ctx context.Context, state *domain.ScratchFileCleanupState) (ScratchFileCleanupAdmission, error) {
	var out ScratchFileCleanupAdmission
	raw, err := encodeScratchFileCleanup(state)
	if err != nil {
		return out, err
	}
	if state.Phase() != domain.Prepared {
		return out, failure("WORKSPACE_MUTATION_ADMISSION_NOT_PREPARED")
	}
	binding := state.Inventory()
	key, err := scratchCleanupKey(binding.Creation.Creation.Identity)
	if err != nil || r == nil {
		return out, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	if err = r.fileCleanupParents(binding); err != nil {
		return out, err
	}
	existing, _, err := r.loadScratchFileCleanup(key, binding)
	if err != nil {
		return out, err
	}
	if existing != nil {
		if err = r.ready(ctx); err != nil {
			return out, err
		}
		if err = r.fileCleanupParents(binding); err != nil {
			return out, err
		}
		return ScratchFileCleanupAdmission{Status: port.MutationExisting, Record: existing}, nil
	}
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	err = r.disk.create(key, bytes.Clone(raw))
	if errors.Is(err, errExists) {
		existing, _, err = r.loadScratchFileCleanup(key, binding)
		if err == nil && existing != nil && ctx.Err() == nil && r.disk.check() == nil && r.fileCleanupParents(binding) == nil {
			return ScratchFileCleanupAdmission{Status: port.MutationExisting, Record: existing}, nil
		}
		r.fenced = true
		return out, unknown()
	}
	if err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	observed, observedRaw, err := r.loadScratchFileCleanup(key, binding)
	if err != nil || observed == nil || !bytes.Equal(observedRaw, raw) || ctx.Err() != nil || r.disk.check() != nil || r.fileCleanupParents(binding) != nil {
		r.fenced = true
		return out, unknown()
	}
	return ScratchFileCleanupAdmission{Status: port.MutationAdmitted, Record: observed}, nil
}

// LoadScratchFileCleanup is observation only; it never dispatches or repairs work.
func (r *Repository) LoadScratchFileCleanup(ctx context.Context, binding domain.ScratchFileInventory) (*domain.ScratchFileCleanupState, error) {
	key, err := scratchCleanupKey(binding.Creation.Creation.Identity)
	if err != nil || !binding.Valid() || r == nil {
		return nil, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	if err = r.fileCleanupParents(binding); err != nil {
		return nil, err
	}
	state, _, err := r.loadScratchFileCleanup(key, binding)
	if err != nil {
		return nil, err
	}
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	if err = r.fileCleanupParents(binding); err != nil {
		return nil, err
	}
	return state, nil
}

// SaveScratchFileCleanup performs one exact prepared-to-terminal publication. A
// failed replace or readback fences the original writer, never a retry.
func (r *Repository) SaveScratchFileCleanup(ctx context.Context, state *domain.ScratchFileCleanupState) error {
	raw, err := encodeScratchFileCleanup(state)
	if err != nil {
		return err
	}
	binding := state.Inventory()
	key, err := scratchCleanupKey(binding.Creation.Creation.Identity)
	if err != nil || r == nil {
		return unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return err
	}
	if err = r.fileCleanupParents(binding); err != nil {
		return err
	}
	existing, previous, err := r.loadScratchFileCleanup(key, binding)
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
	if err != nil || !bytes.Equal(raw, observed) || ctx.Err() != nil || r.disk.check() != nil || r.fileCleanupParents(binding) != nil {
		r.fenced = true
		return unknown()
	}
	return nil
}
