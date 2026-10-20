package git

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestPacketBounds(t *testing.T) {
	for _, bad := range []string{"", "0", "000", "zzzz", "0001", "0002", "0003", "ffff", "0005", "0008abc"} {
		t.Run(bad, func(t *testing.T) {
			if _, _, err := readPacket(strings.NewReader(bad)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	for _, n := range []int{0, 1, 32, maxPacket - 4} {
		wire, err := packet(bytes.Repeat([]byte{'x'}, n))
		if err != nil {
			t.Fatal(err)
		}
		b, flush, err := readPacket(bytes.NewReader(wire))
		if err != nil || flush || len(b) != n {
			t.Fatal(len(b), flush, err)
		}
	}
	if _, err := packet(make([]byte, maxPacket)); err == nil {
		t.Fatal("oversize")
	}
	if b, f, e := readPacket(strings.NewReader("0000")); e != nil || !f || b != nil {
		t.Fatal(b, f, e)
	}
}

type shortWriter struct {
	n    int
	zero bool
}

func (s *shortWriter) Write(b []byte) (int, error) {
	if s.zero {
		return 0, nil
	}
	if len(b) > s.n {
		return s.n, nil
	}
	return len(b), nil
}
func TestShortWrite(t *testing.T) {
	if n, e := writeAll(&shortWriter{n: 1}, []byte("abc")); n != 3 || e != nil {
		t.Fatal(n, e)
	}
	if _, e := writeAll(&shortWriter{zero: true}, []byte("abc")); !errors.Is(e, io.ErrShortWrite) {
		t.Fatal(e)
	}
}
func FuzzPacket(f *testing.F) {
	for _, s := range []string{"0000", "0001", "0008abcd", "ffff"} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > maxPacket+10 {
			t.Skip()
		}
		_, _, _ = readPacket(bytes.NewReader(b))
	})
}
func FuzzDelta(f *testing.F) {
	f.Add([]byte("abc"), []byte{3, 4, 3, 'a', 'b', 'c', 1, 'd'})
	f.Add([]byte{}, []byte{0, 0})
	f.Fuzz(func(t *testing.T, base, delta []byte) {
		if len(base) > 65536 || len(delta) > 65536 {
			t.Skip()
		}
		out, err := applyDelta(base, delta, 65536)
		if err == nil && len(out) > 65536 {
			t.Fatal("limit")
		}
	})
}
