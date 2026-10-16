package journal

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

type observation struct {
	view  *port.JournalView
	state *fileState
	data  []byte
}

func (r *Repo) Read(ctx context.Context) (*port.JournalView, error) {
	r.gate.Lock()
	defer r.gate.Unlock()
	if r.closed {
		return nil, port.JournalClosed
	}
	if ctx.Err() != nil {
		return nil, port.JournalCancelled
	}
	observed, err := r.read()
	if err != nil {
		return nil, err
	}
	return observed.view, nil
}

// read is descriptor-relative and called under the borrowed serialization gate.
// Reading an unknown write's physical bytes does not clear retained uncertainty.
func (r *Repo) read() (*observation, error) {
	return r.readWithOptions(readOptions{maxBytes: records.MaxRecordBytes})
}

type readOptions struct {
	maxBytes int
	bound    func() error
}

func (o readOptions) check() error {
	if o.bound == nil {
		return nil
	}
	return o.bound()
}

func (r *Repo) readWithOptions(options readOptions) (observed *observation, result error) {
	// Registered before descriptor cleanup so the final bound includes Close.
	defer func() {
		if err := options.check(); err != nil {
			observed = nil
			result = errors.Join(result, err)
		}
	}()
	if err := options.check(); err != nil {
		return nil, err
	}
	if err := r.checkDirectory(); err != nil {
		return nil, err
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	named, err := r.root.Lstat(filename)
	if errors.Is(err, os.ErrNotExist) {
		if r.checkpoint("read-absence") != nil {
			return nil, port.JournalChanged
		}
		if err := options.check(); err != nil {
			return nil, err
		}
		if r.checkDirectory() != nil {
			return nil, port.JournalChanged
		}
		if err := options.check(); err != nil {
			return nil, err
		}
		if _, err := r.root.Lstat(filename); !errors.Is(err, os.ErrNotExist) {
			return nil, port.JournalChanged
		}
		return &observation{view: &port.JournalView{Revision: r.revision(nil, nil)}}, nil
	}
	if err != nil {
		return nil, port.JournalUnavailable
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	before, ok := metadata(named)
	if !ok || !privateFile(named, before) {
		return nil, records.Invalid
	}
	if before.Size > int64(options.maxBytes) {
		return nil, records.Oversized
	}
	if err := r.checkpoint("read-open"); err != nil {
		return nil, port.JournalChanged
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	fd, err := r.root.OpenFile(filename, fileFlags(), 0)
	if err != nil {
		return nil, port.JournalChanged
	}
	closed := false
	defer func() {
		if !closed {
			fd.Close()
		}
	}()
	if err := options.check(); err != nil {
		return nil, err
	}
	opened, err := fd.Stat()
	if err != nil {
		return nil, port.JournalChanged
	}
	current, ok := metadata(opened)
	if !ok || !privateFile(opened, current) || current != before {
		return nil, port.JournalChanged
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(fd, int64(options.maxBytes)+1))
	if err != nil || int64(len(data)) != before.Size || len(data) > options.maxBytes {
		return nil, port.JournalChanged
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	if r.checkpoint("read-bytes") != nil {
		return nil, port.JournalChanged
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	after, err := fd.Stat()
	if err != nil {
		return nil, port.JournalChanged
	}
	current, ok = metadata(after)
	if !ok || !privateFile(after, current) || current != before {
		return nil, port.JournalChanged
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	again, err := r.root.Lstat(filename)
	if err != nil {
		return nil, port.JournalChanged
	}
	current, ok = metadata(again)
	if !ok || !privateFile(again, current) || current != before {
		return nil, port.JournalChanged
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	if r.checkDirectory() != nil {
		return nil, port.JournalChanged
	}
	if err := options.check(); err != nil {
		return nil, err
	}
	if fd.Close() != nil {
		closed = true
		return nil, port.JournalChanged
	}
	closed = true
	if err := options.check(); err != nil {
		return nil, err
	}
	decoded, err := records.DecodeJournal(data, record(release.Journal{Operation: r.operation}).Operation)
	if err != nil {
		return nil, err
	}
	value := decoded.Domain()
	return &observation{view: &port.JournalView{Value: &value, Revision: r.revision(&before, data)}, state: &before, data: data}, nil
}
