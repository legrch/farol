package results

import (
	"bytes"
	"context"
	"sync"

	"github.com/legrch/farol/modules/chat/app/port"
)

const (
	Refused Code = "CHAT_RESULT_STORAGE_REFUSED"
	Unknown Code = "CHAT_RESULT_STORAGE_UNKNOWN"
)

// Failure contains classified, content-free storage uncertainty.
type Failure struct {
	Code           Code
	OutcomeUnknown bool
}

func (e *Failure) Error() string               { return string(e.Code) }
func (e *Failure) Unwrap() error               { return e.Code }
func resultFailure(c Code, unknown bool) error { return &Failure{Code: c, OutcomeUnknown: unknown} }

// Root is trusted boot input. Path names the already qualified Chat root.
// The adapter owns only its fixed chat-results child.
type Root struct {
	Path, ProfileID string
	Identity        port.JournalRoot
}

// resultStorage is private: fixtures exercise codec/publication failure without
// acquiring native roots, filesystem claims, processes or provider authority.
type resultStorage interface {
	identity() port.JournalRoot
	inventory(context.Context) ([]string, error)
	read(context.Context, string) ([]byte, error)
	append(context.Context, string, []byte) error
	poison() error
	close() error
}

// Native holds one exclusive lifetime claim. Loaded records are historical data;
// only publications known successful in this live owner qualify duplicate Retain.
type Native struct {
	mu                 sync.Mutex
	lifetime           context.Context
	root               Root
	scope              port.JournalScope
	limits             Limits
	disk               resultStorage
	known              map[string]port.ResultPublication
	poisoned, closed   bool
	fenceErr, closeErr error
}

var _ port.DurableResults = (*Native)(nil)

func validResultComposition(ctx, lifetime context.Context, root Root, scope port.JournalScope, limits Limits, mode string) bool {
	return !nilContext(ctx) && !nilContext(lifetime) && ctx.Err() == nil && lifetime.Err() == nil && validID(root.ProfileID) && root.ProfileID == scope.ProfileID && validID(scope.BackendGeneration) && root.Identity.Device != 0 && root.Identity.Inode != 0 && (mode == "create" || mode == "open") && limits.Results > 0 && limits.Results <= MaxResults && limits.ResultBytes > 0 && limits.ResultBytes <= MaxResultBytes && limits.TotalBytes >= limits.ResultBytes && limits.TotalBytes <= MaxTotalBytes
}
func newResultOwner(ctx, lifetime context.Context, root Root, scope port.JournalScope, limits Limits, disk resultStorage) (*Native, error) {
	n := &Native{lifetime: lifetime, root: root, scope: scope, limits: limits, disk: disk, known: make(map[string]port.ResultPublication)}
	_, _, err := n.scan(ctx)
	if err != nil {
		_ = n.Close()
		return nil, err
	}
	return n, nil
}
func (n *Native) check(ctx context.Context) error {
	if nilContext(ctx) {
		return Invalid
	}
	if n.poisoned {
		return resultFailure(Unknown, true)
	}
	if n.disk == nil || n.closed || nilContext(n.lifetime) || n.lifetime.Err() != nil || ctx.Err() != nil {
		return Unavailable
	}
	return nil
}
func (n *Native) uncertain() error {
	if !n.poisoned {
		n.poisoned = true
		n.fenceErr = n.disk.poison()
	}
	return resultFailure(Unknown, true)
}

