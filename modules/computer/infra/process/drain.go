package process

import (
	"io"
	"os/exec"
	"sync/atomic"
)

// drainWitness observes the os/exec pipe copier's actual EOF independently of
// Cmd.Wait's preferred error. A nonzero/signal ExitError can hide IO failure.
// Writers retain the existing bounded, nonblocking collector requirement.
type drainWitness struct {
	writer                  io.Writer
	started, copied, failed atomic.Bool
}

func (w *drainWitness) Write(data []byte) (int, error) {
	if w.writer == nil {
		return 0, io.ErrClosedPipe
	}
	return w.writer.Write(data)
}

func (w *drainWitness) ReadFrom(source io.Reader) (int64, error) {
	if !w.started.CompareAndSwap(false, true) {
		w.failed.Store(true)
		return 0, io.ErrClosedPipe
	}
	reader := &eofReader{source: source}
	// Strip both optimization interfaces so EOF is observed by Read, and all
	// bytes reach the SAME collector even when optimized copy methods exist.
	n, err := io.Copy(struct{ io.Writer }{w}, struct{ io.Reader }{reader})
	w.copied.Store(err == nil && reader.eof)
	return n, err
}

func (w *drainWitness) drained() bool {
	return w != nil && w.copied.Load() && !w.failed.Load()
}

type eofReader struct {
	source io.Reader
	eof    bool
}

func (r *eofReader) Read(data []byte) (int, error) {
	n, err := r.source.Read(data)
	if err == io.EOF {
		r.eof = true
	}
	return n, err
}

func commandOutputDrained(cmd *exec.Cmd, err error) bool {
	if cmd == nil {
		return false
	}
	if _, exited := err.(*exec.ExitError); err != nil && !exited {
		return false
	}
	out, outOK := cmd.Stdout.(*drainWitness)
	diagnostic, errOK := cmd.Stderr.(*drainWitness)
	return outOK && errOK && out != diagnostic && out.drained() && diagnostic.drained()
}
