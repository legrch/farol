// Package mutation owns pure hash-bound operation and journal policy. Values are
// not authority, native filesystem observations or permission to execute effects.
package mutation

import (
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

const MaxBytes = 8 * 1024 * 1024
const MaxEdits = 256
const MaxSafeInteger uint64 = 9007199254740991

type Kind string

const (
	WriteKind Kind = "write"
	EditKind  Kind = "edit"
)

type Operation interface {
	operation()
	Kind() Kind
	Path() string
	Clone() Operation
}
type Write struct {
	RelativePath, Content string
	ExpectedSHA256        *string
}
type TextEdit struct{ OldText, NewText string }
type Edit struct {
	RelativePath   string
	Edits          []TextEdit
	ExpectedSHA256 string
}

func (Write) operation()         {}
func (Edit) operation()          {}
func (Write) Kind() Kind         { return WriteKind }
func (Edit) Kind() Kind          { return EditKind }
func (v Write) Path() string     { return v.RelativePath }
func (v Edit) Path() string      { return v.RelativePath }
func (v Write) Clone() Operation { v.ExpectedSHA256 = cloneHash(v.ExpectedSHA256); return v }
func (v Edit) Clone() Operation  { v.Edits = slices.Clone(v.Edits); return v }
func cloneHash(v *string) *string {
	if v == nil {
		return nil
	}
	copy := *v
	return &copy
}
func Identifier(v string, limit int) bool {
	if v == "" || !utf8.ValidString(v) {
		return false
	}
	units := 0
	for _, r := range v {
		units++
		if r > 0xffff {
			units++
		}
		if units > limit {
			return false
		}
	}
	return true
}
func RelativePath(v string) bool {
	if !Identifier(v, 4096) || strings.HasPrefix(v, "/") || strings.Contains(v, "\\") {
		return false
	}
	for _, r := range v {
		if r < 32 || r == 127 {
			return false
		}
	}
	for _, part := range strings.Split(v, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
func SHA256(v string) bool {
	if len(v) != 64 {
		return false
	}
	for _, r := range v {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
func inputText(v string) bool {
	if !utf8.ValidString(v) || strings.ContainsRune(v, 0) {
		return false
	}
	if v == "" {
		return true
	}
	return Identifier(v, MaxBytes)
}

// ValidateInput preserves the TS request's UTF-16 text limits. The native
// boundary has a separate UTF-8/aggregate-byte ceiling and failure classification.
func ValidateInput(op Operation) error {
	valid := false
	switch v := op.(type) {
	case Write:
		valid = RelativePath(v.RelativePath) && inputText(v.Content) && (v.ExpectedSHA256 == nil || SHA256(*v.ExpectedSHA256))
	case Edit:
		valid = RelativePath(v.RelativePath) && SHA256(v.ExpectedSHA256) && len(v.Edits) > 0 && len(v.Edits) <= MaxEdits
		for _, edit := range v.Edits {
			valid = valid && edit.OldText != "" && edit.OldText != edit.NewText && inputText(edit.OldText) && inputText(edit.NewText)
		}
	}
	if !valid {
		return authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
	}
	return nil
}
func ValidateNative(op Operation) error {
	if ValidateInput(op) != nil {
		return authority.Fail("WORKSPACE_INVALID_REQUEST", "native-workspace")
	}
	switch v := op.(type) {
	case Write:
		if len(v.Content) > MaxBytes {
			return authority.Fail("WORKSPACE_INVALID_REQUEST", "native-workspace")
		}
	case Edit:
		aggregate := 0
		for _, edit := range v.Edits {
			aggregate += len(edit.OldText) + len(edit.NewText)
			if aggregate > MaxBytes {
				return authority.Fail("WORKSPACE_INVALID_REQUEST", "native-workspace")
			}
		}
	}
	return nil
}

// CheckPrecondition consumes a qualified native observation; it does not read a
// file or attest that observation. nil means absent, including for create-only.
func CheckPrecondition(op Operation, observed *string) error {
	if err := ValidateNative(op); err != nil {
		return err
	}
	if observed != nil && !SHA256(*observed) {
		return authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	var expected *string
	switch v := op.(type) {
	case Write:
		expected = v.ExpectedSHA256
	case Edit:
		if observed == nil {
			return authority.Fail("WORKSPACE_NOT_FOUND", "native-workspace")
		}
		expected = &v.ExpectedSHA256
	}
	if !sameHash(expected, observed) {
		return authority.Fail("WORKSPACE_MUTATION_CONFLICT", "native-workspace")
	}
	return nil
}
func sameHash(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
