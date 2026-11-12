package observation

import (
	"context"
	"errors"
	"sync"

	port "github.com/legrch/farol/modules/computer/app/port/observation"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

// mountInstance is a descriptor-derived, runtime-only mount identity. These
// values are never serialized as a grant; matching UUID/object evidence alone
// cannot prove that a mount instance did not change.
type mountInstance struct {
	FSID        [2]int32
	Filesystem  string
	MountedOn   string
	MountedFrom string
	Flags       uint64
}

func (m mountInstance) valid() bool {
	return m.FSID != [2]int32{} && m.Filesystem != "" &&
		m.MountedOn != "" && m.MountedOn[0] == '/' && m.MountedFrom != ""
}

type retainedNativeOperations interface {
	nativeOperations
	mount(int) (mountInstance, error)
}

func currentMounts(ctx context.Context, held chain, ops retainedNativeOperations) ([]mountInstance, error) {
	mounts := make([]mountInstance, 0, len(held))
	for _, item := range held {
		if err := cancelled(ctx); err != nil {
			return nil, err
		}
		m, err := ops.mount(item.fd)
		if err != nil || !m.valid() {
			return nil, fail("WORKSPACE_IDENTITY_UNAVAILABLE")
		}
		mounts = append(mounts, m)
	}
	return mounts, cancelled(ctx)
}

func sameMounts(a, b []mountInstance) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// heldObservation serializes every access to the ORIGINAL held chain. It never
// releases or reacquires the canonical descriptors except during Close. Named
// path reopens inside recheckChain are disposable witnesses, not substitutes.
type heldObservation struct {
	mu         sync.Mutex
	ops        retainedNativeOperations
	held       chain
	path       string
	initial    identity.Observation
	mounts     []mountInstance
	closed     bool
	closeError error
	poisoned   error
}

var _ port.HeldObservation = (*heldObservation)(nil)

type Holder struct{}

var _ port.Holder = (*Holder)(nil)

// NewHolder has no boot, RPC, settings or grant registration.
func NewHolder() *Holder { return &Holder{} }

func hold(ctx context.Context, path string, ops retainedNativeOperations) (_ port.HeldObservation, err error) {
	if err = cancelled(ctx); err != nil {
		return nil, err
	}
	if !identity.CanonicalPath(path) {
		return nil, fail("WORKSPACE_PATH_REFUSED")
	}
	original, err := openChain(ctx, path, ops)
	if err != nil {
		return nil, err
	}
	// Failed acquisition consumes all original fds once, even when the cause is
	// cancellation or a broken native measurement. Unconfirmed cleanup overrides
	// a secondary error: the caller must not assume that the fds were released.
	defer func() {
		if err != nil {
			if closeErr := closeChain(ops, original); closeErr != nil {
				err = closeErr
			}
		}
	}()
	if err = recheckChain(ctx, original, ops); err != nil {
		return nil, err
	}
	before, err := currentMounts(ctx, original, ops)
	if err != nil {
		return nil, err
	}
	measured, err := measureHeld(ctx, path, original, ops)
	if err != nil {
		return nil, err
	}
	after, err := currentMounts(ctx, original, ops)
	if err != nil {
		return nil, err
	}
	if !sameMounts(before, after) {
		return nil, fail("WORKSPACE_RACE_DETECTED")
	}
	if err = recheckChain(ctx, original, ops); err != nil {
		return nil, err
	}
	return &heldObservation{ops: ops, held: original, path: path, initial: measured, mounts: before}, nil
}

func (h *heldObservation) Snapshot() (identity.Observation, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return identity.Observation{}, fail("WORKSPACE_IDENTITY_CLOSED")
	}
	if h.poisoned != nil {
		return identity.Observation{}, h.poisoned
	}
	// Fields are all immutable value types. No internal fd or mutable backing
	// memory escapes, and Snapshot does not attest to current freshness.
	return h.initial, nil
}

func (h *heldObservation) requalify(ctx context.Context) error {
	if err := cancelled(ctx); err != nil {
		return err
	}
	if err := recheckChain(ctx, h.held, h.ops); err != nil {
		return err
	}
	before, err := currentMounts(ctx, h.held, h.ops)
	if err != nil {
		return err
	}
	if !sameMounts(before, h.mounts) {
		return fail("WORKSPACE_RACE_DETECTED")
	}
	measured, err := measureHeld(ctx, h.path, h.held, h.ops)
	if err != nil {
		return err
	}
	if measured != h.initial {
		return fail("WORKSPACE_RACE_DETECTED")
	}
	after, err := currentMounts(ctx, h.held, h.ops)
	if err != nil {
		return err
	}
	if !sameMounts(after, h.mounts) || !sameMounts(before, after) {
		return fail("WORKSPACE_RACE_DETECTED")
	}
	return recheckChain(ctx, h.held, h.ops)
}

func (h *heldObservation) Requalify(ctx context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return fail("WORKSPACE_IDENTITY_CLOSED")
	}
	if h.poisoned != nil {
		return h.poisoned
	}
	if err := cancelled(ctx); err != nil {
		return err
	}
	if err := h.requalify(ctx); err != nil {
		// Only a classified cancellation may leave the holder reusable.
		// If a native race/refusal and cancellation coincide, the observed
		// unsafe result must remain an irreversible fence.
		var f *port.Failure
		if !errors.As(err, &f) || f.Code != "WORKSPACE_REQUEST_CANCELLED" {
			h.poisoned = err
		}
		return err
	}
	return nil
}

func (h *heldObservation) Close() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return h.closeError
	}
	h.closed = true
	h.closeError = closeChain(h.ops, h.held)
	h.held = nil
	h.mounts = nil
	return h.closeError
}
