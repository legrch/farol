package planruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"sync"

	"github.com/legrch/farol/modules/chat/app/services/inference"
	cb "github.com/legrch/farol/modules/chat/domain/contextbudget"
	"github.com/legrch/farol/modules/chat/infra/planledger"
	"github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
)

// JournalLedger maps full immutable plan identity onto the ORIGINAL concrete
// Chat journal. It supplies no native claim, recovery, account or write grant.
// NewJournalLedger captures the original qualified head once, OUTSIDE account
// and Chat gates, before this one operation's first reserve or external IO.
type JournalLedger struct {
	mu                    sync.Mutex
	reference             Reference
	protocol              inference.Ledger
	attempted, knownFresh bool
	intent                string
}

var _ Ledger = (*JournalLedger)(nil)

func NewJournalLedger(ctx context.Context, repository *lifecycle.Repository, prepared *Prepared) (*JournalLedger, error) {
	if repository == nil || prepared == nil || len(prepared.input) == 0 || len(prepared.provider) == 0 {
		return nil, inference.Invalid
	}
	return newJournalLedger(ctx, prepared, repository.CapturePlanHead, func(c planledger.Capture) (inference.Ledger, error) { return planledger.New(repository, c) })
}

// The private protocol seam permits small mapping fixtures. The exported
// constructor accepts ONLY the concrete original repository; no weaker Native
// constructor or alternative database/executor is published by this adapter.
func newJournalLedger(ctx context.Context, prepared *Prepared, capture func(context.Context) (lifecycle.PlanHead, error), compose func(planledger.Capture) (inference.Ledger, error)) (*JournalLedger, error) {
	if ctx == nil || prepared == nil || capture == nil || compose == nil {
		return nil, inference.Invalid
	}
	if ctx.Err() != nil {
		return nil, inference.Cancelled
	}
	original := prepared.Reference()
	raw, err := json.Marshal(original)
	if err != nil {
		return nil, inference.Invalid
	}
	digest := sha256.Sum256(raw)
	witness := hex.EncodeToString(digest[:])
	head, err := capture(ctx)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, inference.Cancelled
	}
	if head.Scope.ProfileID != original.Binding.ProfileID || head.Scope.BackendGeneration != original.Binding.BackendGeneration || !cb.Digest(head.PublicationDigest) {
		return nil, inference.Invalid
	}
	l := &JournalLedger{reference: original}
	protocol, err := compose(func(b inference.Binding, intent string) (lifecycle.PlanHead, string, error) {
		// Reserve sets the original intent before entering the actual ledger. This
		// callback returns captured values only; it never reopens or recaptures source.
		if b != l.reference.Binding || !l.attempted || intent != l.intent || !cb.Digest(intent) {
			return lifecycle.PlanHead{}, "", inference.Conflict
		}
		return head, witness, nil
	})
	if err != nil {
		return nil, err
	}
	if protocol == nil {
		return nil, inference.Invalid
	}
	l.protocol = protocol
	return l, nil
}

func (l *JournalLedger) Reserve(ctx context.Context, reference Reference, intent string) (bool, error) {
	if l == nil || l.protocol == nil || ctx == nil || !cb.Digest(intent) {
		return false, inference.Invalid
	}
	if ctx.Err() != nil {
		return false, inference.Cancelled
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !reflect.DeepEqual(reference, l.reference) {
		return false, inference.Conflict
	}
	if l.attempted && l.intent != intent {
		return false, inference.Conflict
	}
	first := !l.attempted
	if first {
		l.attempted = true
		l.intent = intent
	}
	// Keep the original binding/head/witness/full intent on all outcomes. Neither
	// an uncertain reply nor a historical not-fresh result can acquire a new head.
	fresh, err := l.protocol.Reserve(ctx, l.reference.Binding, l.intent)
	if first {
		l.knownFresh = fresh && err == nil
	} else if fresh {
		// The actual ledger returns not-fresh on duplicates. An impossible new-fresh
		// protocol reply must not authorize another provider request.
		return false, inference.PersistenceUnknown
	}
	return fresh, err
}

func (l *JournalLedger) Settle(ctx context.Context, reference Reference, outcome inference.Outcome) error {
	if l == nil || l.protocol == nil || ctx == nil {
		return inference.Invalid
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !reflect.DeepEqual(reference, l.reference) || !l.attempted || !l.knownFresh {
		return inference.Conflict
	}
	// Service supplies metadata only. Refuse unqualified fields, do not silently
	// sanitize them into journal evidence. Actual planledger/repository retain
	// strict bounded original remote state/code/status/response classification.
	if outcome.Text != "" || outcome.RemoteState != "" {
		return inference.Invalid
	}
	return l.protocol.Settle(ctx, l.reference.Binding, outcome)
}
