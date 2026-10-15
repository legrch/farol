// Package appidentity validates bounded, already-read app identity documents.
// It performs no I/O and does not establish signing or release provenance.
package appidentity

import (
	"context"
	"strings"
	"unicode/utf8"
)

// Code is a stable refusal classification. Errors contain no document content.
type Code string

const (
	InvalidInput   Code = "identity_input"
	Canceled       Code = "identity_canceled"
	Limit          Code = "identity_limit"
	InvalidPlist   Code = "identity_plist"
	InvalidJSON    Code = "identity_json"
	BundleMismatch Code = "bundle_identity"
	BuildMismatch  Code = "build_identity"
)

// Error is a classified refusal; Code is safe to expose to an adapter.
type Error struct{ Code Code }

func (e *Error) Error() string { return string(e.Code) }
func refusal(c Code) error     { return &Error{Code: c} }

const (
	bundle      = "local.farol.next.preview"
	maxDocument = 65536
	maxDepth    = 128
	maxUnits    = 65536
	maxDecoded  = 1 << 20
)

type budget struct {
	ctx          context.Context
	units, bytes int
}

func (b *budget) check() error {
	if b.ctx.Err() != nil {
		return refusal(Canceled)
	}
	return nil
}
func (b *budget) add(units, size int) error {
	if err := b.check(); err != nil {
		return err
	}
	if units < 0 || size < 0 || units > maxUnits-b.units || size > maxDecoded-b.bytes {
		return refusal(Limit)
	}
	b.units += units
	b.bytes += size
	return nil
}
func (b *budget) node(depth int) error {
	if depth > maxDepth {
		return refusal(Limit)
	}
	return b.add(1, 0)
}

// Verify checks the fixed preview bundle, short plist version, and three exact
// build JSON strings. Unknown fields are validated and accepted. Each document
// is 1..65536 bytes. Each parser bounds nesting at 128, nodes plus edges at 65536,
// and decoded scalar bytes at 1 MiB. Binary shared objects are counted once,
// references individually; cached subtree heights still enforce every path.
// XML supports UTF-8 (optional BOM) and BOM-marked UTF-16, standard plist values,
// and the inert standard Apple DOCTYPE. Other DTDs/encodings are refused. Binary
// supports bplist00 scalars, arrays and dictionaries, including UID; unsupported
// markers, overlapping object extents, cycles and nonfinite reals refuse.
// Bounded gaps/padding are inert; every offset-table object is validated.
// These limits and strict duplicate/Unicode validation tighten plistlib/json.
func Verify(ctx context.Context, infoPlist, buildIdentity []byte, version, buildID string) error {
	if ctx == nil {
		return refusal(InvalidInput)
	}
	if ctx.Err() != nil {
		return refusal(Canceled)
	}
	if !utf8.ValidString(version) || utf8.RuneCountInString(version) == 0 || utf8.RuneCountInString(version) > 128 || len(buildID) != 64 {
		return refusal(InvalidInput)
	}
	for _, c := range buildID {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return refusal(InvalidInput)
		}
	}
	if len(infoPlist) == 0 || len(buildIdentity) == 0 || len(infoPlist) > maxDocument || len(buildIdentity) > maxDocument {
		return refusal(Limit)
	}
	p, err := parsePlist(infoPlist, &budget{ctx: ctx})
	if err != nil {
		return err
	}
	m, ok := p.(map[string]any)
	if !ok {
		return refusal(InvalidPlist)
	}
	short, _, _ := strings.Cut(version, "-")
	if m["CFBundleIdentifier"] != bundle || m["CFBundleShortVersionString"] != short {
		return refusal(BundleMismatch)
	}
	j, err := parseJSON(buildIdentity, &budget{ctx: ctx})
	if err != nil {
		return err
	}
	v, ok := j.(map[string]any)
	if !ok {
		return refusal(InvalidJSON)
	}
	if v["bundleId"] != bundle || v["version"] != version || v["buildId"] != buildID {
		return refusal(BuildMismatch)
	}
	if ctx.Err() != nil {
		return refusal(Canceled)
	}
	return nil
}
