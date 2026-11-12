package observation

import (
	"bytes"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

var errEvidence = errors.New("WORKSPACE_IDENTITY_INVALID")

// ParseEvidence is a strict, bounded draft codec. Absent legacy evidence is a
// separate caller state; null, unknown versions, duplicate/unknown keys and
// trailing JSON MUST NOT be treated as absence or a migration opportunity.
func ParseEvidence(data []byte) (Evidence, error) {
	if len(data) == 0 || len(data) > 2048 || !utf8.Valid(data) {
		return Evidence{}, errEvidence
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return Evidence{}, errEvidence
	}
	fields := map[string]string{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return Evidence{}, errEvidence
		}
		if _, duplicate := fields[key]; duplicate {
			return Evidence{}, errEvidence
		}
		switch key {
		case "schema", "filesystem", "volumeUuid", "fileId", "birthSeconds", "birthNanoseconds":
		default:
			return Evidence{}, errEvidence
		}
		var raw json.RawMessage
		if decoder.Decode(&raw) != nil || bytes.Equal(raw, []byte("null")) {
			return Evidence{}, errEvidence
		}
		var value string
		if json.Unmarshal(raw, &value) != nil {
			return Evidence{}, errEvidence
		}
		fields[key] = value
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || len(fields) != 6 || len(bytes.TrimSpace(data[decoder.InputOffset():])) != 0 {
		return Evidence{}, errEvidence
	}
	value := Evidence{Schema: fields["schema"], Filesystem: fields["filesystem"], VolumeUUID: fields["volumeUuid"], FileID: fields["fileId"], BirthSeconds: fields["birthSeconds"], BirthNanoseconds: fields["birthNanoseconds"]}
	if !value.Valid() {
		return Evidence{}, errEvidence
	}
	return value, nil
}

func EncodeEvidence(value Evidence) ([]byte, error) {
	if !value.Valid() {
		return nil, errEvidence
	}
	return json.Marshal(value)
}
