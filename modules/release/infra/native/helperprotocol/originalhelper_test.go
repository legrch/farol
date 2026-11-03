package helperprotocol_test

import (
	"strings"
	"testing"
)

// Restore the exact original bytes used by the historical Python oracles.
// The sole accepted delta is the separately tested predecessor boundary.
func normalizeOriginalHelper(t *testing.T, source []byte) []byte {
	t.Helper()
	text := string(source)
	for _, line := range []string{
		"    # 0.5.7 cannot read 0.5.8 send-requested or extended history records.\n",
		"            or (source == \"0.5.7\" and target == \"0.5.8\")\n",
	} {
		if strings.Count(text, line) != 1 {
			t.Fatal("expected reviewed predecessor boundary missing or duplicated")
		}
		text = strings.Replace(text, line, "", 1)
	}
	return []byte(text)
}
