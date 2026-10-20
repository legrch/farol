package git

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

func TestPackRoundtrip(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			in, known, objects := packFixture(t, format)
			p, err := egress.NewPlan(in)
			if err != nil {
				t.Fatal(err)
			}
			wire := makePack(t, format, objects)
			got, err := readPack(context.Background(), bytes.NewReader(wire), p, known)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.bytes, wire) || len(got.objects) != 3 {
				t.Fatal("pack changed")
			}
		})
	}
}
func TestPackRefuses(t *testing.T) {
	cases := []string{"checksum", "truncated", "magic", "version", "count", "object limit", "pack limit", "expansion limit", "wrong strong hash", "unapproved object", "missing tree", "not based on task", "non fast forward", "extra unreachable", "duplicate object", "tag object"}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			in, known, objects := packFixture(t, "sha1")
			wire := makePack(t, in.Format, objects)
			switch name {
			case "checksum":
				wire[len(wire)-1] ^= 1
			case "truncated":
				wire = wire[:len(wire)-1]
			case "magic":
				wire[0] = 'X'
			case "version":
				wire[7] = 4
			case "count":
				binary.BigEndian.PutUint32(wire[8:12], 65537)
			case "object limit":
				in.Limits.ObjectBytes = 150
				for i := range in.Objects {
					if in.Objects[i].Size > 150 {
						in.Objects[i].Size = 150
					}
				}
				for i := range in.Known {
					if in.Known[i].Size > 150 {
						in.Known[i].Size = 150
					}
				}
			case "pack limit":
				in.Limits.PackBytes = 64
			case "expansion limit":
				in.Limits.ExpandedBytes = 250
				in.Limits.ObjectBytes = 250
			case "wrong strong hash":
				in.Objects[0].Digest = strings.Repeat("f", 64)
			case "unapproved object":
				extra := &object{kind: "blob", data: []byte("secret bytes not in source")}
				wire = makePack(t, in.Format, append(objects, extra))
			case "missing tree":
				wire = makePack(t, in.Format, []*object{objects[0], objects[2]})
			case "not based on task":
				other := commit(in.Format, objID(in.Format, objects[1]))
				in.Base = objID(in.Format, other)
				in.Known = append(in.Known, meta(in.Format, other))
				known[in.Base] = other
			case "non fast forward":
				other := commit(in.Format, objID(in.Format, objects[1]))
				in.Old = objID(in.Format, other)
				in.Known = append(in.Known, meta(in.Format, other))
				known[in.Old] = other
			case "extra unreachable":
				extra := &object{kind: "blob", data: []byte("allowed but not head reachable")}
				in.Objects = append(in.Objects, meta(in.Format, extra))
				wire = makePack(t, in.Format, append(objects, extra))
			case "duplicate object":
				wire = makePack(t, in.Format, append(objects, objects[2]))
			case "tag object":
				wire = makePack(t, in.Format, append(objects, &object{kind: "tag", data: []byte("unrequested tag")}))
			}
			p, err := egress.NewPlan(in)
			if err != nil {
				t.Fatal("test plan", err)
			}
			if _, err = readPack(context.Background(), bytes.NewReader(wire), p, known); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}
func TestDeltaBounds(t *testing.T) {
	good := []byte{3, 4, 0x90, 3, 1, 'd'}
	if b, e := applyDelta([]byte("abc"), good, 16); e != nil || string(b) != "abcd" {
		t.Fatal(string(b), e)
	}
	for _, bad := range [][]byte{{}, {3}, {2, 0}, {3, 4, 0}, {3, 4, 4, 'x'}, {3, 1, 0x91, 3, 1}, {3, 1, 0x90, 2}, {3, 2, 0x80}, {3, 1, 0x81}, {3, 1, 1, 'x', 1, 'y'}, {3, 127, 1, 'x'}, bytes.Repeat([]byte{255}, 11)} {
		if b, e := applyDelta([]byte("abc"), bad, 16); e == nil {
			t.Fatalf("accepted %x -> %x", bad, b)
		}
	}
}
func TestThinRefDelta(t *testing.T) {
	in, known, objects := packFixture(t, "sha1")
	base := known[in.Known[2].OID]
	target := objects[2]
	delta := append([]byte{byte(len(base.data)), byte(len(target.data)), byte(len(target.data))}, target.data...)
	b := &bytes.Buffer{}
	b.WriteString("PACK")
	_ = binary.Write(b, binary.BigEndian, uint32(2))
	_ = binary.Write(b, binary.BigEndian, uint32(3))
	for _, v := range objects[:2] {
		typ := byte(1)
		if v.kind == "tree" {
			typ = 2
		}
		writeObjectHeader(b, typ, len(v.data))
		z := zlib.NewWriter(b)
		_, _ = z.Write(v.data)
		_ = z.Close()
	}
	writeObjectHeader(b, 7, len(delta))
	id, _ := hex.DecodeString(in.Known[2].OID)
	b.Write(id)
	z := zlib.NewWriter(b)
	_, _ = z.Write(delta)
	_ = z.Close()
	p, _ := egress.NewPlan(in)
	wire := finishPack(in.Format, b.Bytes())
	if _, e := readPack(context.Background(), bytes.NewReader(wire), p, known); e != nil {
		t.Fatal(e)
	}
	if _, e := readPack(context.Background(), bytes.NewReader(wire), p, nil); e == nil {
		t.Fatal("unauthenticated thin base")
	}
	known[in.Known[2].OID] = &object{kind: "blob", data: []byte("wrong base")}
	if _, e := readPack(context.Background(), bytes.NewReader(wire), p, known); e == nil {
		t.Fatal("changed base")
	}
}
func FuzzPack(f *testing.F) {
	f.Add([]byte("PACK\x00\x00\x00\x02\x00\x00\x00\x01"))
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > 65536 {
			t.Skip()
		}
		in, k, _ := packFixture(t, "sha1")
		in.Limits.PackBytes = 65536
		in.Limits.ObjectBytes = 4096
		in.Limits.ExpandedBytes = 65536
		in.Limits.Objects = 64
		p, _ := egress.NewPlan(in)
		_, _ = readPack(context.Background(), bytes.NewReader(b), p, k)
	})
}
