package mutation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Field order, nullable fields, receipt vocabulary and newline are the existing
// PrivateWorkspaceMutationStore schemaVersion=1 JSON.stringify format.
type identity struct {
	OperationID   string `json:"operationId"`
	OwnerID       string `json:"ownerId"`
	SessionID     string `json:"sessionId"`
	TaskID        string `json:"taskId"`
	TaskEpoch     uint64 `json:"taskEpoch"`
	ParticipantID string `json:"participantId"`
}
type receipt struct {
	Kind         string      `json:"kind"`
	Operation    domain.Kind `json:"operation"`
	RelativePath string      `json:"relativePath"`
	Bytes        uint64      `json:"bytes"`
	Replacements uint32      `json:"replacements"`
	BeforeSHA256 *string     `json:"beforeSha256"`
	AfterSHA256  string      `json:"afterSha256"`
}
type outcome struct {
	Receipt *receipt `json:"receipt,omitempty"`
	Code    string   `json:"code,omitempty"`
	Source  string   `json:"source,omitempty"`
}
type record struct {
	Identity      identity     `json:"identity"`
	WorkspaceID   string       `json:"workspaceId"`
	RequestDigest string       `json:"requestDigest"`
	Phase         domain.Phase `json:"phase"`
	Outcome       *outcome     `json:"outcome"`
}
type envelope struct {
	Version uint8  `json:"schemaVersion"`
	Kind    string `json:"kind"`
	Record  record `json:"record"`
}

func toIdentity(i domain.Identity) identity {
	return identity{i.OperationID, i.OwnerID, i.SessionID, i.TaskID, i.TaskEpoch, i.ParticipantID}
}
func (i identity) domain() domain.Identity {
	return domain.Identity{OperationID: i.OperationID, OwnerID: i.OwnerID, SessionID: i.SessionID, TaskID: i.TaskID, TaskEpoch: i.TaskEpoch, ParticipantID: i.ParticipantID}
}
func validIdentity(i domain.Identity) bool {
	return domain.Identifier(i.OperationID, 160) && domain.Identifier(i.OwnerID, 160) && domain.Identifier(i.SessionID, 160) && domain.Identifier(i.TaskID, 160) && domain.Identifier(i.ParticipantID, 160) && i.TaskEpoch <= domain.MaxSafeInteger
}

