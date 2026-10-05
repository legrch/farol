package results

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

// resultRecord is the closed version-1 storage schema. Both physical roots and
// the complete original delivery request are covered by the raw-byte digest.
type resultRecord struct {
	Version           uint32
	Root, StorageRoot port.JournalRoot
	Request           port.RetainRequest
}

func encodeResult(r resultRecord) ([]byte, error) {
	q := r.Request
	if r.Version != 1 || !validRoots(r.Root, r.StorageRoot) || !validBinding(q.Binding) || !validResult(q.Result) || len(q.Payload) > MaxResultBytes || !q.Conversation.Valid(q.Result, q.Payload) {
		return nil, Invalid
	}
	// Empty payload has one spelling, independent of caller slice allocation.
	if len(q.Payload) == 0 {
		r.Request.Payload = nil
	}
	raw, err := json.Marshal(r)
	if err != nil || len(raw) > port.MaxResultRecordBytes {
		return nil, Invalid
	}
	return raw, nil
}
func decodeResult(raw []byte) (resultRecord, error) {
	var r resultRecord
	if len(raw) == 0 || len(raw) > port.MaxResultRecordBytes || !utf8.Valid(raw) || !resultDepth(raw) {
		return r, Invalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&r) != nil || d.Decode(new(any)) != io.EOF {
		return resultRecord{}, Invalid
	}
	canonical, err := encodeResult(r)
	if err != nil || !bytes.Equal(raw, canonical) {
		return resultRecord{}, Invalid
	}
	return r, nil
}
func validRoots(root, child port.JournalRoot) bool {
	return root.Device != 0 && root.Inode != 0 && child.Device == root.Device && child.Inode != 0 && child.Inode != root.Inode && child.OwnerUID == root.OwnerUID
}
func resultPublication(r resultRecord, raw []byte) port.ResultPublication {
	return port.ResultPublication{Version: 1, Root: r.Root, StorageRoot: r.StorageRoot, Digest: sha256.Sum256(raw), EncodedBytes: uint32(len(raw))}
}

// Index names contain only a digest of non-content identity, never result text,
// provider metadata, raw IDs or a prompt. JSON supplies unambiguous boundaries.
func resultKey(q port.RetainRequest) string {
	raw, _ := json.Marshal([4]string{"chat-results-v1", q.Binding.ProfileID, q.Binding.BackendGeneration, q.Binding.OperationID})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func resultDepth(raw []byte) bool {
	depth := 0
	quoted, escaped := false, false
	for _, b := range raw {
		if quoted {
			if escaped {
				escaped = false
			} else if b == '\\' {
				escaped = true
			} else if b == '"' {
				quoted = false
			}
			continue
		}
		switch b {
		case '"':
			quoted = true
		case '{', '[':
			depth++
			if depth > 24 {
				return false
			}
		case '}', ']':
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	return !quoted && depth == 0
}
