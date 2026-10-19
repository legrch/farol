package git

import (
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"encoding/hex"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/egress"
)

func ofsDistance(n int) []byte {
	b := []byte{byte(n & 127)}
	for n >>= 7; n > 0; n >>= 7 {
		n--
		b = append([]byte{byte(n&127) | 128}, b...)
	}
	return b
}
func literalDelta(base, target []byte) []byte {
	varint := func(n int) []byte {
		b := []byte{}
		for {
			v := byte(n & 127)
			n >>= 7
			if n != 0 {
				v |= 128
			}
			b = append(b, v)
			if n == 0 {
				return b
			}
		}
	}
	d := append(varint(len(base)), varint(len(target))...)
	for len(target) > 0 {
		n := len(target)
		if n > 127 {
			n = 127
		}
		d = append(d, byte(n))
		d = append(d, target[:n]...)
		target = target[n:]
	}
	return d
}
func TestPackDeltaEncodings(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		for _, kind := range []string{"ofs", "forward ref"} {
			t.Run(format+"/"+kind, func(t *testing.T) {
				in, known, objects := packFixture(t, format)
				baseID := in.Known[2].OID
				base := known[baseID]
				// Both base and target are introduced, HEAD-reachable objects.
				// The REF_DELTA base occurs later in the pack and is NOT readable
				// through Known: this actually exercises the resolution pass.
				baseBytes, _ := hex.DecodeString(baseID)
				targetBytes, _ := hex.DecodeString(objID(format, objects[2]))
				tr := &object{kind: "tree", data: append(append(append([]byte("100644 base.txt\x00"), baseBytes...), []byte("100644 file.txt\x00")...), targetBytes...)}
				head := commit(format, objID(format, tr), in.Base)
				objects = []*object{head, tr, objects[2], base}
				in.Head = objID(format, head)
				in.Objects = nil
				for _, v := range objects {
					in.Objects = append(in.Objects, meta(format, v))
				}
				in.Known = in.Known[:2]
				delete(known, baseID)
				b := &bytes.Buffer{}
				b.WriteString("PACK")
				_ = binary.Write(b, binary.BigEndian, uint32(2))
				_ = binary.Write(b, binary.BigEndian, uint32(4))
				encode := func(typ byte, data []byte, extra []byte) {
					writeObjectHeader(b, typ, len(data))
					b.Write(extra)
					z := zlib.NewWriter(b)
					_, _ = z.Write(data)
					if e := z.Close(); e != nil {
						t.Fatal(e)
					}
				}
				encode(1, objects[0].data, nil)
				encode(2, objects[1].data, nil)
				d := literalDelta(base.data, objects[2].data)
				if kind == "ofs" {
					start := b.Len()
					encode(3, base.data, nil)
					distance := b.Len() - start
					encode(6, d, ofsDistance(distance))
				} else {
					id, _ := hex.DecodeString(baseID)
					encode(7, d, id)
					encode(3, base.data, nil)
				}
				plan, e := egress.NewPlan(in)
				if e != nil {
					t.Fatal(e)
				}
				p, e := readPack(context.Background(), bytes.NewReader(finishPack(format, b.Bytes())), plan, known)
				if e != nil {
					t.Fatal(e)
				}
				out, n, e := p.canonical()
				if e != nil || n != 4 {
					t.Fatal(n, e)
				}
				if _, e = readPack(context.Background(), bytes.NewReader(out), plan, known); e != nil {
					t.Fatal(e)
				}
			})
		}
	}
}
