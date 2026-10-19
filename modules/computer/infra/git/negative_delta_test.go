package git

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

func varint(n int) []byte {
	out := []byte{}
	for {
		b := byte(n & 127)
		n >>= 7
		if n != 0 {
			b |= 128
		}
		out = append(out, b)
		if n == 0 {
			return out
		}
	}
}

func TestApplyDeltaRefusalsAreClassified(t *testing.T) {
	base := []byte("abc")
	cases := []struct {
		name  string
		delta []byte
		max   int64
		want  error
	}{
		{"empty delta", nil, 16, ErrProtocol},
		{"source size truncated", []byte{0x83}, 16, ErrProtocol},
		{"target size truncated", []byte{3, 0x84}, 16, ErrProtocol},
		{"source size disagrees with the base", []byte{2, 0}, 16, ErrSource},
		{"target over the object bound", []byte{3, 17}, 16, ErrLimit},
		{"size varint overflows", bytes.Repeat([]byte{0xff}, 11), 16, ErrLimit},
		{"target varint overflows", append([]byte{3}, bytes.Repeat([]byte{0xff}, 11)...), 16, ErrLimit},
		// The true size is 2^65: silently dropping the overflowing bits would
		// yield an empty target and let a hostile delta pass as a valid one.
		{"target varint wraps to zero", append(append([]byte{3}, bytes.Repeat([]byte{0x80}, 9)...), 2), 16, ErrLimit},
		{"target varint tenth byte too large", append(append([]byte{3}, bytes.Repeat([]byte{0xff}, 9)...), 2), 16, ErrLimit},
		{"reserved opcode", []byte{3, 4, 0}, 16, ErrProtocol},
		{"insert longer than the delta", []byte{3, 4, 4, 'x'}, 16, ErrProtocol},
		{"insert longer than the target", []byte{3, 1, 2, 'x', 'y'}, 16, ErrProtocol},
		{"copy operand truncated", []byte{3, 1, 0x91, 3}, 16, ErrProtocol},
		{"copy offset past the base", []byte{3, 1, 0x91, 4, 1}, 16, ErrProtocol},
		{"copy size past the base", []byte{3, 4, 0x90, 4}, 16, ErrProtocol},
		{"copy past the declared target", []byte{3, 1, 0x90, 2}, 16, ErrProtocol},
		{"implicit 64 KiB copy from a short base", []byte{3, 1, 0x80}, 16, ErrProtocol},
		{"instructions end before the target is complete", []byte{3, 4}, 16, ErrProtocol},
		{"partial target", []byte{3, 4, 1, 'x'}, 16, ErrProtocol},
		{"nothing inserted beyond", []byte{3, 0, 1, 'x'}, 16, ErrProtocol},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := applyDelta(base, tc.delta, tc.max)
			if out != nil {
				t.Fatalf("returned bytes %q with %v", out, err)
			}
			wantIs(t, err, tc.want)
		})
	}
}

func TestApplyDeltaBoundaries(t *testing.T) {
	// The target bound is inclusive: 16 bytes under a bound of 16, not 15.
	insert16 := append([]byte{3, 16, 16}, bytes.Repeat([]byte{'x'}, 16)...)
	out, err := applyDelta([]byte("abc"), insert16, 16)
	if err != nil || len(out) != 16 {
		t.Fatal(len(out), err)
	}
	if _, err = applyDelta([]byte("abc"), insert16, 15); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
	// Multi-byte copy operands: offset 300 (two bytes) and size 260 (two bytes).
	big := make([]byte, 600)
	for i := range big {
		big[i] = byte(i * 7)
	}
	delta := append(append(varint(600), varint(260)...), 0x80|1|2|0x10|0x20, 0x2c, 0x01, 0x04, 0x01)
	got, err := applyDelta(big, delta, 1<<20)
	if err != nil || !bytes.Equal(got, big[300:560]) {
		t.Fatal(err)
	}
	// Absent size operand means 64 KiB.
	large := make([]byte, 70000)
	for i := range large {
		large[i] = byte(i)
	}
	got, err = applyDelta(large, append(append(varint(70000), varint(65536)...), 0x80), 1<<20)
	if err != nil || !bytes.Equal(got, large[:65536]) {
		t.Fatal(err)
	}
}

func TestDeltaOperandBytesCarryTheirDocumentedWeight(t *testing.T) {
	base := make([]byte, 1<<24+8)
	for i := range base {
		base[i] = byte(i % 251)
	}
	// offset bytes: 1<<24 + 3 across four operand bytes; size 5 in the first size byte.
	offset := 1<<24 + 3
	delta := append(append(varint(len(base)), varint(5)...), 0x80|0x0f|0x10, byte(offset), byte(offset>>8), byte(offset>>16), byte(offset>>24), 5)
	got, err := applyDelta(base, delta, 1<<20)
	if err != nil || !bytes.Equal(got, base[offset:offset+5]) {
		t.Fatal(err)
	}
	// Size bytes 1 and 2 (bits 5 and 6): size = 0x020100 would exceed the target.
	delta = append(append(varint(len(base)), varint(5)...), 0x80|0x10|0x20|0x40, 0, 1, 2)
	if _, err = applyDelta(base, delta, 1<<20); err == nil {
		t.Fatal("size operand weight ignored")
	}
}

// ---- remaining graph and known-object properties ----------------------------

