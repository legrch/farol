// Package mutation implements Computer's existing private mutation journal.
// It owns storage only: no authority, task lifecycle, executor or client ACK.
package mutation

import (
	"bytes"
	"context"
	"errors"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const maxRecordBytes = 64 * 1024

// Failure never carries a path or raw OS diagnostic. An unknown publication
// fences this retained writer; a different constructor is not recovery authority.
type Failure struct{ Code string }

func (e *Failure) Error() string        { return e.Code }
func (e *Failure) Retry() string        { return "never" }
func (e *Failure) OutcomeUnknown() bool { return e.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" }
func failure(code string) error         { return &Failure{Code: code} }
func unavailable() error                { return failure("COMPUTER_MUTATION_STORE_UNAVAILABLE") }
func unknown() error                    { return failure("WORKSPACE_MUTATION_OUTCOME_UNKNOWN") }

var errExists = errors.New("mutation target already exists")

// storage is a private CPU-test seam. Production always selects its native
// adapter, retained descriptors and exclusive writer lock. Reads never repair.
type storage interface {
	check() error
	read(string) ([]byte, error)          // nil means a qualified ENOENT, never an IO error
	create(string, []byte) error          // durable create-only; errExists cannot authorize execution
	replace(string, []byte, []byte) error // exact previous bytes; durable terminal publication
	close() error
}

type Repository struct {
	mu       sync.Mutex
	disk     storage
	closed   bool
	fenced   bool
	closeErr error
}

var _ port.MutationRepository = (*Repository)(nil)

func newRepository(d storage) *Repository { return &Repository{disk: d} }
func (r *Repository) ready(ctx context.Context) error {
	if r == nil || r.disk == nil || r.closed {
		return unavailable()
	}
	if r.fenced {
		return unknown()
	}
	if ctx == nil || ctx.Err() != nil {
		return failure("WORKSPACE_MUTATION_CANCELLED")
	}
	if r.disk.check() != nil {
		return unavailable()
	}
	return nil
}
func (r *Repository) load(key string, id domain.Identity) (*domain.State, []byte, error) {
	raw, err := r.disk.read(key)
	if err != nil {
		return nil, nil, unavailable()
	}
	if raw == nil {
		return nil, nil, nil
	}
	state, err := decode(raw)
	if err != nil {
		return nil, nil, err
	}
	if state.Binding().Identity != id {
		return nil, nil, failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
	return state, raw, nil
}

// Admit serializes comparison and publication under this one storage owner.
// Existing (including Prepared) is observation only. Changed payload/workspace
// is returned as Existing, letting the owning app classify its exact conflict.
func (r *Repository) Admit(ctx context.Context, state *domain.State) (port.MutationAdmission, error) {
	var out port.MutationAdmission
	raw, err := encode(state)
	if err != nil {
		return out, err
	}
	if state.Phase() != domain.Prepared {
		return out, failure("WORKSPACE_MUTATION_ADMISSION_NOT_PREPARED")
	}
	id := state.Binding().Identity
	key, err := recordKey(id)
	if err != nil {
		return out, err
	}
	if r == nil {
		return out, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	existing, _, err := r.load(key, id)
	if err != nil {
		return out, err
	}
	if existing != nil {
		if err = r.ready(ctx); err != nil {
			return out, err
		}
		return port.MutationAdmission{Status: port.MutationExisting, Record: existing}, nil
	}
	if err = r.ready(ctx); err != nil {
		return out, err
	}
	err = r.disk.create(key, bytes.Clone(raw))
	if errors.Is(err, errExists) {
		// A racing publication is never this writer's fresh permit.
		existing, _, err = r.load(key, id)
		if err == nil && existing != nil && ctx.Err() == nil && r.disk.check() == nil {
			return port.MutationAdmission{Status: port.MutationExisting, Record: existing}, nil
		}
		// Even a nil-error missing observation cannot confirm this create.
		// Do not fall through to a later read that could mint a fresh permit.
		r.fenced = true
		return out, unknown()
	}
	if err != nil || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	observed, observedRaw, err := r.load(key, id)
	if err != nil || observed == nil || !bytes.Equal(observedRaw, raw) || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return out, unknown()
	}
	return port.MutationAdmission{Status: port.MutationAdmitted, Record: observed}, nil
}

// Load neither admits, writes, syncs, creates directories nor removes staging.
// A fenced writer cannot label visible but unconfirmed publication "durable".
func (r *Repository) Load(ctx context.Context, id domain.Identity) (*domain.State, error) {
	key, err := recordKey(id)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	state, _, err := r.load(key, id)
	if err != nil {
		return nil, err
	}
	if err = r.ready(ctx); err != nil {
		return nil, err
	}
	return state, nil
}

// Save preserves the TS store's exact no-op and prepared-to-terminal rule.
// One failed publication attempt fences the whole writer; no Save is retried.
func (r *Repository) Save(ctx context.Context, state *domain.State) error {
	raw, err := encode(state)
	if err != nil {
		return err
	}
	id := state.Binding().Identity
	key, err := recordKey(id)
	if err != nil {
		return err
	}
	if r == nil {
		return unavailable()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err = r.ready(ctx); err != nil {
		return err
	}
	existing, previous, err := r.load(key, id)
	if err != nil {
		return err
	}
	if existing == nil {
		return failure("WORKSPACE_MUTATION_STATE_MISSING")
	}
	if existing.Binding() != state.Binding() {
		return failure("WORKSPACE_MUTATION_BINDING_MISMATCH")
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
	if err != nil || !bytes.Equal(raw, observed) || ctx.Err() != nil || r.disk.check() != nil {
		r.fenced = true
		return unknown()
	}
	return nil
}

// Close releases this owner's descriptors exactly once. It removes no file,
// clears no operation, and supplies no clean-retirement or successor permission.
func (r *Repository) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return r.closeErr
	}
	r.closed = true
	if r.disk == nil || r.disk.close() != nil {
		r.closeErr = unavailable()
		return r.closeErr
	}
	return nil
}
