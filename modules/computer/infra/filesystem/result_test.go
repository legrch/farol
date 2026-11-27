package filesystem

import (
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
)

func TestResultPureMatchBytesAreASCIIEscaped(t *testing.T) {
	match := port.SearchMatch{Path: "🌊.md", Line: 1, Text: "🌊"}
	ascii := searchMatchBytes(match)
	match.Path = "a.md"
	match.Text = "a"
	if ascii-searchMatchBytes(match) != 22 {
		t.Fatal("astral JSON response charge was not ASCII escaped")
	}
}

func TestResultPureExcerptBounds(t *testing.T) {
	text, truncated := searchExcerpt("a\x01b", 0, 3)
	if text != "a�b" || truncated {
		t.Fatalf("control replacement %q %v", text, truncated)
	}
	line := strings.Repeat("a", 600) + "hit"
	text, truncated = searchExcerpt(line, 600, 603)
	if !truncated || len([]rune(text)) != searchLineRunes || !strings.Contains(text, "hit") {
		t.Fatalf("long excerpt %v %d", truncated, len(text))
	}
}
