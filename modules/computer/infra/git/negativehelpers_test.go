package git

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

// Helpers for the negative-path suites. They deliberately build malformed
// wire bytes by hand: the production readers must refuse them by a specific,
// classified reason, not merely "somehow fail".

func wantIs(t *testing.T, err, want error) {
	t.Helper()
	if err == nil {
		t.Fatalf("accepted; want %v", want)
	}
	if !errors.Is(err, want) {
		t.Fatalf("got %v; want %v", err, want)
	}
}

func wantCode(t *testing.T, err, want error) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) {
		t.Fatalf("not a classified Failure: %v", err)
	}
	if f.Code() != want.Error() {
		t.Fatalf("code %q; want %q (%v)", f.Code(), want.Error(), err)
	}
}

func join(parts ...[]byte) []byte {
	var b []byte
	for _, p := range parts {
		b = append(b, p...)
	}
	return b
}

// setObjects replaces the introduced-object manifest and head of an intent.
func setObjects(in egress.Intent, format string, head *object, objects []*object) egress.Intent {
	in.Head = objID(format, head)
	in.Objects = nil
	for _, v := range objects {
		in.Objects = append(in.Objects, meta(format, v))
	}
	return in
}

func mustPlan(t *testing.T, in egress.Intent) *egress.Plan {
	t.Helper()
	plan, err := egress.NewPlan(in)
	if err != nil {
		t.Fatal("test plan:", err)
	}
	return plan
}

func readWire(t *testing.T, in egress.Intent, known memoryObjects, wire []byte) (*verifiedPack, error) {
	t.Helper()
	return readPack(context.Background(), bytes.NewReader(wire), mustPlan(t, in), known)
}

func deflate(t *testing.T, data []byte) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zlib.NewWriter(&b)
	if _, err := z.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// entryHeader encodes a pack object header with an arbitrary declared size.
func entryHeader(typ byte, size uint64) []byte {
	b := byte(size&15) | typ<<4
	size >>= 4
	out := []byte{}
	if size > 0 {
		b |= 128
	}
	out = append(out, b)
	for size > 0 {
		next := byte(size & 127)
		size >>= 7
		if size > 0 {
			next |= 128
		}
		out = append(out, next)
	}
	return out
}

// entry is one pack entry whose declared size need not match its payload.
func entry(t *testing.T, typ byte, declared uint64, extra, payload []byte) []byte {
	t.Helper()
	return join(entryHeader(typ, declared), extra, deflate(t, payload))
}

func fullEntry(t *testing.T, v *object) []byte {
	t.Helper()
	typ := map[string]byte{"commit": 1, "tree": 2, "blob": 3}[v.kind]
	return entry(t, typ, uint64(len(v.data)), nil, v.data)
}

// rawPack assembles a pack with a correct trailer over arbitrary entry bytes.
func rawPack(format string, version, count uint32, entries ...[]byte) []byte {
	b := &bytes.Buffer{}
	b.WriteString("PACK")
	_ = binary.Write(b, binary.BigEndian, version)
	_ = binary.Write(b, binary.BigEndian, count)
	for _, e := range entries {
		b.Write(e)
	}
	return finishPack(format, b.Bytes())
}

// opaqueCommit builds a commit from an exact header string so tests can express
// malformed or unusual headers.
func opaqueCommit(header string) *object {
	return &object{kind: "commit", data: []byte(header + "\n\nmessage\n")}
}
