package filesystem

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
)

func searchExcerpt(line string, startByte, endByte int) (string, bool) {
	runes := []rune(line)
	start, end := utf8.RuneCountInString(line[:startByte]), utf8.RuneCountInString(line[:endByte])
	for i, r := range runes {
		if r != '\t' && (r < 32 || r == 127) {
			runes[i] = '�'
		}
	}
	if len(runes) <= searchLineRunes {
		return string(runes), false
	}
	begin := 0
	if end > searchLineRunes {
		begin = min(start-min(start, searchLineRunes/4), len(runes)-searchLineRunes)
	}
	return string(runes[begin : begin+searchLineRunes]), true
}
func searchMatchBytes(match port.SearchMatch) int {
	value := struct {
		Line      uint64 `json:"line"`
		Path      string `json:"path"`
		Text      string `json:"text"`
		Truncated bool   `json:"truncated"`
	}{match.Line, match.Path, match.Text, match.Truncated}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	// Encode's final LF charges the match separator used by the active helper.
	_ = encoder.Encode(value)
	charge := encoded.Len()
	// encoding/json emits non-ASCII UTF-8; Python ensure_ascii expands each rune.
	for _, r := range match.Path + match.Text {
		if r > 127 && r != '\u2028' && r != '\u2029' {
			// encoding/json already escapes U+2028/U+2029 to six ASCII bytes.
			width := 6
			if r > 0xffff {
				width = 12
			}
			charge += width - utf8.RuneLen(r)
		}
	}
	return charge
}
