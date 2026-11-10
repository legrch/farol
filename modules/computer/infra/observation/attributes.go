package observation

import (
	"encoding/binary"
	"encoding/hex"
	"strconv"

	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

// Fixed Darwin attrlist ABI, packed at 4-byte boundaries, amd64/arm64 only.
// Source: Darwin sys/attr.h and getattrlist(2). A returned mask must confirm ALL
// requested fields; zero-filled unsupported fields never become evidence.
const (
	attrReturned     uint32 = 0x80000000
	attrDevice       uint32 = 0x00000002
	attrBirth        uint32 = 0x00000200
	attrFileID       uint32 = 0x02000000
	attrVolumeInfo   uint32 = 0x80000000
	attrCapabilities uint32 = 0x00020000
	attrVolumeUUID   uint32 = 0x00040000
	capPersistentIDs uint32 = 0x00000001
	cap64BitIDs      uint32 = 0x00020000
	volumeBytes             = 72
	objectBytes             = 52
)

func header(data []byte, size int, common, volume uint32) error {
	if len(data) != size || binary.LittleEndian.Uint32(data[0:4]) != uint32(size) {
		return fail("WORKSPACE_IDENTITY_INVALID")
	}
	gotCommon, gotVolume := binary.LittleEndian.Uint32(data[4:8]), binary.LittleEndian.Uint32(data[8:12])
	if gotCommon != common || gotVolume & ^attrVolumeInfo != volume || (volume == 0 && gotVolume != 0) ||
		binary.LittleEndian.Uint32(data[12:16]) != 0 || binary.LittleEndian.Uint32(data[16:20]) != 0 || binary.LittleEndian.Uint32(data[20:24]) != 0 {
		return fail("WORKSPACE_IDENTITY_UNSUPPORTED")
	}
	return nil
}

func decodeVolume(data []byte) (string, error) {
	if err := header(data, volumeBytes, attrReturned, attrCapabilities|attrVolumeUUID); err != nil {
		return "", err
	}
	capabilities := binary.LittleEndian.Uint32(data[24:28])
	valid := binary.LittleEndian.Uint32(data[40:44])
	const required = capPersistentIDs | cap64BitIDs
	if capabilities&valid&required != required {
		return "", fail("WORKSPACE_IDENTITY_UNSUPPORTED")
	}
	uuid := hex.EncodeToString(data[56:72])
	if uuid == "00000000000000000000000000000000" {
		return "", fail("WORKSPACE_IDENTITY_UNSUPPORTED")
	}
	return uuid[:8] + "-" + uuid[8:12] + "-" + uuid[12:16] + "-" + uuid[16:20] + "-" + uuid[20:], nil
}

func decodeObject(data []byte, current fileIdentity, uuid string) (identity.Evidence, error) {
	if err := header(data, objectBytes, attrReturned|attrDevice|attrBirth|attrFileID, 0); err != nil {
		return identity.Evidence{}, err
	}
	device := uint64(binary.LittleEndian.Uint32(data[24:28]))
	seconds := int64(binary.LittleEndian.Uint64(data[28:36]))
	nanos := int64(binary.LittleEndian.Uint64(data[36:44]))
	inode := binary.LittleEndian.Uint64(data[44:52])
	if device != current.Device || inode != current.Inode || seconds != current.BirthSeconds || nanos != current.BirthNanoseconds {
		return identity.Evidence{}, fail("WORKSPACE_RACE_DETECTED")
	}
	evidence := identity.Evidence{Schema: identity.EvidenceSchema, Filesystem: "apfs", VolumeUUID: uuid,
		FileID: strconv.FormatUint(inode, 10), BirthSeconds: strconv.FormatInt(seconds, 10), BirthNanoseconds: strconv.FormatInt(nanos, 10)}
	if !evidence.Valid() {
		return identity.Evidence{}, fail("WORKSPACE_IDENTITY_INVALID")
	}
	return evidence, nil
}
