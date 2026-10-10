package contextcheckpoint

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/contextbudget"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid            Code = "CHAT_CHECKPOINT_INVALID"
	Unavailable        Code = "CHAT_CHECKPOINT_UNAVAILABLE"
	Conflict           Code = "CHAT_CHECKPOINT_CONFLICT"
	Capacity           Code = "CHAT_CHECKPOINT_CAPACITY"
	PublicationUnknown Code = "CHAT_CHECKPOINT_PUBLICATION_UNKNOWN"
	SummaryFailed      Code = "CHAT_CHECKPOINT_SUMMARY_FAILED"
	PublishRefused     Code = "CHAT_CHECKPOINT_PUBLISH_REFUSED"
)
const MaxOperations = 1024
const MaxPreparedBytes = 16 * 1024 * 1024

type Dependencies struct {
	Gate      port.Gate
	Source    Source
	Digests   Digester
	Estimator contextbudget.Estimator
	Store     CheckpointStore // optional; nil permits portable selection only
	Summary   Summarizer      // optional; never selected automatically
}
type Service struct {
	deps          Dependencies
	operations    map[string]*Prepared
	ids           map[string]bool
	preparedBytes int
}
type Prepared struct {
	owner                               *Service
	id, operation                       string
	policy                              contextbudget.Policy
	window                              contextbudget.Window
	summaryStarted, publishing, unknown bool
	publication                         *Publication
	publishFailure                      error
}

func New(d Dependencies) (*Service, error) {
	if d.Gate == nil || d.Source == nil || d.Digests == nil || d.Estimator == nil {
		return nil, Invalid
	}
	return &Service{deps: d, operations: map[string]*Prepared{}, ids: map[string]bool{}}, nil
}
func cloneWindow(w contextbudget.Window) contextbudget.Window {
	w.Events = append([]contextbudget.Event{}, w.Events...)
	w.Unresolved = append([]contextbudget.UnknownReference{}, w.Unresolved...)
	if w.Summary != nil {
		copy := *w.Summary
		w.Summary = &copy
	}
	return w
}
func reference(source contextbudget.Source, d Digester) (contextbudget.SourceRef, error) {
	raw, err := contextbudget.CanonicalSource(source)
	if err != nil {
		return contextbudget.SourceRef{}, err
	}
	if len(raw) > contextbudget.MaxSourceBytes {
		return contextbudget.SourceRef{}, contextbudget.SourceLimit
	}
	digest, err := d.Digest(raw)
	if err != nil || !contextbudget.Digest(digest) {
		return contextbudget.SourceRef{}, Invalid
	}
	first, last := source.Events[0], source.Events[len(source.Events)-1]
	return contextbudget.SourceRef{Binding: source.Binding, Revision: source.Revision, FirstSequence: first.Sequence, LastSequence: last.Sequence, FirstEventID: first.ID, LastEventID: last.ID, SHA256: digest}, nil
}

// Prepare performs no summary, provider dispatch or storage effect. Source
// reads and current checks run outside the service gate. IDs come from the owner.
func (s *Service) Prepare(ctx context.Context, b contextbudget.Binding, id, operation string, p contextbudget.Policy) (*Prepared, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || !b.Valid() || !contextbudget.ID(id) || !contextbudget.ID(operation) || !p.Valid() {
		return nil, Invalid
	}
	// Reserve bounded operation identity before external IO. A failed preparation
	// keeps its identity reserved; it cannot be reused with changed intent.
	s.deps.Gate.Lock()
	if _, exists := s.operations[operation]; exists || s.ids[id] {
		s.deps.Gate.Unlock()
		return nil, Conflict
	}
	if len(s.operations) >= MaxOperations {
		s.deps.Gate.Unlock()
		return nil, Capacity
	}
	s.operations[operation] = nil
	s.ids[id] = true
	s.deps.Gate.Unlock()
	// Restart cannot silently redispatch an original operation. The accepted
	// store must preserve durable admission/UNKNOWN intent and prove absence.
	if s.deps.Store != nil {
		existing, err := s.deps.Store.Observe(ctx, id, operation)
		if err != nil || ctx.Err() != nil {
			return nil, Unavailable
		}
		if existing != nil {
			return nil, Conflict
		}
	}
	source, err := s.deps.Source.Read(ctx, b)
	if err != nil {
		return nil, Unavailable
	}
	if ctx.Err() != nil || source.Binding != b {
		return nil, contextbudget.Stale
	}
	if len(source.Events) > contextbudget.MaxEvents {
		return nil, contextbudget.SourceLimit
	}
	source.Events = append([]contextbudget.Event{}, source.Events...)
	ref, err := reference(source, s.deps.Digests)
	if err != nil {
		return nil, err
	}
	if s.deps.Source.Check(ctx, ref) != nil || ctx.Err() != nil {
		return nil, contextbudget.Stale
	}
	w, err := contextbudget.Select(source, ref, p, s.deps.Estimator)
	if err != nil {
		return nil, err
	}
	if s.deps.Source.Check(ctx, ref) != nil || ctx.Err() != nil {
		return nil, contextbudget.Stale
	}
	prepared := &Prepared{owner: s, id: id, operation: operation, policy: p, window: w}
	encoded, _ := json.Marshal(w)
	s.deps.Gate.Lock()
	if len(encoded) > MaxCheckpointBytes || len(encoded) > MaxPreparedBytes-s.preparedBytes {
		s.deps.Gate.Unlock()
		return nil, Capacity
	}
	s.preparedBytes += len(encoded)
	s.operations[operation] = prepared
	s.deps.Gate.Unlock()
	return prepared, nil
}
func (s *Service) capture(p *Prepared) (contextbudget.Window, error) {
	if p == nil || p.owner != s || s.operations[p.operation] != p {
		return contextbudget.Window{}, Invalid
	}
	return cloneWindow(p.window), nil
}

