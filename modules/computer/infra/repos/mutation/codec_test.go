package mutation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestV1PreparedAndCompletedExactBytes(t *testing.T) {
	_, _, s := fixture()
	want := `{"schemaVersion":1,"kind":"workspace_mutation","record":{"identity":{"operationId":"op","ownerId":"owner","sessionId":"session","taskId":"task","taskEpoch":7,"participantId":"participant"},"workspaceId":"work","requestDigest":"` + strings.Repeat("a", 64) + `","phase":"prepared","outcome":null}}` + "\n"
	raw, err := encode(s)
	if err != nil || string(raw) != want {
		t.Fatalf("prepared bytes: %q %v", raw, err)
	}
	key, err := recordKey(s.Binding().Identity)
	digest := sha256.Sum256([]byte(`["op","owner","session","task",7,"participant"]`))
	if err != nil || key != hex.EncodeToString(digest[:])+".json" {
		t.Fatal("identity filename changed")
	}
	state, err := decode(raw)
	if err != nil || state.Binding() != s.Binding() || state.Phase() != domain.Prepared {
		t.Fatal(err)
	}
	final := completed(t, s)
	raw, err = encode(final)
	receipt := `{"receipt":{"kind":"workspace.mutation","operation":"write","relativePath":"file.md","bytes":12,"replacements":0,"beforeSha256":null,"afterSha256":"` + strings.Repeat("b", 64) + `"}}`
	want = strings.Replace(want, `"phase":"prepared","outcome":null`, `"phase":"completed","outcome":`+receipt, 1)
	if err != nil || string(raw) != want {
		t.Fatalf("completed bytes: %q %v", raw, err)
	}
	if _, err = decode(raw); err != nil {
		t.Fatal(err)
	}
}
func TestV1FailureVocabularyAndGoOnlyLimits(t *testing.T) {
	_, _, s := fixture()
	for _, f := range []domain.Failure{{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}, {Code: "WORKSPACE_NOT_FOUND", Source: "native-workspace"}, {Code: "AUTHORITY_EXPIRED", Source: "task-grant"}} {
		next, err := s.Refuse(f)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := encode(next)
		if err != nil {
			t.Fatal(err)
		}
		got, err := decode(raw)
		if err != nil || *got.Failure() != f {
			t.Fatal("failure converted", err)
		}
	}
	for _, f := range []domain.Failure{{Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", Source: "authority-store"}, {Code: "AUTHORITY_EXPIRED", Source: "authority-store"}} {
		next, err := s.Refuse(f)
		if err != nil {
			t.Fatal(err)
		}
		_, err = encode(next)
		code(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
	}
}
func TestJSUnicodeControlAndLiteralEscapeCompatibility(t *testing.T) {
	_, _, s := fixture()
	b := s.Binding()
	b.Identity.OperationID = "<>&😀\u2028\u2029\x00\b\f\n\r\t\\u2028"
	b.WorkspaceID = "<>&😀\u2028\\u2029"
	next, err := domain.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encode(next)
	if err != nil {
		t.Fatal(err)
	}
	quoted := quoteJS(b.Identity.OperationID)
	if !bytes.Contains(raw, []byte(quoted)) || bytes.Contains(raw, []byte(`\u003c`)) || !bytes.Contains(raw, []byte(`\\u2028`)) {
		t.Fatalf("escaping changed: %q", raw)
	}
	got, err := decode(raw)
	if err != nil || got.Binding() != b {
		t.Fatal("unicode roundtrip", err)
	}
	key, err := recordKey(b.Identity)
	expected := "[" + quoted + `,"owner","session","task",7,"participant"]`
	digest := sha256.Sum256([]byte(expected))
	if err != nil || key != hex.EncodeToString(digest[:])+".json" {
		t.Fatal("unicode key changed")
	}
}
func TestCanonicalCorruptionAndNoFormatConversion(t *testing.T) {
	_, _, s := fixture()
	raw, _ := encode(s)
	cases := [][]byte{
		bytes.TrimSpace(raw),
		append(bytes.Clone(raw), byte(' ')),
		[]byte(strings.Replace(string(raw), `"schemaVersion":1`, `"schemaVersion":2`, 1)),
		[]byte(strings.Replace(string(raw), `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1)),
		[]byte(strings.Replace(string(raw), `"ownerId":"owner"`, `"ownerId":"\ud800"`, 1)),
		[]byte(strings.Replace(string(raw), `"taskEpoch":7`, `"taskEpoch":7.0`, 1)),
		[]byte(strings.Replace(string(raw), `"taskEpoch":7`, `"taskEpoch":9007199254740992`, 1)),
		[]byte(strings.Replace(string(raw), `"outcome":null`, `"outcome":{}`, 1)),
		[]byte(strings.Replace(string(raw), `"ownerId":"owner"`, `"ownerId":"owner","extra":true`, 1)),
		bytes.Repeat([]byte("x"), maxRecordBytes+1),
		[]byte{0xff},
	}
	for n, candidate := range cases {
		if got, err := decode(candidate); err == nil || got != nil {
			t.Fatalf("case %d accepted corruption", n)
		}
	}
}