// scan qualifies all retained bytes, including earlier backend generations.
// Neither a valid commit nor this scan proves the caller saw Retain success.
func (n *Native) scan(ctx context.Context) (map[string]resultRecord, int, error) {
	keys, err := n.disk.inventory(ctx)
	if err != nil || len(keys) > MaxResults {
		return nil, 0, n.uncertain()
	}
	records := make(map[string]resultRecord, len(keys))
	total := 0
	for _, key := range keys {
		if _, exists := records[key]; exists {
			return nil, 0, n.uncertain()
		}
		raw, err := n.disk.read(ctx, key)
		if err != nil {
			return nil, 0, n.uncertain()
		}
		r, err := decodeResult(raw)
		if err != nil || r.Root != n.root.Identity || r.StorageRoot != n.disk.identity() || r.Request.Binding.ProfileID != n.root.ProfileID || resultKey(r.Request) != key {
			return nil, 0, n.uncertain()
		}
		total += len(r.Request.Payload)
		if total > MaxTotalBytes {
			return nil, 0, n.uncertain()
		}
		records[key] = r
	}
	// Recheck the inventory after IO. A lost/extra file is never an empty store.
	after, err := n.disk.inventory(ctx)
	if err != nil || len(after) != len(records) {
		return nil, 0, n.uncertain()
	}
	seen := make(map[string]bool, len(after))
	for _, key := range after {
		if _, ok := records[key]; !ok || seen[key] {
			return nil, 0, n.uncertain()
		}
		seen[key] = true
	}
	if ctx.Err() != nil || n.lifetime.Err() != nil {
		return nil, 0, n.uncertain()
	}
	// Records that previously returned success must still exist unchanged.
	for key, p := range n.known {
		r, exists := records[key]
		raw, err := encodeResult(r)
		if !exists || err != nil || resultPublication(r, raw) != p {
			return nil, 0, n.uncertain()
		}
	}
	return records, total, nil
}
func (n *Native) Retain(ctx context.Context, q port.RetainRequest) (*port.RetainReceipt, error) {
	if n == nil {
		return nil, Invalid
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.check(ctx); err != nil {
		return nil, err
	}
	if len(q.Payload) > n.limits.ResultBytes || !validBinding(q.Binding) || !validResult(q.Result) || !q.Conversation.Valid(q.Result, q.Payload) {
		return nil, Invalid
	}
	if q.Binding.ProfileID != n.scope.ProfileID || q.Binding.BackendGeneration != n.scope.BackendGeneration {
		return nil, Mismatch
	}
	q.Payload = append([]byte(nil), q.Payload...)
	r := resultRecord{Version: 1, Root: n.root.Identity, StorageRoot: n.disk.identity(), Request: q}
	raw, err := encodeResult(r)
	if err != nil {
		return nil, err
	}
	records, total, err := n.scan(ctx)
	if err != nil {
		return nil, err
	}
	key := resultKey(q)
	p := resultPublication(r, raw)
	if old, found := records[key]; found {
		oldRaw, _ := encodeResult(old)
		if !bytes.Equal(oldRaw, raw) {
			return nil, Conflict
		}
		if known, ok := n.known[key]; !ok || known != p {
			return nil, n.uncertain()
		}
		if ctx.Err() != nil || n.lifetime.Err() != nil {
			return nil, n.uncertain()
		}
		return resultReceipt(r, p), nil
	}
	if len(records) >= n.limits.Results || len(q.Payload) > n.limits.TotalBytes-total {
		return nil, Capacity
	}
	if ctx.Err() != nil || n.lifetime.Err() != nil {
		return nil, Unavailable
	}
	if n.disk.append(ctx, key, raw) != nil {
		return nil, n.uncertain()
	}
	visible, err := n.disk.read(ctx, key)
	if err != nil || !bytes.Equal(visible, raw) {
		return nil, n.uncertain()
	}
	// Full scan includes durable readback, bounds and unexpected-inventory checks.
	final, _, err := n.scan(ctx)
	if err != nil {
		return nil, err
	}
	committed, present := final[key]
	committedRaw, encodeErr := encodeResult(committed)
	if !present || encodeErr != nil || !bytes.Equal(committedRaw, raw) || ctx.Err() != nil || n.lifetime.Err() != nil {
		return nil, n.uncertain()
	}
	n.known[key] = p
	return resultReceipt(r, p), nil
}
func resultReceipt(r resultRecord, p port.ResultPublication) *port.RetainReceipt {
	return &port.RetainReceipt{Binding: r.Request.Binding, Result: r.Request.Result, Conversation: r.Request.Conversation, Bytes: len(r.Request.Payload), Publication: p}
}

// Read matches one exact original publication. It grants no historical terminal
// qualification or current read authority; both belong to the caller service.
func (n *Native) Read(ctx context.Context, q port.ResultRead) (*port.RetainRequest, error) {
	if n == nil {
		return nil, Invalid
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.check(ctx); err != nil {
		return nil, err
	}
	if !validBinding(q.Binding) || !validResult(q.Result) || !q.Publication.Valid() {
		return nil, Invalid
	}
	if q.Binding.ProfileID != n.root.ProfileID || q.Publication.Root != n.root.Identity || q.Publication.StorageRoot != n.disk.identity() {
		return nil, Mismatch
	}
	records, _, err := n.scan(ctx)
	if err != nil {
		return nil, err
	}
	r, found := records[resultKey(port.RetainRequest{Binding: q.Binding})]
	if !found {
		return nil, n.uncertain()
	}
	raw, _ := encodeResult(r)
	if r.Request.Binding != q.Binding || r.Request.Result != q.Result || resultPublication(r, raw) != q.Publication {
		return nil, Mismatch
	}
	copy := r.Request
	copy.Payload = append([]byte(nil), copy.Payload...)
	if ctx.Err() != nil || n.lifetime.Err() != nil {
		return nil, n.uncertain()
	}
	return &copy, nil
}

// Fence attempts a durable UNKNOWN marker once, even after known publication or
// cancellation. A failed attempt stays sticky in this owner; it is never retried.
func (n *Native) Fence(ctx context.Context) error {
	if n == nil || nilContext(ctx) {
		return Invalid
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.disk == nil || n.closed {
		return resultFailure(Unknown, true)
	}
	if !n.poisoned {
		n.poisoned = true
		n.fenceErr = n.disk.poison()
	}
	return n.fenceErr
}
func (n *Native) Close() error {
	if n == nil {
		return Invalid
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return n.closeErr
	}
	n.closed = true
	if n.disk != nil && n.disk.close() != nil {
		n.closeErr = resultFailure(Unknown, true)
		n.poisoned = true
	}
	n.known = nil
	return n.closeErr
}
