package mutation

import (
	"errors"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"strings"
	"testing"
)

func digest(c string) string { return strings.Repeat(c, 64) }
func hash(c string) *string  { v := digest(c); return &v }
func expectCode(t *testing.T, err error, code, source string) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != code || f.Source != source || f.Retry != "never" {
		t.Fatalf("got %v, want %s/%s/never", err, code, source)
	}
}
func TestCreateOnlyAndExactHashPreconditions(t *testing.T) {
	create := Write{RelativePath: "new/file.md", Content: ""}
	if err := CheckPrecondition(create, nil); err != nil {
		t.Fatal(err)
	}
	expectCode(t, CheckPrecondition(create, hash("a")), "WORKSPACE_MUTATION_CONFLICT", "native-workspace")
	overwrite := Write{RelativePath: "README.md", Content: "new", ExpectedSHA256: hash("a")}
	if err := CheckPrecondition(overwrite, hash("a")); err != nil {
		t.Fatal(err)
	}
	expectCode(t, CheckPrecondition(overwrite, nil), "WORKSPACE_MUTATION_CONFLICT", "native-workspace")
	expectCode(t, CheckPrecondition(overwrite, hash("b")), "WORKSPACE_MUTATION_CONFLICT", "native-workspace")
	edit := Edit{RelativePath: "README.md", ExpectedSHA256: digest("a"), Edits: []TextEdit{{OldText: "old", NewText: "new"}}}
	expectCode(t, CheckPrecondition(edit, nil), "WORKSPACE_NOT_FOUND", "native-workspace")
	if err := CheckPrecondition(edit, hash("a")); err != nil {
		t.Fatal(err)
	}
	malformed := "private malformed observation"
	expectCode(t, CheckPrecondition(edit, &malformed), "WORKSPACE_HELPER_FAILED", "native-workspace")
}
func TestInputPathHashAndEditBounds(t *testing.T) {
	for _, path := range []string{"", ".", "/absolute", "a/../b", "a//b", "a/./b", "a/", "a\\b", "a\x00b", "a\nb", strings.Repeat("😀", 2049)} {
		expectCode(t, ValidateInput(Write{RelativePath: path}), "COMPUTER_INVALID_REQUEST", "contract")
	}
	for _, op := range []Operation{nil, Write{RelativePath: "a", Content: "\x00"}, Write{RelativePath: "a", ExpectedSHA256: hash("A")}, Write{RelativePath: "a", Content: string([]byte{255})}, Edit{RelativePath: "a", ExpectedSHA256: digest("a")}, Edit{RelativePath: "a", ExpectedSHA256: digest("a"), Edits: []TextEdit{{OldText: "", NewText: "new"}}}, Edit{RelativePath: "a", ExpectedSHA256: digest("a"), Edits: []TextEdit{{OldText: "same", NewText: "same"}}}} {
		expectCode(t, ValidateInput(op), "COMPUTER_INVALID_REQUEST", "contract")
	}
	edits := make([]TextEdit, 256)
	for i := range edits {
		edits[i] = TextEdit{OldText: "old", NewText: "new"}
	}
	if err := ValidateInput(Edit{RelativePath: "a", ExpectedSHA256: digest("a"), Edits: edits}); err != nil {
		t.Fatal(err)
	}
	expectCode(t, ValidateInput(Edit{RelativePath: "a", ExpectedSHA256: digest("a"), Edits: append(edits, TextEdit{OldText: "old", NewText: "new"})}), "COMPUTER_INVALID_REQUEST", "contract")
}
func TestInputUTF16AndNativeUTF8ByteLimitsRemainSeparate(t *testing.T) {
	exact := Write{RelativePath: "a", Content: strings.Repeat("x", MaxBytes)}
	if err := ValidateInput(exact); err != nil {
		t.Fatal(err)
	}
	if err := ValidateNative(exact); err != nil {
		t.Fatal(err)
	}
	exact.Content += "x"
	expectCode(t, ValidateInput(exact), "COMPUTER_INVALID_REQUEST", "contract")
	multi := Write{RelativePath: "a", Content: strings.Repeat("é", MaxBytes/2+1)}
	if err := ValidateInput(multi); err != nil {
		t.Fatal("request unexpectedly imposed the native byte ceiling")
	}
	expectCode(t, ValidateNative(multi), "WORKSPACE_INVALID_REQUEST", "native-workspace")
	edit := Edit{RelativePath: "a", ExpectedSHA256: digest("a"), Edits: []TextEdit{{OldText: strings.Repeat("x", MaxBytes/2), NewText: strings.Repeat("y", MaxBytes/2)}}}
	if err := ValidateNative(edit); err != nil {
		t.Fatal(err)
	}
	edit.Edits[0].NewText += "y"
	if err := ValidateInput(edit); err != nil {
		t.Fatal(err)
	}
	expectCode(t, ValidateNative(edit), "WORKSPACE_INVALID_REQUEST", "native-workspace")
}
func TestOperationCopiesDoNotAliasHashOrOrderedEdits(t *testing.T) {
	original := Write{RelativePath: "a", ExpectedSHA256: hash("a")}
	copy := original.Clone().(Write)
	*original.ExpectedSHA256 = digest("b")
	if *copy.ExpectedSHA256 != digest("a") {
		t.Fatal("hash alias")
	}
	edit := Edit{RelativePath: "a", ExpectedSHA256: digest("a"), Edits: []TextEdit{{OldText: "one", NewText: "1"}, {OldText: "two", NewText: "2"}}}
	saved := edit.Clone().(Edit)
	edit.Edits[0] = edit.Edits[1]
	if saved.Edits[0].OldText != "one" || saved.Edits[1].OldText != "two" {
		t.Fatal("edit order/clone lost")
	}
}
func TestNativeReceiptShapeMatchesActiveAdapterWithoutInventedHashProof(t *testing.T) {
	op := Write{RelativePath: "a", ExpectedSHA256: hash("a")}
	r := Receipt{Operation: WriteKind, RelativePath: "a", BeforeSHA256: hash("b"), AfterSHA256: digest("c")}
	// TS parsing validates shape and correlation, not the before-hash relation.
	if !ValidNativeReceipt(r, op) {
		t.Fatal("introduced stronger receipt semantics")
	}
	r.Replacements = 1
	if ValidNativeReceipt(r, op) {
		t.Fatal("write replacements accepted")
	}
	r.Replacements = 0
	r.RelativePath = "other"
	if ValidNativeReceipt(r, op) {
		t.Fatal("crossed path accepted")
	}
	edit := Edit{RelativePath: "a", ExpectedSHA256: digest("a"), Edits: []TextEdit{{OldText: "old", NewText: "new"}}}
	r.Operation = EditKind
	r.RelativePath = "a"
	if ValidNativeReceipt(r, edit) {
		t.Fatal("zero-edit native receipt accepted")
	}
	r.Replacements = 1
	if !ValidNativeReceipt(r, edit) {
		t.Fatal("valid edit receipt refused")
	}
	r.Bytes = MaxBytes + 1
	if ValidStoredReceipt(r) {
		t.Fatal("oversized receipt")
	}
}
