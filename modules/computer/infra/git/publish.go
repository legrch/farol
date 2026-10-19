package git

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"

	egressport "github.com/legrch/farol/modules/computer/app/port/egress"
	"github.com/legrch/farol/modules/computer/domain/egress"
)

var ErrPort = errors.New("GIT_TRANSPORT_PORT_FAILURE")

type RefOutcome string

const (
	NotAttempted RefOutcome = "not_attempted"
	Unknown      RefOutcome = "unknown"
	Accepted     RefOutcome = "accepted_report"
	Rejected     RefOutcome = "rejected_report"
	NoUpdate     RefOutcome = "no_update_requested"
)

// Result contains observations, not a durable publication receipt. The existing
// operation owner must persist it. Even Accepted requires independent ref
// readback; neither process/descendant closure nor overall completion is implied.
type Result struct {
	InputPackSHA256                        string
	InputBytes                             int64
	Stage                                  string // last observed protocol boundary, never inferred execution state
	OperationID, IntentDigest              string
	RefOutcome                             RefOutcome
	ReleaseFenceAttempted, ReleaseFenced   bool
	RemoteMayHaveEffects                   bool
	CommandBytes, PackBytes                int64
	PackSHA256                             string
	ObjectCount                            int
	ClientNotified, StreamCleanupUncertain bool
}

// Gate is one prepared in-memory stream adapter. The atomic guard prevents reuse
// of this instance only; cross-restart/reconnect non-replay MUST come from the
// existing durable Custody owner. It is not a second reservation database.
type Gate struct {
	plan    *egress.Plan
	digest  string
	custody egressport.Custody
	objects egressport.Objects
	used    atomic.Bool
}

func NewGate(plan *egress.Plan, custody egressport.Custody, objects egressport.Objects) (*Gate, error) {
	digest := IntentDigest(plan)
	if digest == "" || custody == nil {
		return nil, ErrScope
	}
	return &Gate{plan: plan, digest: digest, custody: custody, objects: objects}, nil
}

// Run takes ownership of two original, interruptible streams. Both are closed
// once on completion/cancellation; no PID lookup, kill, dial or retry occurs.
// peer must already be authenticated under the same admitted intent. Source and
// destination validation, SSH config/agent isolation and native qualification
// cannot be replaced by constructing a Plan or supplying a permissive Custody.
func (g *Gate) Run(ctx context.Context, client io.ReadWriteCloser, peer egressport.Peer) (result *Result, err error) {
	if g == nil || g.plan == nil || !g.used.CompareAndSwap(false, true) {
		return nil, ErrReplay
	}
	in := g.plan.Intent()
	result = &Result{OperationID: in.Binding.OperationID, IntentDigest: g.digest, RefOutcome: NotAttempted, Stage: "admission"}
	var once sync.Once
	var closeErr error
	closed := make(chan struct{})
	closeStreams := func() {
		once.Do(func() {
			defer close(closed)
			if client != nil {
				closeErr = closeSafely(client)
			}
			if peer != nil {
				closeErr = errors.Join(closeErr, closeSafely(peer))
			}
		})
	}
	stop := func() bool { return true }
	defer func() {
		stop()
		closeStreams()
		<-closed
		result.StreamCleanupUncertain = closeErr != nil
		if recovered := recover(); recovered != nil {
			err = ErrPort
		}
		if closeErr != nil {
			err = errors.Join(err, ErrPort)
		}
		// Cancellation closes blocked streams, whose own errors then surface;
		// the context's end is the cause, so keep it in the classification.
		if err != nil && ctx != nil && ctx.Err() != nil {
			err = errors.Join(contextEnded{ctx.Err()}, err)
		}
		err = classified(err)
	}()
	if ctx == nil {
		return result, ErrScope
	}
	if client == nil || peer == nil {
		return result, ErrPort // the owner supplied no stream
	}
	if _, bounded := ctx.Deadline(); !bounded {
		return result, ErrScope
	}
	stop = context.AfterFunc(ctx, closeStreams)
	if peer.Binding() != in.Target {
		return result, ErrScope
	}
	check := func() error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if e := g.custody.Check(ctx, g.digest); e != nil {
			return custodyFailure(e)
		}
		return ctx.Err()
	}
	if err = check(); err != nil {
		return result, err
	}
	result.Stage = "advertisement"
	ad, err := readAdvertisement(peer, in)
	if err != nil {
		return result, err
	}
	if err = check(); err != nil {
		return result, err
	}
	if err = ad.writeTo(client); err != nil {
		return result, err
	}
	result.Stage = "client_update"
	command, noUpdate, err := readUpdate(client, in, ad)
	if err != nil {
		return result, err
	}
	if noUpdate {
		result.RefOutcome = NoUpdate
		return result, nil
	}
	result.Stage = "pack_validation"
	pack, err := readPack(ctx, client, g.plan, g.objects)
	if err != nil {
		return result, err
	}
	result.InputPackSHA256 = packDigest(pack.bytes)
	result.InputBytes = int64(len(pack.bytes))
	upload, count, canonicalErr := pack.canonical()
	if canonicalErr != nil {
		return result, canonicalErr
	}
	result.PackSHA256 = packDigest(upload)
	result.ObjectCount = count
	if err = check(); err != nil {
		return result, err
	}
	// The durable intent/unknown-effect barrier MUST precede the first attempted
	// update byte. A crashed or refused barrier never permits another attempt.
	result.Stage = "release_fence"
	result.ReleaseFenceAttempted = true
	if err = g.custody.BeforeRelease(ctx, g.digest); err != nil {
		return result, custodyFailure(err)
	}
	result.ReleaseFenced = true
	if err = check(); err != nil {
		return result, err
	}
	result.Stage = "upload"
	result.RemoteMayHaveEffects = true
	result.RefOutcome = Unknown
	result.CommandBytes, err = writeAll(peer, command)
	if err != nil {
		return result, err
	}
	// Keep every write bounded and recheck original authority between chunks.
	for data := upload; len(data) > 0; {
		if err = check(); err != nil {
			return result, err
		}
		n := len(data)
		if n > 32<<10 {
			n = 32 << 10
		}
		var written int64
		written, err = writeAll(peer, data[:n])
		result.PackBytes += written
		if err != nil {
			return result, err
		}
		data = data[n:]
	}
	result.Stage = "remote_report"
	accepted, reply, err := readStatus(peer, in.Ref)
	if err != nil {
		return result, err
	}
	if accepted {
		result.RefOutcome = Accepted
	} else {
		result.RefOutcome = Rejected
	}
	if err = check(); err != nil {
		return result, err
	}
	result.Stage = "client_report"
	_, err = writeAll(client, reply)
	result.ClientNotified = err == nil
	return result, err
}
func closeSafely(c io.Closer) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrPort
		}
	}()
	return c.Close()
}
