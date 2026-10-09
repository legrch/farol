package boot

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

// NativeCodexReadSelection is optional trusted launcher input. HostID names the
// existing per-profile nativeHosts.codex slot, not a discovered host or registry.
// TrustedTemp is the exact canonical app.getPath("temp") value. Neither input
// comes from a read request. Native/wire/handshake qualification remains separate.
type NativeCodexReadSelection struct {
	HostID      string
	TrustedTemp string
}

func (s NativeCodexReadSelection) valid() bool {
	return s.HostID == "codex" && validProfilePath(s.TrustedTemp)
}

const nativeCodexReadCleanupBudget = 2 * time.Second

// This owner only composes existing resources. It retains the original opening
// attempt, profile, scratch and selected Reader; no failure replaces any of them.
// The private factory is a CPU-test seam. Production always uses OpenTaskProfile.
type nativeCodexRead struct {
	mu                    sync.Mutex
	lifetime              context.Context
	cancel                context.CancelFunc
	source                PublishedCodexReadSource
	scratch               *TaskReadScratch
	openProfile           func() (*TaskProfile, error)
	profile               *TaskProfile
	reader                selectedthread.Reader
	initDone              chan struct{}
	initErr               error
	knownPreClientRefusal bool
	handlers              int
	drained               chan struct{}
	closing               bool
	closeDone             chan struct{}
	closeContext          context.Context
	closeErr              error
}

func newNativeCodexRead(ctx context.Context, scratch *TaskReadScratch, source PublishedCodexReadSource, open func() (*TaskProfile, error)) *nativeCodexRead {
	lifetime, cancel := context.WithCancel(ctx)
	return &nativeCodexRead{lifetime: lifetime, cancel: cancel, scratch: scratch, source: source, openProfile: open, drained: make(chan struct{})}
}

func (r *NativeRuntime) selectNativeCodexRead(ctx context.Context, input NativeCodexReadSelection) {
	r.codexRead = newNativeCodexRead(ctx, NewTaskReadScratch(input.TrustedTemp), PublishedCodexReadSource{
		Current: r.ingress, HostID: input.HostID, Verifier: codexclient.NativeBoundary(), Now: time.Now,
	}, func() (*TaskProfile, error) {
		return OpenTaskProfile(r.profile, r.conversations.peer, r.conversations.owner, r.conversations)
	})
}

func nativeCodexReadFailure(err error) error {
	var failure *selectedthread.Failure
	if errors.As(err, &failure) {
		return failure
	}
	code := "TASK_OBSERVATION_UNKNOWN"
	switch {
	case errors.Is(err, task.ErrIdentity):
		code = "TASK_IDENTITY_MISMATCH"
	case errors.Is(err, task.ErrState):
		code = "TASK_STATE_REFUSED"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = "TASK_REQUEST_CANCELLED"
	case errors.Is(err, task.ErrInvalid):
		code = "TASK_INPUT_INVALID"
	case errors.Is(err, task.ErrUnavailable), errors.Is(err, task.ErrUnsupported):
		code = "TASK_UNAVAILABLE"
	}
	return &selectedthread.Failure{Code: code}
}

// ReadSelectedCodex exposes only IncludeResult. Selection remains sealed by the
// original TaskProfile reader, which rechecks exact current authority around IO.
// There is deliberately no desktop Method/socket/handshake registration here.
func (r *NativeRuntime) ReadSelectedCodex(ctx context.Context, request selectedthread.Request) (*selectedthread.Response, error) {
	if ctx == nil {
		return nil, nativeCodexReadFailure(task.ErrInvalid)
	}
	if r == nil || r.closed.Load() || r.codexRead == nil {
		return nil, nativeCodexReadFailure(task.ErrUnavailable)
	}
	return r.codexRead.read(ctx, request)
}

func (n *nativeCodexRead) read(ctx context.Context, request selectedthread.Request) (*selectedthread.Response, error) {
	if ctx == nil {
		return nil, nativeCodexReadFailure(task.ErrInvalid)
	}
	n.mu.Lock()
	if n.closing || ctx.Err() != nil || n.lifetime.Err() != nil {
		n.mu.Unlock()
		return nil, nativeCodexReadFailure(task.ErrUnavailable)
	}
	n.handlers++
	first := n.initDone == nil
	if first {
		n.initDone = make(chan struct{})
	}
	done := n.initDone
	n.mu.Unlock()
	defer func() {
		n.mu.Lock()
		defer n.mu.Unlock()
		n.handlers--
		if n.closing && n.handlers == 0 {
			close(n.drained)
		}
	}()
	readCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(n.lifetime, cancel)
	defer func() { stop(); cancel() }()
	if first {
		n.initialize(readCtx)
	}
	select {
	case <-done:
	case <-readCtx.Done():
		return nil, nativeCodexReadFailure(readCtx.Err())
	}
	n.mu.Lock()
	reader, err, closing := n.reader, n.initErr, n.closing
	n.mu.Unlock()
	if err != nil {
		return nil, nativeCodexReadFailure(err)
	}
	if closing || reader == nil {
		return nil, nativeCodexReadFailure(task.ErrUnavailable)
	}
	out, err := reader.Read(readCtx, request)
	// Hold the closing fence through the final disclosure decision. A cancelled
	// lifetime or late completion never becomes usable output or a drain proof.
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closing || readCtx.Err() != nil || n.lifetime.Err() != nil {
		return nil, nativeCodexReadFailure(task.ErrUnavailable)
	}
	return out, err
}

