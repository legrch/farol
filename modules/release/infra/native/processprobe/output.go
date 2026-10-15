package processprobe

import (
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
	"unicode/utf8"
)

// drainWitness records the copier's actual EOF. ExitError, a closed pipe and a
// retained bounded prefix are not substitutes for that witness.
type drainWitness struct {
	mu                      sync.Mutex
	data                    []byte
	tooLarge                atomic.Bool
	started, copied, failed atomic.Bool
	onOverflow              func()
}

func newDrain(onOverflow func()) *drainWitness {
	return &drainWitness{data: make([]byte, 0, streamLimit), onOverflow: onOverflow}
}

func (w *drainWitness) Write(data []byte) (int, error) {
	w.mu.Lock()
	remaining := streamLimit - len(w.data)
	keep := min(len(data), remaining)
	w.data = append(w.data, data[:keep]...)
	overflow := len(data) > remaining
	w.mu.Unlock()
	if overflow && w.tooLarge.CompareAndSwap(false, true) && w.onOverflow != nil {
		w.onOverflow()
	}
	// Drain the original pipe even after overflow; never collect unbounded data.
	return len(data), nil
}

func (w *drainWitness) ReadFrom(source io.Reader) (int64, error) {
	if !w.started.CompareAndSwap(false, true) {
		w.failed.Store(true)
		return 0, io.ErrClosedPipe
	}
	r := &eofReader{source: source}
	// Hide optimization interfaces so all copies use this reader's actual EOF
	// and the same bounded writer, including optimized native pipe sources.
	n, err := io.Copy(struct{ io.Writer }{w}, struct{ io.Reader }{r})
	w.copied.Store(err == nil && r.eof)
	return n, err
}

func (w *drainWitness) drained() bool  { return w.copied.Load() && !w.failed.Load() }
func (w *drainWitness) exceeded() bool { return w.tooLarge.Load() }
func (w *drainWitness) bytes() []byte {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]byte(nil), w.data...)
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

func startToken(raw []byte) (string, bool) {
	if !utf8.Valid(raw) {
		return "", false
	}
	if len(raw) == 0 {
		return "", true
	}
	// Match legacy Python str.strip's whitespace, including its four ASCII
	// information separators in addition to Unicode White_Space. Empty trimmed
	// output still requires an independent signal0 ESRCH witness.
	token := strings.TrimFunc(string(raw), func(r rune) bool {
		return unicode.IsSpace(r) || (r >= '\u001c' && r <= '\u001f')
	})
	if len(token) > 128 {
		return "", false
	}
	for _, r := range token {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return "", false
		}
	}
	return token, true
}
