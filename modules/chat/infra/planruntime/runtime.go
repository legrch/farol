package planruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"github.com/legrch/farol/modules/chat/app/services/inference"
	cb "github.com/legrch/farol/modules/chat/domain/contextbudget"
	ms "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/clients/planresponses"
)

// SourceGate pins an opaque original source lease. The COMPLETE callback is
// synchronous, no IO/reentry and serialized with original source withdrawal.
// A decoded SourceRef or InputHash cannot implement this authority predicate.
type SourceGate interface {
	WithCurrent(context.Context, cb.SourceRef, func() error) error
}

// These are private consumers of existing owner capabilities, not new stores.
// IO occurs outside Source/Account gates. Owners must provide their original
// durable reservation and exact physical writer, not turn entry checks into a
// fabricated atomic grant. Settle records original outcomes even after withdrawal.
type Ledger interface {
	Reserve(context.Context, Reference, string) (bool, error)
	Settle(context.Context, Reference, inference.Outcome) error
}
type Credentials interface {
	Acquire(context.Context, Reference) (inference.Credential, error)
}
type Publication interface {
	Publish(Reference, inference.Outcome) error
}

type Options struct {
	Source  SourceGate
	Account inference.Authority
	// Clock is bounded and performs no IO or owner reentry. The existing
	// inference service reads it in its final authority callback too.
	Clock       inference.Clock
	Deadline    inference.Deadline
	Digester    inference.Digester
	Ledger      Ledger
	Credentials Credentials
	Publication Publication
	HTTP        *http.Client
}
type Runtime struct{ options Options }

func New(o Options) (*Runtime, error) {
	if o.Source == nil || o.Account == nil || o.Clock == nil || o.Deadline == nil || o.Digester == nil || o.Ledger == nil || o.Credentials == nil || o.Publication == nil || o.HTTP == nil || o.HTTP.Transport == nil {
		return nil, inference.Invalid
	}
	// Retain the original physical writer configuration, not a caller's mutable
	// http.Client handle or an implicit ambient DefaultTransport activation.
	http := *o.HTTP
	o.HTTP = &http
	return &Runtime{options: o}, nil
}

type operation struct {
	runtime  *Runtime
	prepared *Prepared
	clockMu  sync.Mutex
	last     uint64
}

func (o *operation) WithCurrent(ctx context.Context, b inference.Binding, f func() error) error {
	if ctx == nil || ctx.Err() != nil || f == nil || b != o.prepared.reference.Binding {
		return inference.Withdrawn
	}
	// Producer budget evaluation is outside the gates and invokes no owner
	// services. The original service's final callback uses only the bounded clock.
	o.clockMu.Lock()
	now := o.runtime.options.Clock.NowMillis()
	if now == 0 || now < o.last || now >= b.DeadlineMillis {
		o.clockMu.Unlock()
		return inference.Withdrawn
	}
	o.last = now
	o.clockMu.Unlock()
	ref := o.prepared.reference
	if ms.CheckCurrentBudget(o.prepared.estimate, ms.EstimateContext{Selection: o.prepared.resolved, InputDigest: ref.Receipt.InputHash, Source: ref.EstimatorSource, Version: ref.EstimatorVersion, NowMillis: now}, ref.Budget) != nil {
		return inference.Withdrawn
	}
	// Existing Browser/Chat authorization uses account -> Chat/lifecycle. The
	// opaque source lease is that SAME Chat gate, so inversion can deadlock.
	return o.runtime.options.Account.WithCurrent(ctx, b, func() error {
		return o.runtime.options.Source.WithCurrent(ctx, ref.Receipt.Source, f)
	})
}
func (o *operation) check(ctx context.Context) error {
	return o.WithCurrent(ctx, o.prepared.reference.Binding, func() error { return nil })
}

type ledger struct{ op *operation }

func (l ledger) Reserve(ctx context.Context, b inference.Binding, digest string) (bool, error) {
	if b != l.op.prepared.reference.Binding || !cb.Digest(digest) {
		return false, inference.Invalid
	}
	// The complete immutable sidecar participates in the original journal intent.
	// Identical InputHash never erases omitted originals or reservation changes.
	intent, err := json.Marshal(struct {
		InferenceIntent string
		Reference       Reference
	}{digest, l.op.prepared.Reference()})
	if err != nil {
		return false, inference.Invalid
	}
	fullDigest, err := l.op.runtime.options.Digester.Digest(intent)
	if err != nil || !cb.Digest(fullDigest) {
		return false, inference.Invalid
	}
	if l.op.check(ctx) != nil {
		return false, inference.Withdrawn
	}
	return l.op.runtime.options.Ledger.Reserve(ctx, l.op.prepared.Reference(), fullDigest)
}
func (l ledger) Settle(ctx context.Context, b inference.Binding, value inference.Outcome) error {
	if b != l.op.prepared.reference.Binding {
		return inference.Invalid
	}
	return l.op.runtime.options.Ledger.Settle(ctx, l.op.prepared.Reference(), value)
}

