package boot

import (
	"context"
	"math"
	"sync"

	computerport "github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// activationFence is exclusively negative authority. Deactivate immediately
// withdraws every prior route before any Settings or native publication IO.
// Only trusted composition can activate the exact fence after known admission.
// Computer's lock order is AccessRepository -> this fence -> real Chat owner.
// Neither callback performs IO, mutation, reentry or Computer reacquisition.
type activationFence struct {
	mu        sync.Mutex
	revision  uint64
	active    bool
	exhausted bool
}

func (g *activationFence) deactivate() (uint64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.active = false
	if g.exhausted || g.revision == math.MaxUint64 {
		g.exhausted = true
		return 0, computerUnavailable()
	}
	g.revision++
	return g.revision, nil
}
func (g *activationFence) inactive(fence uint64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return !g.active && !g.exhausted && fence != 0 && g.revision == fence
}
func (g *activationFence) activate(fence uint64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active || g.exhausted || fence == 0 || g.revision != fence {
		return computerUnavailable()
	}
	g.active = true
	return nil
}

// A lease captures this particular fence, not a mutable Boolean lookup. A later
// reactivation never revives an older admitted operation or its disclosure.
type activatedAdmission struct {
	guard   *activationFence
	fence   uint64
	current computerport.CurrentTaskAdmission
}

func (a *activatedAdmission) WithCurrent(ctx context.Context, inspect func(*computerport.TaskBinding) error) error {
	if a == nil || a.guard == nil || a.current == nil || ctx == nil || inspect == nil {
		return computerUnavailable()
	}
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	a.guard.mu.Lock()
	defer a.guard.mu.Unlock()
	if !a.guard.active || a.guard.exhausted || a.guard.revision != a.fence {
		return computerUnavailable()
	}
	return a.current.WithCurrent(ctx, inspect)
}