// Window exposes an independent value. Editing it cannot change a publish plan.
func (s *Service) Window(ctx context.Context, p *Prepared) (contextbudget.Window, error) {
	if s == nil || ctx == nil || ctx.Err() != nil {
		return contextbudget.Window{}, Invalid
	}
	s.deps.Gate.Lock()
	w, err := s.capture(p)
	s.deps.Gate.Unlock()
	if err != nil {
		return contextbudget.Window{}, err
	}
	if s.deps.Source.Check(ctx, w.Source) != nil || ctx.Err() != nil {
		return contextbudget.Window{}, contextbudget.Stale
	}
	return w, nil
}

// AddSummary is optional and one-shot per original operation, including errors.
// Safe original context remains available after invalid/interrupted summaries.
func (s *Service) AddSummary(ctx context.Context, p *Prepared, version string) error {
	if s == nil || ctx == nil || ctx.Err() != nil || !contextbudget.ID(version) || s.deps.Summary == nil {
		return Invalid
	}
	s.deps.Gate.Lock()
	w, err := s.capture(p)
	if err == nil && (p.summaryStarted || p.publishing || p.unknown || p.publication != nil || p.publishFailure != nil) {
		err = Conflict
	}
	if err == nil {
		p.summaryStarted = true
	}
	s.deps.Gate.Unlock()
	if err != nil {
		return err
	}
	if s.deps.Source.Check(ctx, w.Source) != nil || ctx.Err() != nil {
		return contextbudget.Stale
	}
	summary, err := s.deps.Summary.Summarize(ctx, SummaryRequest{p.id, p.operation, w.Source, version, append([]contextbudget.Event{}, w.Events...)})
	if err != nil || summary == nil {
		return SummaryFailed
	}
	returnedSummary := *summary
	if ctx.Err() != nil || s.deps.Source.Check(ctx, w.Source) != nil {
		return contextbudget.Stale
	}
	if returnedSummary.PromptVersion != version {
		return SummaryFailed
	}
	next, err := contextbudget.WithSummary(w, returnedSummary, p.policy, s.deps.Estimator)
	if err != nil {
		return err
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if p.publishing || p.unknown || p.publication != nil || p.publishFailure != nil {
		return Conflict
	}
	before, _ := json.Marshal(p.window)
	after, _ := json.Marshal(next)
	delta := len(after) - len(before)
	if len(after) > MaxCheckpointBytes || delta > MaxPreparedBytes-s.preparedBytes {
		return Capacity
	}
	s.preparedBytes += delta
	p.window = next
	return nil
}

// Publish calls the accepted storage owner once. Errors, nil/mismatched receipts
// or loss of the current source after IO retain UNKNOWN, never a retry or ACK.
func (s *Service) Publish(ctx context.Context, p *Prepared) (*Publication, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || s.deps.Store == nil {
		return nil, Invalid
	}
	s.deps.Gate.Lock()
	w, err := s.capture(p)
	if err == nil && p.unknown {
		err = PublicationUnknown
	}
	if err == nil && p.publishFailure != nil {
		err = p.publishFailure
	}
	if err == nil && p.publishing {
		err = Conflict
	}
	if err == nil && p.publication != nil {
		copy := *p.publication
		s.deps.Gate.Unlock()
		if s.deps.Source.Check(ctx, w.Source) != nil || ctx.Err() != nil {
			return nil, contextbudget.Stale
		}
		return &copy, nil
	}
	if err == nil {
		p.publishing = true
	}
	s.deps.Gate.Unlock()
	if err != nil {
		return nil, err
	}
	if s.deps.Source.Check(ctx, w.Source) != nil || ctx.Err() != nil {
		s.deps.Gate.Lock()
		p.publishing = false
		s.deps.Gate.Unlock()
		return nil, contextbudget.Stale
	}
	checkpoint := contextbudget.Checkpoint{Version: 1, ID: p.id, OperationID: p.operation, Window: w}
	raw, err := json.Marshal(checkpoint)
	if err != nil || len(raw) > MaxCheckpointBytes {
		return nil, s.notPublished(p, Invalid)
	}
	digest, err := s.deps.Digests.Digest(raw)
	if err != nil || !contextbudget.Digest(digest) {
		return nil, s.notPublished(p, Invalid)
	}
	receipt, err := s.deps.Store.Publish(ctx, PublishRequest{checkpoint, w.Source, digest})
	if errors.Is(err, PublishRefused) && receipt == nil {
		return nil, s.notPublished(p, PublishRefused)
	}
	if err != nil || receipt == nil {
		return nil, s.uncertain(p)
	}
	// Snapshot adapter-owned data BEFORE calling any external current check.
	retained := *receipt
	if retained != (Publication{p.id, p.operation, digest, w.Source}) || ctx.Err() != nil || s.deps.Source.Check(ctx, w.Source) != nil {
		return nil, s.uncertain(p)
	}
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	p.publication = &retained
	p.publishing = false
	returned := retained
	return &returned, nil
}
func (s *Service) notPublished(p *Prepared, err error) error {
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	p.publishFailure = err
	p.publishing = false
	return err
}
func (s *Service) uncertain(p *Prepared) error {
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	p.unknown = true
	p.publishing = false
	return PublicationUnknown
}

// Recover observes only. It verifies the stored digest, reloads original source,
// and recomputes the selected window. It cannot republish or restore authority.
func (s *Service) Recover(ctx context.Context, b contextbudget.Binding, id, operation string, p contextbudget.Policy) (contextbudget.Window, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || s.deps.Store == nil || !b.Valid() || !contextbudget.ID(id) || !contextbudget.ID(operation) || !p.Valid() {
		return contextbudget.Window{}, Invalid
	}
	saved, err := s.deps.Store.Observe(ctx, id, operation)
	if err != nil || saved == nil {
		return contextbudget.Window{}, Unavailable
	}
	if !contextbudget.ID(saved.Checkpoint.ID) || !contextbudget.ID(saved.Checkpoint.OperationID) || !contextbudget.Digest(saved.SHA256) || !saved.Expected.Valid() || !boundedWindow(saved.Checkpoint.Window) {
		return contextbudget.Window{}, Invalid
	}
	// Take independent bytes before further external calls.
	copy := *saved
	copy.Checkpoint.Window = cloneWindow(saved.Checkpoint.Window)
	if copy.Checkpoint.ID != id || copy.Checkpoint.OperationID != operation || copy.Expected != copy.Checkpoint.Window.Source || copy.Expected.Binding != b {
		return contextbudget.Window{}, contextbudget.Stale
	}
	raw, err := json.Marshal(copy.Checkpoint)
	if err != nil || len(raw) > MaxCheckpointBytes {
		return contextbudget.Window{}, Invalid
	}
	digest, err := s.deps.Digests.Digest(raw)
	if err != nil || !contextbudget.Digest(digest) || digest != copy.SHA256 {
		return contextbudget.Window{}, Invalid
	}
	source, err := s.deps.Source.Read(ctx, b)
	if err != nil {
		return contextbudget.Window{}, Unavailable
	}
	ref, err := reference(source, s.deps.Digests)
	if err != nil {
		return contextbudget.Window{}, err
	}
	if ref != copy.Expected || ctx.Err() != nil || s.deps.Source.Check(ctx, ref) != nil {
		return contextbudget.Window{}, contextbudget.Stale
	}
	w, err := contextbudget.Recover(copy.Checkpoint, source, ref, p, s.deps.Estimator)
	if err != nil {
		return contextbudget.Window{}, err
	}
	if ctx.Err() != nil || s.deps.Source.Check(ctx, ref) != nil {
		return contextbudget.Window{}, contextbudget.Stale
	}
	return w, nil
}
