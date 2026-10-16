package records

import (
	"encoding/json"
	"unicode/utf8"
)

// EncodeRejectedTarget emits the existing alpha helper schema. Identity is a
// measured comparison value; encoding supplies neither provenance nor authority.
func EncodeRejectedTarget(value RejectedTarget) ([]byte, error) {
	// json.Marshal replaces invalid UTF-8. Refuse before it can alter identity.
	for _, version := range []string{value.Operation.Source.Version, value.Operation.Target.Version} {
		if !utf8.ValidString(version) {
			return nil, EncodingInvalid
		}
	}
	wire := struct {
		Schema string `json:"schema"`
		Operation
		Identity struct {
			Device string `json:"device"`
			Inode  string `json:"inode"`
		} `json:"directoryIdentity"`
	}{Schema: "farol.rejected-update-target/1", Operation: value.Operation}
	wire.Identity.Device, wire.Identity.Inode = value.Device, value.Inode
	data, err := json.Marshal(wire)
	if err != nil {
		return nil, Invalid
	}
	if len(data)+1 > MaxHelperRecordBytes {
		return nil, Oversized
	}
	if _, err := DecodeRejectedTarget(data, value.Operation); err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}
