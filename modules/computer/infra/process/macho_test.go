package process

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func hostMachOFixture(command uint32, name string) []byte {
	minimum := 24
	if command == 0x8000001c {
		minimum = 12
	}
	length := (minimum + len(name) + 1 + 7) &^ 7
	b := make([]byte, 32+length)
	binary.LittleEndian.PutUint32(b, 0xfeedfacf)
	binary.LittleEndian.PutUint32(b[4:], 0x0100000c)
	binary.LittleEndian.PutUint32(b[16:], 1)
	binary.LittleEndian.PutUint32(b[20:], uint32(length))
	binary.LittleEndian.PutUint32(b[32:], command)
	binary.LittleEndian.PutUint32(b[36:], uint32(length))
	binary.LittleEndian.PutUint32(b[40:], uint32(minimum))
	copy(b[32+minimum:], name)
	return b
}
func TestHostMachOBoundedImports(t *testing.T) {
	for _, command := range []uint32{0xc, 0x80000018, 0x8000001f, 0x80000023, 0x20, 0x8000001c} {
		b := hostMachOFixture(command, "@loader_path/../lib/libfixture.dylib")
		r, err := hostMachOImportsAt(bytes.NewReader(b), int64(len(b)))
		if err != nil {
			t.Fatal(err)
		}
		if command == 0x8000001c {
			if len(r.rpaths) != 1 || len(r.libraries) != 0 {
				t.Fatal(r)
			}
		} else {
			if len(r.libraries) != 1 || len(r.rpaths) != 0 {
				t.Fatal(r)
			}
		}
	}
}
func TestHostMachORejectsMalformedMetadata(t *testing.T) {
	for name, modify := range map[string]func([]byte){
		"architecture":   func(b []byte) { binary.LittleEndian.PutUint32(b[4:], 0x01000007) },
		"commands":       func(b []byte) { binary.LittleEndian.PutUint32(b[16:], 8193) },
		"size":           func(b []byte) { binary.LittleEndian.PutUint32(b[20:], 4<<20+1) },
		"command-length": func(b []byte) { binary.LittleEndian.PutUint32(b[36:], 0xffffffff) },
		"name-offset":    func(b []byte) { binary.LittleEndian.PutUint32(b[40:], 4) },
		"nul": func(b []byte) {
			for i := 56; i < len(b); i++ {
				b[i] = 'x'
			}
		},
		"control":     func(b []byte) { b[56] = '\n' },
		"extra-bytes": func(b []byte) { binary.LittleEndian.PutUint32(b[16:], 0) },
	} {
		t.Run(name, func(t *testing.T) {
			b := hostMachOFixture(0xc, "/test.dylib")
			modify(b)
			if _, err := hostMachOImportsAt(bytes.NewReader(b), int64(len(b))); err == nil {
				t.Fatal("malformed input accepted")
			}
		})
	}
}
func TestHostMachOUniversalNativeSlice(t *testing.T) {
	thin := hostMachOFixture(0xc, "/usr/lib/libSystem.B.dylib")
	b := make([]byte, 64+len(thin))
	binary.BigEndian.PutUint32(b, 0xcafebabe)
	binary.BigEndian.PutUint32(b[4:], 1)
	binary.BigEndian.PutUint32(b[8:], 0x0100000c)
	binary.BigEndian.PutUint32(b[16:], 64)
	binary.BigEndian.PutUint32(b[20:], uint32(len(thin)))
	copy(b[64:], thin)
	if r, err := hostMachOImportsAt(bytes.NewReader(b), int64(len(b))); err != nil || len(r.libraries) != 1 {
		t.Fatalf("slice refused: %v", err)
	}
	binary.BigEndian.PutUint32(b[20:], uint32(len(b)))
	if _, err := hostMachOImportsAt(bytes.NewReader(b), int64(len(b))); err == nil {
		t.Fatal("out of bounds slice accepted")
	}
}
func FuzzHostMachOLoadCommands(f *testing.F) {
	f.Add(hostMachOFixture(0xc, "@rpath/fixture.dylib"))
	f.Add([]byte("not an executable"))
	f.Fuzz(func(t *testing.T, b []byte) {
		if len(b) > 5<<20 {
			t.Skip()
		}
		_, _ = hostMachOImportsAt(bytes.NewReader(b), int64(len(b)))
	})
}
