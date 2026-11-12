package access

import (
	"context"
	"errors"
	"strconv"
	"sync"

	leaseport "github.com/legrch/farol/modules/computer/app/port/lease"
	observationport "github.com/legrch/farol/modules/computer/app/port/observation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	journal "github.com/legrch/farol/modules/computer/domain/journal"
	observation "github.com/legrch/farol/modules/computer/domain/observation"
)

// CurrentReaderProof is constructed ONLY by a trusted Go-owned Settings and
// recovery/update readback. No renderer, command payload, plain persisted
// toggle or unqualified older 0.5.23 reader can manufacture this port. It is
// a provisional native/preflight value, NOT authority or a completion ACK.
type CurrentReaderProof struct {
	Saved              observation.Saved
	ConsentDigest      string
	SettingsRevision   uint64
	ComputerGeneration uint64
}

// CurrentReader is deliberately absent from production boot composition until
// compatible-reader, recovery/update and owner policy witnesses are qualified.
// Implementations MUST refuse unsettled or unknown dependent operations and
// must read exact owner settings under their protected readback. This interface
// is never registered on desktop RPC. Its call occurs outside the Store mutex.
type CurrentReader interface {
	ReadQualified(context.Context, journal.Entry, authority.Approval) (CurrentReaderProof, error)
}

// HeldCurrentQualifier combines a verified current Settings proof with the
// original held C1 startup Data anchor and C3 workspace chain. A result may
// only be given to Store.ActivateCurrentTransition by trusted Go composition.
// It is never a general-purpose workspace/root reader or a new grant owner.
type HeldCurrentQualifier struct {
	reader           CurrentReader
	anchor           leaseport.Acquirer
	holder           observationport.Holder
	mutex            sync.Mutex
	active, poisoned bool
}

func NewHeldCurrentQualifier(reader CurrentReader, anchor leaseport.Acquirer, holder observationport.Holder) CurrentQualification {
	return &HeldCurrentQualifier{reader: reader, anchor: anchor, holder: holder}
}

// The same qualifier never reacquires after a native acquisition or cleanup
// with an unresolved result. This is runtime-local custody; it is not the
// historical WAL, and a later call cannot guess an earlier close succeeded.
func (q *HeldCurrentQualifier) enter() bool {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	if q.active || q.poisoned {
		return false
	}
	q.active = true
	return true
}
func (q *HeldCurrentQualifier) finish(unknown bool) {
	q.mutex.Lock()
	defer q.mutex.Unlock()
	q.active = false
	q.poisoned = q.poisoned || unknown
}

var errUnqualifiedCurrent = errors.New("WORKSPACE_CURRENT_QUALIFICATION_UNAVAILABLE")

