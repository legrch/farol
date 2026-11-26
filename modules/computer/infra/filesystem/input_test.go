package filesystem

import (
	"strings"
	"testing"
)

func TestInputPureExpression(t *testing.T) {
	for _, pattern := range []string{"Markdown", "^# (Known|Today)", "(?i)note", `[Ж🌊]+`, "a.*b"} {
		if _, err := searchExpression(pattern); err != nil {
			t.Fatalf("valid expression %q: %v", pattern, err)
		}
	}
	for _, pattern := range []string{"", "[", `(?=secret)`, `(a)\1`, `\w+`, `\bnote\b`, `(a+)+`, `a+b+`, `(ab|cd)+`, `(?U)a+`, `\x{41}`, string([]byte{255}), strings.Repeat("🌊", 2049)} {
		_, err := searchExpression(pattern)
		expectCode(t, err, "WORKSPACE_INVALID_REQUEST")
	}
}
