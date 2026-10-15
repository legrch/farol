package processprobe

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func TestBoundedDrainDetectsByte4097AndKeepsRealEOF(t *testing.T) {
	for _, n := range []int{streamLimit - 1, streamLimit, streamLimit + 1, 4 * 1024 * 1024} {
		calls := 0
		w := newDrain(func() { calls++ })
		copied, err := w.ReadFrom(strings.NewReader(strings.Repeat("x", n)))
		if err != nil || copied != int64(n) || len(w.bytes()) != min(n, streamLimit) || !w.drained() || cap(w.data) != streamLimit {
			t.Fatalf("n=%d copied=%d stored=%d drained=%v err=%v", n, copied, len(w.bytes()), w.drained(), err)
		}
		if w.exceeded() != (n > streamLimit) || calls != map[bool]int{false: 0, true: 1}[n > streamLimit] {
			t.Fatal("overflow boundary was not one-shot")
		}
		_, _ = w.Write([]byte("more"))
		if n > streamLimit && calls != 1 {
			t.Fatal("repeated overflow callback")
		}
	}
}

type failedReader struct{}

func (failedReader) Read([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestReadFailureAndDuplicateCopierNeverProveEOF(t *testing.T) {
	w := newDrain(nil)
	if _, err := w.ReadFrom(failedReader{}); !errors.Is(err, io.ErrClosedPipe) || w.drained() {
		t.Fatal("read failure became EOF")
	}
	w = newDrain(nil)
	if _, err := w.ReadFrom(strings.NewReader("")); err != nil || !w.drained() {
		t.Fatal("actual empty EOF missing")
	}
	if _, err := w.ReadFrom(strings.NewReader("")); !errors.Is(err, io.ErrClosedPipe) || w.drained() {
		t.Fatal("second copier reused witness")
	}
}