// A complete DAG makes every commit name every earlier one. Each commit is
// individually plausible, yet the walk's total edge work is not.
func TestAncestryWalkEdgeBudgetBoundsAHostileKnownHistory(t *testing.T) {
	build := func(t *testing.T, objects int) (egress.Intent, memoryObjects, []byte) {
		in, known, _ := packFixture(t, "sha1")
		in.Known, in.Objects = nil, nil
		for k := range known {
			delete(known, k)
		}
		tr := &object{kind: "tree"} // the empty tree
		trID := addKnown(&in, known, tr)
		var ids []string
		for i := 0; i < 29; i++ {
			header := "tree " + trID
			for _, p := range ids {
				header += "\nparent " + p
			}
			c := opaqueCommit(header + fmt.Sprintf("\nauthor n%d", i))
			ids = append(ids, addKnown(&in, known, c))
		}
		header := "tree " + trID
		for _, p := range ids {
			header += "\nparent " + p
		}
		head := opaqueCommit(header)
		in.Base = ids[0]
		in.Old = "0000000000000000000000000000000000000000"
		in = setObjects(in, "sha1", head, []*object{head})
		in.Limits.Objects = objects
		return in, known, makePack(t, "sha1", []*object{head})
	}
	// 29 history commits + tree + head = 31 manifest entries.
	in, known, wire := build(t, 31)
	_, err := readWire(t, in, known, wire)
	wantIs(t, err, ErrLimit)
	// With room for the same history, the identical bytes are accepted.
	in, known, wire = build(t, 64)
	if _, err = readWire(t, in, known, wire); err != nil {
		t.Fatal(err)
	}
}

// A known commit the walk must expand may not smuggle in a parent that was
// never declared.
func TestAncestryWalkRefusesAnUndeclaredParentOfAKnownCommit(t *testing.T) {
	_, err := runGraph(t, func(_ *testing.T, in *egress.Intent, known memoryObjects, _ []*object) (*object, []*object) {
		root := in.Known[1].OID
		middle := addKnown(in, known, opaqueCommit("tree "+root+"\nparent "+in.Base+"\nparent "+fakeOID(5)))
		head := opaqueCommit("tree " + root + "\nparent " + middle)
		return head, []*object{head}
	})
	wantIs(t, err, ErrSource)
}

type countingObjects struct {
	inner memoryObjects
	reads map[string]int
}

func (c *countingObjects) ReadObject(ctx context.Context, id string) (string, []byte, error) {
	c.reads[id]++
	return c.inner.ReadObject(ctx, id)
}

// A thin delta against the baseline commit and the later ancestry check both
// need the same known object; it is read, authenticated and charged once.
func TestKnownObjectIsReadAndChargedOnce(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	base := known[in.Base]
	d := literalDelta(base.data, objects[0].data)
	baseID, _ := hex.DecodeString(in.Base)
	wire := rawPack("sha1", 2, 3, entry(t, 7, uint64(len(d)), baseID, d), fullEntry(t, objects[1]), fullEntry(t, objects[2]))
	counter := &countingObjects{inner: known, reads: map[string]int{}}
	p, err := readPack(context.Background(), bytes.NewReader(wire), mustPlan(t, in), counter)
	if err != nil {
		t.Fatal(err)
	}
	if counter.reads[in.Base] != 1 || len(counter.reads) != 1 {
		t.Fatalf("reads %v", counter.reads)
	}
	// declared entry sizes + the delta's output + the single authenticated read
	if want := int64(len(d) + len(objects[1].data) + len(objects[2].data) + len(objects[0].data) + len(base.data)); p.source.expanded != want {
		t.Fatalf("charged %d; want %d", p.source.expanded, want)
	}
}

// cancelAtEnd cancels the context as the final pack byte is delivered.
type cancelAtEnd struct {
	r      *bytes.Reader
	cancel context.CancelFunc
}

func (c *cancelAtEnd) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if c.r.Len() == 0 {
		c.cancel()
	}
	return n, err
}

func TestContextEndingAfterThePackDoesNotReachTheObjectOwner(t *testing.T) {
	t.Run("empty update of a known head", func(t *testing.T) {
		in, known, _ := packFixture(t, "sha1")
		in.Head, in.Objects = in.Base, nil
		ctx, cancel := context.WithCancel(context.Background())
		counter := &countingObjects{inner: known, reads: map[string]int{}}
		_, err := readPack(ctx, &cancelAtEnd{bytes.NewReader(makePack(t, "sha1", nil)), cancel}, mustPlan(t, in), counter)
		wantIs(t, err, context.Canceled)
		if len(counter.reads) != 0 {
			t.Fatalf("the owner was asked after cancellation: %v", counter.reads)
		}
	})
	t.Run("pack with objects", func(t *testing.T) {
		in, known, objects := packFixture(t, "sha1")
		ctx, cancel := context.WithCancel(context.Background())
		counter := &countingObjects{inner: known, reads: map[string]int{}}
		_, err := readPack(ctx, &cancelAtEnd{bytes.NewReader(makePack(t, "sha1", objects)), cancel}, mustPlan(t, in), counter)
		wantIs(t, err, context.Canceled)
		if len(counter.reads) != 0 {
			t.Fatalf("the owner was asked after cancellation: %v", counter.reads)
		}
	})
}
