package limit

import (
	"bytes"
	"errors"
	"io"
	"math"
	"strings"
	"testing"
	"testing/iotest"
)

// counting reports how many bytes were taken from it.
type counting struct{ taken int64 }

func (c *counting) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	c.taken += int64(len(p))
	return len(p), nil
}

func TestRead(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		maximum int64
		want    string
		err     error
	}{
		{"empty within zero", "", 0, "", nil},
		{"one byte over zero", "a", 0, "", ErrTooLarge},
		{"exact", "abcd", 4, "abcd", nil},
		{"one short of bound", "abc", 4, "abc", nil},
		{"one over bound", "abcde", 4, "", ErrTooLarge},
		{"far over bound", strings.Repeat("a", 1000), 4, "", ErrTooLarge},
		{"empty within bound", "", 4, "", nil},
		{"negative with bytes", "a", -5, "", ErrTooLarge},
		{"negative empty", "", -5, "", nil},
		{"maximum int64", "abc", math.MaxInt64, "abc", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Read(strings.NewReader(c.in), c.maximum)
			if !errors.Is(err, c.err) || string(got) != c.want {
				t.Fatalf("Read(%q, %d) = %q, %v; want %q, %v", c.in, c.maximum, got, err, c.want, c.err)
			}
		})
	}
}

// TestReadMatchesInlineIdiom pins the replaced idiom: ReadAll over a reader
// limited to maximum+1, then a length check.
func TestReadMatchesInlineIdiom(t *testing.T) {
	for _, size := range []int{0, 1, 2, 63, 64, 65, 4096} {
		for _, maximum := range []int64{0, 1, 63, 64, 4096} {
			raw := bytes.Repeat([]byte{'z'}, size)
			old, oldErr := io.ReadAll(io.LimitReader(bytes.NewReader(raw), maximum+1))
			oldOK := oldErr == nil && int64(len(old)) <= maximum
			got, err := Read(bytes.NewReader(raw), maximum)
			if (err == nil) != oldOK || (oldOK && !bytes.Equal(got, old)) {
				t.Fatalf("size %d maximum %d: Read = %d bytes, %v; inline = %d bytes ok=%v", size, maximum, len(got), err, len(old), oldOK)
			}
		}
	}
}

func TestReadStopsOneByteAfterTheBound(t *testing.T) {
	src := &counting{}
	if _, err := Read(src, 10); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	if src.taken != 11 {
		t.Fatalf("took %d bytes, want 11", src.taken)
	}
}

func TestReadReturnsReaderError(t *testing.T) {
	boom := errors.New("boom")
	got, err := Read(io.MultiReader(strings.NewReader("ab"), iotest.ErrReader(boom)), 10)
	if !errors.Is(err, boom) || string(got) != "ab" {
		t.Fatalf("Read = %q, %v; want %q, boom", got, err, "ab")
	}
}