func (q *HeldCurrentQualifier) PrepareCurrent(ctx context.Context, entry journal.Entry, proposed authority.Approval) (CurrentWitness, error) {
	if q == nil || q.reader == nil || q.anchor == nil || q.holder == nil || ctx == nil || ctx.Err() != nil ||
		entry.Phase != journal.Committed || entry.Certificate == nil || entry.Certificate.Kind != journal.Committed ||
		entry.Request.WorkspaceID == "" || entry.Request.Root == "" || entry.Request.ConsentDigest == "" {
		return nil, errUnqualifiedCurrent
	}
	if !q.enter() {
		return nil, errUnqualifiedCurrent
	}
	proof, err := q.reader.ReadQualified(ctx, entry, proposed)
	if err != nil || ctx.Err() != nil || proof.ConsentDigest != entry.Request.ConsentDigest || proof.SettingsRevision == 0 ||
		proof.ComputerGeneration != proposed.Generation || proof.Saved.Binding.Path != entry.Request.Root ||
		observation.Preflight(proof.Saved, observation.Settled) != "" {
		q.finish(false)
		return nil, errUnqualifiedCurrent
	}
	// Do not accept a mere matched inode when the reader has not proven the
	// exact persisted continuity/Settings/recovery combination.
	found := false
	var proposedIdentity authority.RootIdentity
	for _, root := range proposed.Workspaces {
		if root.WorkspaceID != entry.Request.WorkspaceID {
			continue
		}
		if found || root.Root != entry.Request.Root || root.ShellVerified ||
			root.RootIdentity.Inode != proof.Saved.Binding.Inode {
			q.finish(false)
			return nil, errUnqualifiedCurrent
		}
		found = true
		proposedIdentity = root.RootIdentity
	}
	if !found {
		q.finish(false)
		return nil, errUnqualifiedCurrent
	}
	anchor, err := q.anchor.Acquire(ctx)
	if err != nil || anchor == nil {
		q.finish(true)
		return nil, errors.Join(errUnqualifiedCurrent, ErrCurrentCustodyUnknown, err)
	}
	candidate, err := q.holder.Hold(ctx, entry.Request.Root)
	if err != nil || candidate == nil {
		// Holder may have acquired and lost the reply before returning. An
		// anchor's known close cannot prove that the other acquisition did not.
		closeErr := anchor.Close()
		q.finish(true)
		return nil, errors.Join(errUnqualifiedCurrent, ErrCurrentCustodyUnknown, err, closeErr)
	}
	w := &heldCurrentWitness{owner: q, anchor: anchor, candidate: candidate, saved: proof.Saved, root: entry.Request.Root, proposedIdentity: proposedIdentity}
	// Requalify before returning to Store (which performs another requalification
	// under its protected lock and owns the one-shot Close).
	if err := w.RequalifyCurrent(ctx); err != nil {
		q.finish(true) // stale original held native witness may not be reacquired
		return nil, errors.Join(errUnqualifiedCurrent, ErrCurrentCustodyUnknown, err, w.Close())
	}
	return w, nil
}

// The witness always retains the ORIGINAL native descriptors. No re-open by
// path is permitted after a stale native check. Failed Close is not retried.
type heldCurrentWitness struct {
	owner            *HeldCurrentQualifier
	anchor           leaseport.Anchor
	candidate        observationport.HeldObservation
	saved            observation.Saved
	root             string
	proposedIdentity authority.RootIdentity
	closed           bool
}

func (w *heldCurrentWitness) RequalifyCurrent(ctx context.Context) error {
	if w == nil || w.closed || ctx == nil || ctx.Err() != nil || w.anchor == nil || w.candidate == nil {
		return errUnqualifiedCurrent
	}
	if err := w.anchor.Requalify(ctx); err != nil {
		return errUnqualifiedCurrent
	}
	if err := w.candidate.Requalify(ctx); err != nil {
		return errUnqualifiedCurrent
	}
	current, err := w.candidate.Snapshot()
	if err != nil || !current.Valid() || current.Binding.Path != w.root ||
		current.Binding.Device != w.proposedIdentity.Device || current.Binding.Inode != w.proposedIdentity.Inode {
		return errUnqualifiedCurrent
	}
	classification := observation.Compare(w.saved, current, observation.Settled)
	if classification != observation.SameMountCandidate && classification != observation.RemountCandidate {
		return errUnqualifiedCurrent
	}
	candidate, err := w.anchor.Check(ctx, w.root)
	if err != nil || candidate.Kind != "current-data-candidate" || candidate.Authority != "not-established" || candidate.Path != w.root {
		return errUnqualifiedCurrent
	}
	device, e1 := strconv.ParseUint(current.Binding.Device, 10, 64)
	inode, e2 := strconv.ParseUint(current.Binding.Inode, 10, 64)
	if e1 != nil || e2 != nil || candidate.Device != device || candidate.Inode != inode {
		return errUnqualifiedCurrent
	}
	return nil
}

func (w *heldCurrentWitness) Close() error {
	if w == nil || w.closed {
		return errUnqualifiedCurrent
	}
	w.closed = true
	var err error
	if w.candidate != nil {
		err = errors.Join(err, w.candidate.Close())
	}
	if w.anchor != nil {
		err = errors.Join(err, w.anchor.Close())
	}
	if w.owner != nil {
		w.owner.finish(err != nil)
	}
	return err
}
