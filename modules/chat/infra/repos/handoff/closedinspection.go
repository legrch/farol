package handoff

import (
	"context"
	"crypto/sha256"

	"github.com/legrch/farol/modules/chat/app/port"
	policy "github.com/legrch/farol/modules/chat/app/services/handoff"
)

// ClosedInspection describes the entire canonical empty retirement chain ending
// in an already-consumed successor matching Scope, or an interrupted retirement
// ACK in the original Scope when using the separate interrupted inspector.
// Persisted stage/binding data
// is not live origin, drain, recovery, admission or replay authority.
type ClosedInspection struct {
	Scope       port.JournalScope
	ParentRoot  port.JournalRoot
	ChatRoot    port.JournalRoot
	HeadDigest  [32]byte
	HeadStage   port.HandoffStage
	Publication port.HandoffPublication
	NextBinding port.HandoffBinding
	AttemptID   string
	Stages      []ClosedInspectionStage
	// Head is the exact canonical empty record for the internal boot callback.
	// All Turns were checked empty. This is persisted data, never origin proof.
	// External diagnostics serialize only scalar/stage metadata.
	Head *port.HandoffHead `json:"-"`
}

// ClosedInspectionStage contains only position, stage and exact canonical digest,
// never a retirement receipt, Turn origin, prompt, result body or cleanup proof.
type ClosedInspectionStage struct {
	Index  int
	Stage  port.HandoffStage
	Digest [32]byte
}

// WithClosedInspection retains the existing handoff claim through inspect and a
// complete final chain/identity recheck. Call inside the lifecycle/results
// callbacks with their exact current scope and roots to retain all claims. It
// creates, writes, deletes, syncs and poisons nothing. Metadata is provisional
// until nil return. The callback must not mutate or relocate inspected storage;
// no caller-supplied recheck or descriptor/relocation authority is exported.
func WithClosedInspection(ctx context.Context, roots Roots, scope port.JournalScope, inspect func(ClosedInspection) error) error {
	if ctx == nil || ctx.Err() != nil {
		return fail(Cancelled, false)
	}
	if inspect == nil || !historyID(roots.ProfileID) || !historyID(scope.BackendGeneration) || scope.ProfileID != roots.ProfileID {
		return fail(Invalid, false)
	}
	return withClosedInspection(ctx, roots, scope, inspect)
}

// This private scanner facade cannot publish or poison. Reuse the canonical
// scanner's complete transition/reuse/build policy without its native write-on-
// uncertainty path. Its uncertainty state exists only in this local scan owner.
type closedInspectionReader struct {
	readRecord func(context.Context, int) ([]byte, bool, error)
}

func (r closedInspectionReader) read(ctx context.Context, index int) ([]byte, bool, error) {
	return r.readRecord(ctx, index)
}
func (closedInspectionReader) append(context.Context, int, []byte) error { return fail(Refused, false) }
func (closedInspectionReader) close() error                              { return nil }
func (closedInspectionReader) poison() error                             { return fail(Unavailable, false) }

type closedInspectionChain struct {
	head   *port.HandoffHead
	stages []ClosedInspectionStage
}

func closedInspectionEmptyChainScan(ctx context.Context, roots Roots, read func(context.Context, int) ([]byte, bool, error)) (closedInspectionChain, error) {
	s := &owner{roots: roots, disk: closedInspectionReader{readRecord: read}}
	stages := make([]ClosedInspectionStage, 0)
	head, _, _, err := s.scanEach(ctx, func(r port.HandoffRecord) error {
		if len(r.Receipt.Write.Turns) != 0 {
			return fail(Refused, false)
		}
		raw, err := encode(r)
		if err != nil {
			return err
		}
		stages = append(stages, ClosedInspectionStage{Index: len(stages) + 1, Stage: r.Stage, Digest: sha256.Sum256(raw)})
		return nil
	})
	if err != nil {
		return closedInspectionChain{}, err
	}
	if head.Record == nil || !head.EmptyRetirementChain {
		return closedInspectionChain{}, fail(Refused, false)
	}
	return closedInspectionChain{head: head, stages: stages}, nil
}

func closedInspectionScan(ctx context.Context, roots Roots, scope port.JournalScope, read func(context.Context, int) ([]byte, bool, error)) (ClosedInspection, error) {
	chain, err := closedInspectionEmptyChainScan(ctx, roots, read)
	if err != nil {
		return ClosedInspection{}, err
	}
	return closedInspectionValue(roots, scope, chain)
}

func closedInspectionValue(roots Roots, scope port.JournalScope, chain closedInspectionChain) (ClosedInspection, error) {
	head := chain.head
	if head.Record == nil || !head.EmptyRetirementChain || head.Record.Stage != port.HandoffConsumed || head.Record.Consumption == nil || head.Record.Consumption.Next != scope {
		return ClosedInspection{}, fail(Refused, false)
	}
	c := head.Record.Consumption
	return ClosedInspection{Scope: scope, ParentRoot: roots.Parent.Identity, ChatRoot: roots.Chat.Identity,
		HeadDigest: head.Digest, HeadStage: head.Record.Stage, Publication: head.Record.Publication,
		NextBinding: c.NextBinding, AttemptID: c.AttemptID, Stages: chain.stages, Head: copyClosedInspectionHead(head)}, nil
}

func interruptedRetirementInspectionValue(roots Roots, scope port.JournalScope, chain closedInspectionChain) (ClosedInspection, error) {
	h := chain.head
	if h == nil || h.Record == nil || !h.EmptyRetirementChain {
		return ClosedInspection{}, fail(Refused, false)
	}
	r := h.Record
	b := r.Publication.Binding
	if r.Stage != port.HandoffAcknowledged || r.Origin != port.HandoffLiveOwner || r.ACK == nil || r.ACK.Publication != r.Publication || r.Terminal != nil || r.Consumption != nil || (port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}) != scope || b.ParentRoot != roots.Parent.Identity || b.ChatRoot != roots.Chat.Identity {
		return ClosedInspection{}, fail(Refused, false)
	}
	return ClosedInspection{Scope: scope, ParentRoot: roots.Parent.Identity, ChatRoot: roots.Chat.Identity,
		HeadDigest: h.Digest, HeadStage: r.Stage, Publication: r.Publication,
		Stages: append([]ClosedInspectionStage(nil), chain.stages...), Head: copyClosedInspectionHead(h)}, nil
}

func copyClosedInspectionHead(head *port.HandoffHead) *port.HandoffHead {
	if head == nil {
		return nil
	}
	copy := *head
	if head.Record != nil {
		record := policy.Copy(*head.Record)
		copy.Record = &record
	}
	return &copy
}

func closedInspectionCallback(ctx context.Context, value ClosedInspection, recheck func() error, inspect func(ClosedInspection) error) error {
	if ctx.Err() != nil {
		return fail(Cancelled, false)
	}
	value.Stages = append([]ClosedInspectionStage(nil), value.Stages...)
	value.Head = copyClosedInspectionHead(value.Head)
	callbackErr := inspect(value)
	if err := recheck(); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return fail(Cancelled, false)
	}
	return callbackErr
}
