package git

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

func encodedPack(t *testing.T, format string, objects []*object, level int, version uint32) []byte {
	t.Helper()
	b := &bytes.Buffer{}
	b.WriteString("PACK")
	_ = binary.Write(b, binary.BigEndian, version)
	_ = binary.Write(b, binary.BigEndian, uint32(len(objects)))
	for _, v := range objects {
		typ := map[string]byte{"commit": 1, "tree": 2, "blob": 3}[v.kind]
		writeObjectHeader(b, typ, len(v.data))
		z, err := zlib.NewWriterLevel(b, level)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = z.Write(v.data); err != nil {
			t.Fatal(err)
		}
		if err = z.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return finishPack(format, b.Bytes())
}

func TestCanonicalUploadIgnoresUntrustedRepresentation(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			in, known, objects := packFixture(t, format)
			plan, _ := egress.NewPlan(in)
			wire := makePack(t, format, objects)
			good, err := readPack(context.Background(), bytes.NewReader(wire), plan, known)
			if err != nil {
				t.Fatal(err)
			}
			want, n, err := good.canonical()
			if err != nil || n != 3 {
				t.Fatal(n, err)
			}
			for _, level := range []int{zlib.NoCompression, zlib.BestSpeed, zlib.BestCompression, zlib.HuffmanOnly} {
				// Reversed order, another pack version, another compressor and
				// gratuitous *declared* known objects must not change outgoing bytes.
				changed := []*object{objects[2], objects[1], objects[0], known[in.Known[2].OID]}
				input := encodedPack(t, format, changed, level, 3)
				if bytes.Equal(input, wire) {
					t.Fatal("fixture did not vary representation")
				}
				got, err := readPack(context.Background(), bytes.NewReader(input), plan, known)
				if err != nil {
					t.Fatal(err)
				}
				out, count, err := got.canonical()
				if err != nil || count != 3 || !bytes.Equal(out, want) {
					t.Fatal("non-canonical disclosure", level, count, err)
				}
			}
		})
	}
}

func TestKnownHeadAllowsAuthenticatedEmptyPack(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			in, known, _ := packFixture(t, format)
			in.Head = in.Base
			in.Objects = nil
			plan, err := egress.NewPlan(in)
			if err != nil {
				t.Fatal(err)
			}
			wire := makePack(t, format, nil)
			p, err := readPack(context.Background(), bytes.NewReader(wire), plan, known)
			if err != nil {
				t.Fatal(err)
			}
			out, n, err := p.canonical()
			if err != nil || n != 0 || !bytes.Equal(out, wire) {
				t.Fatal(n, err)
			}
			if _, err = readPack(context.Background(), bytes.NewReader(wire), plan, nil); err == nil {
				t.Fatal("head proof skipped")
			}
		})
	}
}

func TestGraphRequiresMatchingLinkKinds(t *testing.T) {
	for _, name := range []string{"commit tree points to blob", "directory points to blob", "file points to tree", "parent points to blob"} {
		t.Run(name, func(t *testing.T) {
			in, known, objects := packFixture(t, "sha1")
			blob, tr := objects[2], objects[1]
			var head *object
			switch name {
			case "commit tree points to blob":
				head = commit(in.Format, objID(in.Format, blob), in.Base)
				objects = []*object{head, blob}
			case "directory points to blob":
				tr = &object{kind: "tree", data: bytes.Replace(tr.data, []byte("100644 "), []byte("40000 "), 1)}
				head = commit(in.Format, objID(in.Format, tr), in.Base)
				objects = []*object{head, tr, blob}
			case "file points to tree":
				tr = tree(in.Format, objects[1])
				head = commit(in.Format, objID(in.Format, tr), in.Base)
				objects = []*object{head, tr, objects[1], blob}
			case "parent points to blob":
				head = commit(in.Format, objID(in.Format, tr), in.Base, objID(in.Format, blob))
				objects = []*object{head, tr, blob}
			}
			in.Head = objID(in.Format, head)
			in.Objects = nil
			for _, v := range objects {
				in.Objects = append(in.Objects, meta(in.Format, v))
			}
			plan, err := egress.NewPlan(in)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = readPack(context.Background(), bytes.NewReader(makePack(t, in.Format, objects)), plan, known); err == nil {
				t.Fatal("invalid typed graph accepted")
			}
		})
	}
}
