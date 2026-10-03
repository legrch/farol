package filesystem

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// Digester implements the active JSON.stringify fingerprint, including raw
// Unicode/HTML and ordered edits. It owns no authority, state or native IO.
type Digester struct{}

func (Digester) Digest(input port.MutationDigestInput) (string, error) {
	if !mutation.Identifier(input.WorkspaceID, 160) || mutation.ValidateInput(input.Operation) != nil {
		return "", refusal("WORKSPACE_INVALID_REQUEST")
	}
	var b strings.Builder
	b.WriteByte('[')
	quoteJS(&b, input.WorkspaceID)
	b.WriteByte(',')
	quoteJS(&b, "workspace."+string(input.Operation.Kind()))
	b.WriteByte(',')
	quoteJS(&b, input.Operation.Path())
	b.WriteByte(',')
	switch v := input.Operation.(type) {
	case mutation.Write:
		if v.ExpectedSHA256 == nil {
			b.WriteString("null")
		} else {
			quoteJS(&b, *v.ExpectedSHA256)
		}
		b.WriteByte(',')
		quoteJS(&b, v.Content)
	case mutation.Edit:
		quoteJS(&b, v.ExpectedSHA256)
		b.WriteString(",[")
		for i, e := range v.Edits {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteByte('[')
			quoteJS(&b, e.OldText)
			b.WriteByte(',')
			quoteJS(&b, e.NewText)
			b.WriteByte(']')
		}
		b.WriteByte(']')
	}
	b.WriteByte(']')
	return payloadHash([]byte(b.String())), nil
}
func payloadHash(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func quoteJS(b *strings.Builder, text string) {
	const digits = "0123456789abcdef"
	b.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 32 {
				b.WriteString(`\u00`)
				b.WriteByte(digits[r>>4])
				b.WriteByte(digits[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}
