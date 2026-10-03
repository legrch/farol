package journal

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

func (r *Repo) CompareAndSwap(ctx context.Context, expected string, value release.Journal) (*port.JournalView, error) {
	r.gate.Lock()
	defer r.gate.Unlock()
	if r.closed {
		return nil, port.JournalClosed
	}
	if r.unknown || r.admission.JournalUnknown(r.operation) {
		return nil, port.JournalUnknown
	}
	if ctx.Err() != nil {
		return nil, port.JournalCancelled
	}
	if value.Operation != r.operation {
		return nil, records.BindingMismatch
	}
	data, err := records.EncodeJournal(record(value))
	if err != nil {
		return nil, err
	}
	token, err := hex.DecodeString(expected)
	if err != nil || len(token) != 32 || hex.EncodeToString(token) != expected {
		return nil, port.JournalInvalid
	}
	old, err := r.read()
	if err != nil {
		return nil, err
	}
	if old.view.Revision != expected {
		return nil, port.JournalConflict
	}
	if err := r.admission.ReverifyJournal(ctx, r.operation, r.identity()); err != nil {
		r.unknown = true
		r.admission.RetainJournalUnknown(r.operation)
		return nil, port.JournalUnproven
	}
	if ctx.Err() != nil {
		return nil, port.JournalCancelled
	}
	// Randomness and encoding fail before any possible metadata mutation.
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, port.JournalUnavailable
	}
	temporary := ".journal-" + hex.EncodeToString(nonce[:])
	if r.checkpoint("create-before") != nil {
		return nil, port.JournalUnavailable
	}
	if ctx.Err() != nil {
		return nil, port.JournalCancelled
	}
	if r.checkDirectory() != nil {
		return nil, port.JournalChanged
	}
	// Once create is invoked even a lost/error response can conceal persistence.
	fd, err := r.root.OpenFile(temporary, createFlags(), 0o600)
	if err != nil {
		if fd != nil {
			fd.Close()
		}
		return nil, r.retainUnknown()
	}
	closed := false
	defer func() {
		if !closed {
			fd.Close()
		}
	}()
	if r.checkpoint("create-after") != nil {
		return nil, r.retainUnknown()
	}
	createdInfo, err := fd.Stat()
	if err != nil {
		return nil, r.retainUnknown()
	}
	created, ok := metadata(createdInfo)
	if !ok || !privateFile(createdInfo, created) || created.Size != 0 {
		return nil, r.retainUnknown()
	}
	for offset := 0; offset < len(data); {
		write := r.writeChunk
		if write == nil {
			write = func(f *os.File, data []byte) (int, error) { return f.Write(data) }
		}
		n, err := write(fd, data[offset:])
		if err != nil || n <= 0 {
			return nil, r.retainUnknown()
		}
		offset += n
	}
	if r.checkpoint("write-after") != nil || r.checkpoint("file-sync-before") != nil {
		return nil, r.retainUnknown()
	}
	if fd.Sync() != nil || r.checkpoint("file-sync-after") != nil {
		return nil, r.retainUnknown()
	}
	completeInfo, err := fd.Stat()
	if err != nil {
		return nil, r.retainUnknown()
	}
	complete, ok := metadata(completeInfo)
	if !ok || !privateFile(completeInfo, complete) || complete.object() != created.object() || complete.Size != int64(len(data)) {
		return nil, r.retainUnknown()
	}
	if fd.Close() != nil {
		closed = true
		return nil, r.retainUnknown()
	}
	closed = true
	if r.checkpoint("file-close-after") != nil || r.checkpoint("publish-before") != nil {
		return nil, r.retainUnknown()
	}
	// Finish the already-issued local persistence drain despite caller cancellation.
	// This is not a new helper/probe budget; the retained owner bounds its verifier.
	if r.admission.ReverifyJournal(context.WithoutCancel(ctx), r.operation, r.identity()) != nil {
		return nil, r.retainUnknown()
	}
	current, err := r.read()
	if err != nil || current.view.Revision != expected {
		return nil, r.retainUnknown()
	}
	tempInfo, err := r.root.Lstat(temporary)
	if err != nil {
		return nil, r.retainUnknown()
	}
	tempState, ok := metadata(tempInfo)
	if !ok || !privateFile(tempInfo, tempState) || tempState != complete || r.checkDirectory() != nil {
		return nil, r.retainUnknown()
	}
	// Absence uses native no-replace. Existing-record CAS relies on the borrowed
	// shared gate AND the authoritative exclusion of all other writers/helpers.
	publish := r.publish
	if publish == nil {
		publish = rename
	}
	if publish(r.parent, temporary, current.state == nil) != nil || r.checkpoint("rename-after") != nil {
		return nil, r.retainUnknown()
	}
	if r.checkpoint("parent-sync-before") != nil || r.parent.Sync() != nil || r.checkpoint("parent-sync-after") != nil {
		return nil, r.retainUnknown()
	}
	after, err := r.read()
	if err != nil || after.state == nil || after.state.object() != complete.object() || !bytes.Equal(after.data, data) {
		return nil, r.retainUnknown()
	}
	if r.checkpoint("ack-before") != nil || ctx.Err() != nil {
		return nil, r.retainUnknown()
	}
	return after.view, nil
}
