package observation

import (
	"encoding/binary"
	"testing"
)

func volumePacket() []byte {
	b := make([]byte, volumeBytes)
	binary.LittleEndian.PutUint32(b, uint32(len(b)))
	binary.LittleEndian.PutUint32(b[4:], attrReturned)
	binary.LittleEndian.PutUint32(b[8:], attrVolumeInfo|attrCapabilities|attrVolumeUUID)
	binary.LittleEndian.PutUint32(b[24:], capPersistentIDs|cap64BitIDs)
	binary.LittleEndian.PutUint32(b[40:], capPersistentIDs|cap64BitIDs)
	for i := 56; i < 72; i++ {
		b[i] = byte(i)
	}
	return b
}
func objectPacket(f fileIdentity) []byte {
	b := make([]byte, objectBytes)
	binary.LittleEndian.PutUint32(b, uint32(len(b)))
	binary.LittleEndian.PutUint32(b[4:], attrReturned|attrDevice|attrBirth|attrFileID)
	binary.LittleEndian.PutUint32(b[24:], uint32(f.Device))
	binary.LittleEndian.PutUint64(b[28:], uint64(f.BirthSeconds))
	binary.LittleEndian.PutUint64(b[36:], uint64(f.BirthNanoseconds))
	binary.LittleEndian.PutUint64(b[44:], f.Inode)
	return b
}
func TestVolumePacketRejectsUnsupportedAndMalformedFields(t *testing.T) {
	good := volumePacket()
	uuid, err := decodeVolume(good)
	if err != nil || uuid != "38393a3b-3c3d-3e3f-4041-424344454647" {
		t.Fatalf("%s %v", uuid, err)
	}
	tests := []struct {
		name   string
		change func([]byte) []byte
	}{
		{"short", func(b []byte) []byte { return b[:71] }}, {"extra", func(b []byte) []byte { return append(b, 0) }},
		{"kernel reported missing bytes", func(b []byte) []byte { binary.LittleEndian.PutUint32(b, 56); return b }},
		{"missing UUID mask", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[8:], attrVolumeInfo|attrCapabilities); return b }},
		{"unexpected common", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[4:], attrReturned|attrDevice); return b }},
		{"unexpected directory", func(b []byte) []byte { b[12] = 1; return b }},
		{"capability not supported", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[24:], capPersistentIDs); return b }},
		{"capability validity absent", func(b []byte) []byte { binary.LittleEndian.PutUint32(b[40:], capPersistentIDs); return b }},
		{"zero UUID", func(b []byte) []byte { clear(b[56:]); return b }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b := tc.change(volumePacket())
			if _, err := decodeVolume(b); err == nil {
				t.Fatal("accepted missing/unsupported metadata")
			}
		})
	}
}
func TestObjectPacketBoundToDescriptor(t *testing.T) {
	f := fileIdentity{Device: 16777234, Inode: 18446744073709551615, BirthSeconds: 1700000000, BirthNanoseconds: 999999999}
	uuid, _ := decodeVolume(volumePacket())
	e, err := decodeObject(objectPacket(f), f, uuid)
	if err != nil || e.FileID != "18446744073709551615" {
		t.Fatalf("%v %v", e, err)
	}
	for _, offset := range []int{4, 8, 12, 16, 20, 24, 28, 36, 44} {
		b := objectPacket(f)
		b[offset] ^= 1
		if _, err := decodeObject(b, f, uuid); err == nil {
			t.Errorf("accepted changed offset %d", offset)
		}
	}
	b := objectPacket(f)
	binary.LittleEndian.PutUint32(b[8:], attrVolumeInfo)
	if _, err := decodeObject(b, f, uuid); err == nil {
		t.Fatal("object packet accepted volume marker")
	}
	for _, bad := range []fileIdentity{{Device: 1, Inode: 1, BirthSeconds: -1}, {Device: 1, Inode: 1, BirthNanoseconds: 1000000000}, {Device: 1, Inode: 0}} {
		if _, err := decodeObject(objectPacket(bad), bad, uuid); err == nil {
			t.Fatal("accepted invalid canonical facts")
		}
	}
}
func FuzzAttributePackets(f *testing.F) {
	f.Add(volumePacket())
	f.Add(objectPacket(fileIdentity{Device: 1, Inode: 2}))
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, b []byte) {
		_, _ = decodeVolume(b)
		_, _ = decodeObject(b, fileIdentity{Device: 1, Inode: 2}, "11111111-2222-3333-4444-555555555555")
	})
}