type credentials struct{ op *operation }

func (c credentials) Acquire(ctx context.Context, s inference.Selection) (inference.Credential, error) {
	if s != c.op.prepared.reference.Binding.Selection || c.op.check(ctx) != nil {
		return inference.Credential{}, inference.Withdrawn
	}
	return c.op.runtime.options.Credentials.Acquire(ctx, c.op.prepared.Reference())
}

type publication struct{ op *operation }

func (p publication) Publish(b inference.Binding, value inference.Outcome) error {
	if b != p.op.prepared.reference.Binding {
		return inference.Invalid
	}
	// inference.Service enters this adapter under the complete account->source
	// authority callback. This port is bounded in-memory publication, never IO.
	return p.op.runtime.options.Publication.Publish(p.op.prepared.Reference(), value)
}

type transport struct {
	op       *operation
	original *planresponses.Client
}

// estimateClock preserves the owner's bounded clock and original binding.
// Existing service deadline checks also refuse expired estimate validity, even
// after waiting to enter the final source/account publication callback.
type estimateClock struct {
	original                        inference.Clock
	estimateExpiry, requestDeadline uint64
}

func (c estimateClock) NowMillis() uint64 {
	now := c.original.NowMillis()
	if now >= c.estimateExpiry {
		return c.requestDeadline
	}
	return now
}

func (t transport) Preflight(r inference.Request) error {
	wire, err := t.original.PrepareRequest(r)
	if err != nil || !bytes.Equal(wire, t.op.prepared.provider) {
		return inference.Invalid
	}
	return nil
}
func (t transport) Infer(ctx context.Context, c inference.Credential, r inference.Request) inference.Outcome {
	if t.Preflight(r) != nil {
		return inference.Outcome{State: inference.NotSent, Code: inference.Invalid}
	}
	if t.op.check(ctx) != nil {
		return inference.Outcome{State: inference.NotSent, Code: inference.Withdrawn}
	}
	return t.original.Infer(ctx, c, r)
}

// Infer composes the actual production service and wire transport. It cannot
// activate subscription inference from Browser account/catalogue observations.
// Repeating an operation relies on the existing durable ledger's exact intent;
// any lost reserve/settle/HTTP outcome remains UNKNOWN and is never retried here.
func (r *Runtime) Infer(ctx context.Context, p *Prepared) inference.Outcome {
	if r == nil || p == nil {
		return inference.Outcome{State: inference.NotSent, Code: inference.Invalid}
	}
	if ctx == nil {
		return inference.Outcome{State: inference.NotSent, Code: inference.Cancelled}
	}
	// Lock waits and IO spend estimate freshness too. The original request
	// identity is unchanged; only its child lifetime is conservatively shorter.
	estimateDeadline := min(p.reference.Binding.DeadlineMillis, p.reference.Estimate.Observation.ExpiresAtMillis)
	bounded, cancel, err := r.options.Deadline.Limit(ctx, estimateDeadline)
	if err != nil || bounded == nil || cancel == nil {
		if cancel != nil {
			cancel()
		}
		return inference.Outcome{State: inference.NotSent, Code: inference.Withdrawn}
	}
	defer cancel()
	ctx = bounded
	op := &operation{runtime: r, prepared: p}
	if op.check(ctx) != nil {
		return inference.Outcome{State: inference.NotSent, Code: inference.Withdrawn}
	}
	service, err := inference.New(inference.Options{Clock: estimateClock{r.options.Clock, p.reference.Estimate.Observation.ExpiresAtMillis, p.reference.Binding.DeadlineMillis}, Deadline: r.options.Deadline, Digester: r.options.Digester, Authority: op, Ledger: ledger{op}, Credentials: credentials{op}, Publication: publication{op}, Transport: transport{op, planresponses.New(r.options.HTTP)}})
	if err != nil {
		return inference.Outcome{State: inference.NotSent, Code: inference.Invalid}
	}
	return service.Infer(ctx, p.reference.Binding, append([]inference.InputItem(nil), p.input...))
}