// quoteJS preserves valid UTF-8 HTML/U+2028/U+2029, astral characters and control
// escaping exactly; invalid UTF-16 surrogate input is outside the Go contract.
func quoteJS(text string) string {
	var b strings.Builder
	b.WriteByte('"')
	const digits = "0123456789abcdef"
	for _, ch := range text {
		switch ch {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(ch)
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
			if ch < 32 {
				b.WriteString(`\u00`)
				b.WriteByte(digits[ch>>4])
				b.WriteByte(digits[ch&15])
			} else {
				b.WriteRune(ch)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
func recordKey(i domain.Identity) (string, error) {
	if !validIdentity(i) {
		return "", failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	raw := "[" + quoteJS(i.OperationID) + "," + quoteJS(i.OwnerID) + "," + quoteJS(i.SessionID) + "," + quoteJS(i.TaskID) + "," + strconv.FormatUint(i.TaskEpoch, 10) + "," + quoteJS(i.ParticipantID) + "]"
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:]) + ".json", nil
}
func v1Failure(f domain.Failure) bool {
	if f.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
		return f.Source == "native-workspace" || f.Source == "operation-store"
	}
	code := domain.NativeCode(f.Code)
	switch f.Code {
	case "AUTHORITY_OWNER_MISMATCH", "AUTHORITY_TASK_MISMATCH", "AUTHORITY_COMPUTER_MISMATCH", "AUTHORITY_EXPIRED", "AUTHORITY_INFLATION_DENIED", "AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_PATH_DENIED", "AUTHORITY_NETWORK_DENIED", "AUTHORITY_COMMAND_DENIED", "AUTHORITY_MUTATION_OWNERSHIP_DENIED":
		code = true
	}
	source := false
	switch f.Source {
	case "native-workspace", "operation-store", "computer-approval", "task-admission", "task-grant", "owner-restriction", "role", "computer-policy", "native-host":
		source = true
	}
	return code && source
}
func encode(state *domain.State) ([]byte, error) {
	if state == nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	b := state.Binding()
	if _, err := domain.Restore(b, state.Phase(), state.Receipt(), state.Failure()); err != nil || !validIdentity(b.Identity) {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	r := record{Identity: toIdentity(b.Identity), WorkspaceID: b.WorkspaceID, RequestDigest: b.RequestDigest, Phase: state.Phase()}
	if v := state.Receipt(); v != nil {
		r.Outcome = &outcome{Receipt: &receipt{Kind: "workspace.mutation", Operation: v.Operation, RelativePath: v.RelativePath, Bytes: v.Bytes, Replacements: v.Replacements, BeforeSHA256: v.BeforeSHA256, AfterSHA256: v.AfterSHA256}}
	}
	if f := state.Failure(); f != nil {
		// v1 cannot encode the newer Go-only authority-store errors. Refuse storage
		// instead of widening its enum or converting a known fact into another fact.
		if !v1Failure(*f) {
			return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
		}
		r.Outcome = &outcome{Code: f.Code, Source: f.Source}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(envelope{Version: 1, Kind: "workspace_mutation", Record: r}) != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	raw, err := jsSeparators(buf.Bytes())
	if err != nil {
		return nil, err
	}
	if len(raw) > maxRecordBytes {
		return nil, failure("WORKSPACE_MUTATION_STATE_OVERSIZED")
	}
	return raw, nil
}

// Go JSON escapes these separators even with EscapeHTML=false. Replace only
// actual escapes inside JSON strings; a literal backslash-u remains literal.
func jsSeparators(raw []byte) ([]byte, error) {
	var out bytes.Buffer
	for n := 0; n < len(raw); n++ {
		if raw[n] == '\\' && n+1 < len(raw) {
			if n+6 <= len(raw) && (string(raw[n:n+6]) == `\u2028` || string(raw[n:n+6]) == `\u2029`) {
				if raw[n+5] == '8' {
					out.WriteRune('\u2028')
				} else {
					out.WriteRune('\u2029')
				}
				n += 5
			} else {
				out.WriteByte(raw[n])
				n++
				out.WriteByte(raw[n])
			}
		} else {
			out.WriteByte(raw[n])
		}
	}
	return out.Bytes(), nil
}
func decode(raw []byte) (*domain.State, error) {
	corrupt := func() (*domain.State, error) { return nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT") }
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) {
		return corrupt()
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var e envelope
	if dec.Decode(&e) != nil || dec.Decode(new(any)) != io.EOF || e.Version != 1 || e.Kind != "workspace_mutation" {
		return corrupt()
	}
	r := e.Record
	var rec *domain.Receipt
	var f *domain.Failure
	if r.Outcome != nil {
		if r.Outcome.Receipt != nil {
			v := r.Outcome.Receipt
			if v.Kind != "workspace.mutation" || r.Outcome.Code != "" || r.Outcome.Source != "" {
				return corrupt()
			}
			rec = &domain.Receipt{Operation: v.Operation, RelativePath: v.RelativePath, Bytes: v.Bytes, Replacements: v.Replacements, BeforeSHA256: v.BeforeSHA256, AfterSHA256: v.AfterSHA256}
		} else {
			f = &domain.Failure{Code: r.Outcome.Code, Source: r.Outcome.Source}
		}
	}
	state, err := domain.Restore(domain.Binding{Identity: r.Identity.domain(), WorkspaceID: r.WorkspaceID, RequestDigest: r.RequestDigest}, r.Phase, rec, f)
	if err != nil {
		return corrupt()
	}
	canonical, err := encode(state)
	// Strict canonical v1 only. No conversion of alternate numbers, duplicate keys,
	// malformed surrogates, unknown/missing fields, whitespace or historical formats.
	if err != nil || !bytes.Equal(canonical, raw) {
		return corrupt()
	}
	return state, nil
}
