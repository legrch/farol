package filesystem

import (
	"bytes"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/domain/mutation"
)

type replacement struct {
	start, end int
	text       string
}

// Edits match simultaneously against the original LF-normalized UTF-8 view.
// Untouched bytes, BOM and each replacement's local line ending are preserved.
func editPayload(payload []byte, edits []mutation.TextEdit) ([]byte, error) {
	bom := bytes.HasPrefix(payload, []byte{0xef, 0xbb, 0xbf})
	sourceBytes := payload
	if bom {
		sourceBytes = payload[3:]
	}
	if !utf8.Valid(sourceBytes) {
		return nil, refusal("WORKSPACE_NOT_TEXT")
	}
	source := string(sourceBytes)
	var normalized strings.Builder
	offsets := make([]int, 0, len(source)+1)
	for i := 0; i < len(source); i++ {
		offsets = append(offsets, i)
		if source[i] == '\r' && i+1 < len(source) && source[i+1] == '\n' {
			normalized.WriteByte('\n')
			i++
		} else {
			normalized.WriteByte(source[i])
		}
	}
	offsets = append(offsets, len(source))
	searchable := normalized.String()
	changes := make([]replacement, 0, len(edits))
	for _, e := range edits {
		old, next := strings.ReplaceAll(e.OldText, "\r\n", "\n"), strings.ReplaceAll(e.NewText, "\r\n", "\n")
		if old == "" || old == next {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
		start := strings.Index(searchable, old)
		if start < 0 {
			return nil, refusal("WORKSPACE_EDIT_NO_MATCH")
		}
		if strings.Contains(searchable[start+1:], old) {
			return nil, refusal("WORKSPACE_EDIT_NOT_UNIQUE")
		}
		changes = append(changes, replacement{start: start, end: start + len(old), text: next})
	}
	slices.SortFunc(changes, func(a, b replacement) int { return a.start - b.start })
	var out strings.Builder
	cursor := 0
	for i, c := range changes {
		if i > 0 && c.start < changes[i-1].end {
			return nil, refusal("WORKSPACE_EDIT_OVERLAP")
		}
		start, end := offsets[c.start], offsets[c.end]
		out.WriteString(source[cursor:start])
		ending := strings.IndexByte(source[start:], '\n')
		if ending >= 0 {
			ending += start
		} else {
			ending = strings.LastIndexByte(source[:start], '\n')
		}
		text := c.text
		if ending > 0 && source[ending-1] == '\r' {
			text = strings.ReplaceAll(text, "\n", "\r\n")
		}
		out.WriteString(text)
		cursor = end
		if out.Len() > mutation.MaxBytes {
			return nil, refusal("WORKSPACE_FILE_TOO_LARGE")
		}
	}
	out.WriteString(source[cursor:])
	data := []byte(out.String())
	if bom {
		data = append([]byte{0xef, 0xbb, 0xbf}, data...)
	}
	if len(data) > mutation.MaxBytes {
		return nil, refusal("WORKSPACE_FILE_TOO_LARGE")
	}
	return data, nil
}
