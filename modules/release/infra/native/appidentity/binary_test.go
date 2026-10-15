package appidentity

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

// Hand-built adversarial vectors complement the independent plistlib fixtures.
func binaryDoc(objects [][]byte, top uint64) []byte {
	raw := []byte("bplist00")
	offsets := make([]uint32, len(objects))
	for i, obj := range objects {
		offsets[i] = uint32(len(raw))
		raw = append(raw, obj...)
	}
	table := uint64(len(raw))
	for _, offset := range offsets {
		raw = binary.BigEndian.AppendUint32(raw, offset)
	}
	raw = append(raw, 0, 0, 0, 0, 0, 0, 4, 2)
	raw = binary.BigEndian.AppendUint64(raw, uint64(len(objects)))
	raw = binary.BigEndian.AppendUint64(raw, top)
	return binary.BigEndian.AppendUint64(raw, table)
}
func binString(s string) []byte {
	if len(s) < 15 {
		return append([]byte{0x50 | byte(len(s))}, s...)
	}
	return append([]byte{0x5f, 0x11, byte(len(s) >> 8), byte(len(s))}, s...)
}
func binRefs(marker byte, ids ...int) []byte {
	raw := []byte{marker}
	for _, id := range ids {
		raw = binary.BigEndian.AppendUint16(raw, uint16(id))
	}
	return raw
}
func validObjects(extra []byte) [][]byte {
	return [][]byte{binRefs(0xd3, 1, 2, 5, 3, 4, 6), binString("CFBundleIdentifier"), binString("CFBundleShortVersionString"), binString(bundle), binString("1.2.3"), binString("extra"), extra}
}
func TestBinaryScalarAndCollectionVectors(t *testing.T) {
	values := [][]byte{{0}, {8}, {9}, {0x10, 255}, {0x11, 1, 0}, {0x12, 0, 1, 0, 0}, {0x13, 255, 255, 255, 255, 255, 255, 255, 255}, {0x14, 0, 0, 0, 0, 0, 0, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0}, {0x22, 0x3f, 0x80, 0, 0}, {0x23, 0x3f, 0xf0, 0, 0, 0, 0, 0, 0}, {0x33, 0, 0, 0, 0, 0, 0, 0, 0}, {0x42, 0, 255}, {0x60}, {0x62, 0xd8, 0x3d, 0xde, 0}, {0x80, 1}, {0x87, 255, 255, 255, 255, 255, 255, 255, 255}, {0xa0}, {0xd0}}
	for _, v := range values {
		if e := Verify(context.Background(), binaryDoc(validObjects(v), 0), jsonDoc(""), testVersion, testID); e != nil {
			t.Fatalf("%x: %v", v, e)
		}
	}
	objects := validObjects(binRefs(0xa2, 3, 4))
	if e := Verify(context.Background(), binaryDoc(objects, 0), jsonDoc(""), testVersion, testID); e != nil {
		t.Fatal(e)
	}
	// The binary format may share child objects; this is not a cycle.
	objects = validObjects(binRefs(0xa2, 7, 7))
	objects = append(objects, []byte{0x09})
	if e := Verify(context.Background(), binaryDoc(objects, 0), jsonDoc(""), testVersion, testID); e != nil {
		t.Fatal(e)
	}
}
func TestBinaryIdentityTypes(t *testing.T) {
	for _, v := range [][]byte{{0xa0}, {0xd0}, {0}, {8}, {0x10, 1}} {
		objects := validObjects([]byte{9})
		objects[3] = v
		wantCode(t, Verify(context.Background(), binaryDoc(objects, 0), jsonDoc(""), testVersion, testID), BundleMismatch)
	}
	wantCode(t, Verify(context.Background(), binaryDoc([][]byte{{0xa0}}, 0), jsonDoc(""), testVersion, testID), InvalidPlist)
}
func TestBinaryHostileObjects(t *testing.T) {
	values := [][]byte{{0xf}, {0x70}, {0xb0}, {0xc0}, {0x15}, {0x20}, {0x24}, {0x30}, {0x32, 0, 0, 0, 0}, {0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0}, {0x51, 255}, {0x61, 0xd8, 0}, {0x61, 0xdc, 0}, {0x62, 0xd8, 0, 0, 65}, {0x4f}, {0x4f, 0x50}, {0x4f, 0x14}, {0x42, 0}, {0x5f, 0x10, 2, 'a'}, {0xa1, 0, 99}, {0xd1, 0, 3, 0, 99}, {0x23, 0x7f, 0xf0, 0, 0, 0, 0, 0, 0}, {0x22, 0x7f, 0xc0, 0, 0}, {0x33, 0x7f, 0xf0, 0, 0, 0, 0, 0, 0}, {0x15, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}}
	date := []byte{0x33}
	date = binary.BigEndian.AppendUint64(date, math.Float64bits(252423993600))
	values = append(values, date)
	for _, v := range values {
		wantCode(t, Verify(context.Background(), binaryDoc(validObjects(v), 0), jsonDoc(""), testVersion, testID), InvalidPlist)
	}
	for _, obj := range [][][]byte{
		validObjects(binRefs(0xa1, 6)),                                    // direct cycle
		append(validObjects(binRefs(0xa1, 7)), binRefs(0xa1, 6)),          // indirect cycle
		{binRefs(0xd2, 1, 1, 2, 3), binString("x"), []byte{8}, []byte{9}}, // duplicate key
		{binRefs(0xd1, 1, 2), []byte{8}, []byte{9}},                       // non-string key
		append(validObjects([]byte{8}), []byte{0xff}),                     // hostile unreachable object
	} {
		wantCode(t, Verify(context.Background(), binaryDoc(obj, 0), jsonDoc(""), testVersion, testID), InvalidPlist)
	}
}
func TestBinaryTrailerAndOffsets(t *testing.T) {
	valid := binaryDoc(validObjects([]byte{8}), 0)
	mutations := []func([]byte){
		func(r []byte) { r[len(r)-32] = 1 }, func(r []byte) { r[len(r)-26] = 3 }, func(r []byte) { r[len(r)-25] = 0 },
		func(r []byte) { binary.BigEndian.PutUint64(r[len(r)-24:], 0) }, func(r []byte) { binary.BigEndian.PutUint64(r[len(r)-24:], math.MaxUint64) },
		func(r []byte) { binary.BigEndian.PutUint64(r[len(r)-16:], 99) }, func(r []byte) { binary.BigEndian.PutUint64(r[len(r)-8:], 7) },
		func(r []byte) { binary.BigEndian.PutUint64(r[len(r)-8:], math.MaxUint64) },
		func(r []byte) {
			table := int(binary.BigEndian.Uint64(r[len(r)-8:]))
			binary.BigEndian.PutUint32(r[table:], 7)
		},
		func(r []byte) {
			table := int(binary.BigEndian.Uint64(r[len(r)-8:]))
			binary.BigEndian.PutUint32(r[table+4:], 8)
		}, // duplicate
		func(r []byte) {
			table := int(binary.BigEndian.Uint64(r[len(r)-8:]))
			binary.BigEndian.PutUint32(r[table+4:], 9)
		}, // overlap
	}
	for _, mutate := range mutations {
		raw := bytes.Clone(valid)
		mutate(raw)
		wantCode(t, Verify(context.Background(), raw, jsonDoc(""), testVersion, testID), InvalidPlist)
	}
	for n := 0; n < len(valid); n++ {
		if e := Verify(context.Background(), valid[:n], jsonDoc(""), testVersion, testID); e == nil {
			t.Fatalf("accepted truncated length %d", n)
		}
	}
}
func TestBinaryDepthAndBudgets(t *testing.T) {
	for _, depth := range []int{127, 128} {
		objects := validObjects([]byte{9})
		for i := 0; i < depth; i++ {
			objects = append(objects, binRefs(0xa1, len(objects)-1))
		}
		objects[0] = binRefs(0xd3, 1, 2, 5, 3, 4, len(objects)-1)
		e := Verify(context.Background(), binaryDoc(objects, 0), jsonDoc(""), testVersion, testID)
		if depth == 127 {
			if e != nil {
				t.Fatal(e)
			}
		} else {
			wantCode(t, e, Limit)
		}
	}
	// Small encoded DAG with >65536 edges; repeat references do not bypass budget.
	many := []byte{0xaf, 0x11, 0x03, 0xe8}
	for range 1000 {
		many = binary.BigEndian.AppendUint16(many, 3)
	}
	objects := validObjects(many)
	for range 66 {
		objects = append(objects, bytes.Clone(many))
	}
	_, edgeError := parseBinary(binaryDoc(objects, 0), &budget{ctx: context.Background()})
	wantCode(t, edgeError, Limit)

	// Exercise parser aggregate boundaries with encoded fixtures larger than the
	// public document cap, which Verify independently enforces.
	for _, n := range []int{maxUnits - 2, maxUnits - 1} {
		array := []byte{0xaf, 0x12}
		array = binary.BigEndian.AppendUint32(array, uint32(n))
		for range n {
			array = binary.BigEndian.AppendUint16(array, 1)
		}
		_, e := parseBinary(binaryDoc([][]byte{array, {9}}, 0), &budget{ctx: context.Background()})
		if n == maxUnits-2 {
			if e != nil {
				t.Fatal(e)
			}
		} else {
			wantCode(t, e, Limit)
		}
	}
	for _, n := range []int{maxDecoded, maxDecoded + 1} {
		scalar := []byte{0x5f, 0x12}
		scalar = binary.BigEndian.AppendUint32(scalar, uint32(n))
		scalar = append(scalar, bytes.Repeat([]byte("a"), n)...)
		_, e := parseBinary(binaryDoc([][]byte{scalar}, 0), &budget{ctx: context.Background()})
		if n == maxDecoded {
			if e != nil {
				t.Fatal(e)
			}
		} else {
			wantCode(t, e, Limit)
		}
	}

	// UTF-16 expands in UTF-8. Distinct retained strings breach decoded byte budget
	// in parser-unit evidence (production document-size cap is tested separately).
	payload := []byte{0x6f, 0x11, 0x75, 0x30}
	for range 30000 {
		payload = append(payload, 0x08, 0x00)
	}
	objects = [][]byte{payload}
	for range 12 {
		objects = append(objects, bytes.Clone(payload))
	}
	_, e := parseBinary(binaryDoc(objects, 0), &budget{ctx: context.Background()})
	wantCode(t, e, Limit)
}
func FuzzVerifyNeverPanics(f *testing.F) {
	f.Add(xmlDoc(""), jsonDoc(""))
	f.Add(binaryDoc(validObjects([]byte{9}), 0), jsonDoc(""))
	f.Add([]byte("bplist00"), []byte("{}"))
	f.Fuzz(func(t *testing.T, p, j []byte) {
		err := Verify(context.Background(), p, j, testVersion, testID)
		if err != nil {
			var e *Error
			if !errors.As(err, &e) {
				t.Fatalf("untyped error %v", err)
			}
		}
	})
}
