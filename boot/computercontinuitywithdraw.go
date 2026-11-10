package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	journal "github.com/legrch/farol/modules/computer/domain/journal"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// withdrawForContinuity is an INTERNAL boot-only native effect. The trusted
// migration.Owner must hold the original C1/C3 handles and consume its one-shot
// WithdrawOnce admission before reaching here. No desktop method is registered;
// a persisted WAL/operation ID alone must never be enough to replay this effect
// in a later process or after an unknown returned acknowledgement.
//
// Ordinary ComputerIngress.Deactivate is intentionally unusable with a pending
// WAL: it calls Store.Status, which refuses. Here the only permitted read is
// exact-original-intent TransitionEffectSnapshot, not an authority read.
func (s *ComputerIngress) withdrawForContinuity(ctx context.Context, original string, planned journal.Receipt) (journal.Receipt, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || original == "" || planned.EffectID == "" || planned.Digest == "" {
		return journal.Receipt{}, computerUnavailable()
	}
	s.effects.Lock()
	defer s.effects.Unlock()
	if s.retiring {
		return journal.Receipt{}, computerUnavailable()
	}
	store, ok := s.store.(interface {
		TransitionEffectSnapshot(context.Context, string, journal.Phase, journal.Receipt) (accessrepo.Status, error)
	})
	if !ok {
		return journal.Receipt{}, computerUnavailable()
	}
	current, err := store.TransitionEffectSnapshot(ctx, original, journal.WithdrawIntent, planned)
	if err != nil || !current.ApprovalPresent || ctx.Err() != nil {
		return journal.Receipt{}, computerUnavailable()
	}
	// Reserve the native effect before invocation. Its in-memory lease never
	// survives restart; the Go owner will not restore original held handles.
	if err := s.claim("continuity_" + original); err != nil {
		return journal.Receipt{}, err
	}
	fence, err := s.guard.deactivate()
	if err != nil || ctx.Err() != nil {
		s.poison()
		return journal.Receipt{}, computerUnavailable()
	}
	// The acknowledgement binds the actual fence revision to the pre-withdraw
	// protected Store state and planned intent. It cannot be fabricated from
	// equal Settings bytes or a later unrelated Store.Status observation.
	data := fmt.Sprintf("farol.continuity-withdraw/1\x00%s\x00%s\x00%s\x00%d\x00%d\x00%d", original, planned.EffectID, planned.Digest, current.Revision, current.Generation, fence)
	h := sha256.Sum256([]byte(data))
	return journal.Receipt{EffectID: planned.EffectID, Digest: hex.EncodeToString(h[:])}, nil
}
