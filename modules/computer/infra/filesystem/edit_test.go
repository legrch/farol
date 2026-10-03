package filesystem

import (
	"bytes"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestMutationEditBOMMixedEndingsAndSimultaneousMatches(t *testing.T) {
	input := append([]byte{0xef, 0xbb, 0xbf}, []byte("first\r\nsecond\nfinal")...)
	output, err := editPayload(input, []mutation.TextEdit{{OldText: "first\n", NewText: "first2\ninsert\n"}, {OldText: "second\n", NewText: "second2\n"}, {OldText: "final", NewText: "tail\nlast"}})
	want := append([]byte{0xef, 0xbb, 0xbf}, []byte("first2\r\ninsert\r\nsecond2\ntail\nlast")...)
	if err != nil || !bytes.Equal(output, want) {
		t.Fatalf("%q %v", output, err)
	}
	output, err = editPayload([]byte("alpha beta"), []mutation.TextEdit{{OldText: "alpha", NewText: "beta"}, {OldText: "beta", NewText: "gamma"}})
	if err != nil || string(output) != "beta gamma" {
		t.Fatalf("replacements cascaded %q %v", output, err)
	}
}
func TestMutationEditUniqueOverlapAndInvalidNormalizedEdits(t *testing.T) {
	cases := []struct {
		source string
		edits  []mutation.TextEdit
		code   string
	}{
		{"aaa", []mutation.TextEdit{{OldText: "aa", NewText: "b"}}, "WORKSPACE_EDIT_NOT_UNIQUE"},
		{"alpha beta", []mutation.TextEdit{{OldText: "alpha", NewText: "x"}, {OldText: "ha beta", NewText: "y"}}, "WORKSPACE_EDIT_OVERLAP"},
		{"alpha", []mutation.TextEdit{{OldText: "missing", NewText: "x"}}, "WORKSPACE_EDIT_NO_MATCH"},
		{"alpha\r\n", []mutation.TextEdit{{OldText: "alpha\r\n", NewText: "alpha\n"}}, "WORKSPACE_INVALID_REQUEST"},
		{string([]byte{255}), []mutation.TextEdit{{OldText: "alpha", NewText: "x"}}, "WORKSPACE_NOT_TEXT"},
	}
	for _, c := range cases {
		_, err := editPayload([]byte(c.source), c.edits)
		nativeCode(t, err, c.code)
	}
}

func TestMutationEditPreservesExistingNULAsLegacySourceBytes(t *testing.T) {
	output, err := editPayload([]byte("alpha\x00tail"), []mutation.TextEdit{{OldText: "alpha", NewText: "beta"}})
	if err != nil || string(output) != "beta\x00tail" {
		t.Fatalf("existing source bytes changed %q %v", output, err)
	}
}