func (n *nativeCodexRead) initialize(ctx context.Context) {
	var profile *TaskProfile
	var reader selectedthread.Reader
	var err error
	knownPreClientRefusal := false
	if ctx.Err() != nil || n.lifetime.Err() != nil || n.openProfile == nil || n.scratch == nil || n.source.Current == nil {
		err = task.ErrUnavailable
	} else {
		profile, err = n.openProfile()
		if err == nil && profile == nil {
			err = task.ErrUnavailable
		}
		if err == nil {
			var root TaskReadScratchRoot
			root, err = n.scratch.Open(ctx)
			if err == nil {
				input := n.source
				input.ScratchRoot = root.Path
				reader, err = profile.SelectPublishedCodexRead(ctx, input)
				if err == task.ErrUnavailable && reader == nil && ctx.Err() == nil && n.lifetime.Err() == nil {
					// Only a successful profile/scratch opening followed by this
					// exact known refusal may be separated from cleanup. The read
					// slot is claimed BEFORE any client factory/registration; its
					// absence under the same mutex proves none was attempted.
					profile.mu.Lock()
					knownPreClientRefusal = !profile.closed.Load() && profile.read == nil && len(profile.clients) == 0
					profile.mu.Unlock()
				}
			}
		}
	}
	n.mu.Lock()
	n.profile, n.reader, n.initErr = profile, reader, err
	n.knownPreClientRefusal = knownPreClientRefusal
	close(n.initDone)
	n.mu.Unlock()
}

// close uses one fixed first budget, independent of any request cancellation.
// Repeated callers observe the same work/result; they never renew cleanup.
// The worker retains a late original opening even after an unproved deadline.
func (n *nativeCodexRead) close() error {
	if n == nil {
		return nil
	}
	n.mu.Lock()
	if !n.closing {
		n.closing = true
		n.cancel()
		if n.handlers == 0 {
			close(n.drained)
		}
		n.closeDone = make(chan struct{})
		ctx, cancel := context.WithTimeout(context.Background(), nativeCodexReadCleanupBudget)
		n.closeContext = ctx
		go n.cleanup(ctx, cancel)
	}
	done, ctx := n.closeDone, n.closeContext
	n.mu.Unlock()
	select {
	case <-done:
	default:
		select {
		case <-done:
		case <-ctx.Done():
			n.mu.Lock()
			// Completed proof wins over a simultaneous deadline. Otherwise the
			// original unknown outcome survives every later exit observation.
			select {
			case <-done:
			default:
				n.closeErr = task.ErrUnknown
			}
			n.mu.Unlock()
		}
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.closeErr
}

func (n *nativeCodexRead) cleanup(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	n.mu.Lock()
	opening := n.initDone
	n.mu.Unlock()
	if opening != nil {
		// Await the ORIGINAL registration, even if the bounded caller already
		// returned unknown. Late cleanup still receives the expired first budget.
		<-opening
	}
	n.mu.Lock()
	profile, initialization := n.profile, n.initErr
	if n.knownPreClientRefusal {
		// Selection remains sticky in initErr. This one proved refusal had no
		// client to close; actual profile close, handler drain, physical release
		// and the original deadline still independently determine cleanup.
		initialization = nil
	}
	n.mu.Unlock()
	var clientErr error
	if profile != nil {
		clientErr = profile.Close(ctx)
	}
	joined := TaskReadScratchJoined{OriginalClientExit: clientErr == nil && (profile != nil || initialization == nil)}
	select {
	case <-n.drained:
		joined.ReadHandlersDrained = true
	default:
		select {
		case <-n.drained:
			joined.ReadHandlersDrained = true
		case <-ctx.Done():
		}
	}
	var scratchErr error
	if n.scratch != nil {
		_, scratchErr = n.scratch.Close(ctx, joined)
	}
	n.mu.Lock()
	n.closeErr = errors.Join(n.closeErr, initialization, clientErr, scratchErr)
	if ctx.Err() != nil || !joined.OriginalClientExit || !joined.ReadHandlersDrained {
		n.closeErr = errors.Join(task.ErrUnknown, n.closeErr)
	}
	close(n.closeDone)
	n.mu.Unlock()
}

func (r *NativeRuntime) closeCodexRead() error {
	return r.codexRead.close()
}
