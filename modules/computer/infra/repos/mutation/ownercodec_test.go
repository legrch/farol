package mutation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func ownerFixture(t *testing.T) (*Repository, *memory, *domain.State) {
	t.Helper()
	r, m, _ := fixture()
	b := domain.Binding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: "op", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, ComputerGeneration: 7, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64)}
	s, err := domain.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	return r, m, s
}

func TestOwnerV2ExactBytesAndDomainSeparatedKey(t *testing.T) {
	_, _, s := ownerFixture(t)
	want := `{"schemaVersion":2,"kind":"workspace_owner_mutation","record":{"identity":{"scope":"owner-settings","operationId":"op","ownerId":"owner","profileId":"profile","computerId":"computer"},"computerGeneration":7,"workspaceId":"work","requestDigest":"` + strings.Repeat("a", 64) + `","phase":"prepared","outcome":null}}` + "\n"
	raw, err := encode(s)
	if err != nil || string(raw) != want {
		t.Fatalf("owner prepared bytes: %q %v", raw, err)
	}
	key, err := recordKey(s.Binding().Identity)
	digest := sha256.Sum256([]byte(`["owner-settings-v2","op","owner","profile","computer"]`))
	if err != nil || key != hex.EncodeToString(digest[:])+".json" {
		t.Fatal("owner key domain or identity changed")
	}
	_, _, task := fixture()
	taskKey, err := recordKey(task.Binding().Identity)
	if err != nil || key == taskKey {
		t.Fatal("owner key overlaps task key")
	}
	for _, change := range []func(*domain.Identity){
		func(i *domain.Identity) { i.OperationID = "other" },
		func(i *domain.Identity) { i.OwnerID = "other" },
		func(i *domain.Identity) { i.ProfileID = "other" },
		func(i *domain.Identity) { i.ComputerID = "other" },
	} {
		i := s.Binding().Identity
		change(&i)
		changed, err := recordKey(i)
		if err != nil || changed == key {
			t.Fatal("owner identity dimension absent from key")
		}
	}
	for _, generation := range []uint64{0, domain.MaxSafeInteger} {
		b := s.Binding()
		b.ComputerGeneration = generation
		next, err := domain.NewPrepared(b)
		if err != nil {
			t.Fatal(err)
		}
		changed, err := recordKey(next.Binding().Identity)
		if err != nil || changed != key {
			t.Fatal("generation acquired a fresh key")
		}
	}
}

func TestOwnerV2RoundTripAllPhasesAndGenerations(t *testing.T) {
	_, _, s := ownerFixture(t)
	for _, generation := range []uint64{0, 7, domain.MaxSafeInteger} {
		b := s.Binding()
		b.ComputerGeneration = generation
		prepared, err := domain.NewPrepared(b)
		if err != nil {
			t.Fatal(err)
		}
		failed, err := prepared.Refuse(domain.Failure{Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", Source: "authority-store"})
		if err != nil {
			t.Fatal(err)
		}
		unknown, err := prepared.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
		if err != nil {
			t.Fatal(err)
		}
		write := completed(t, prepared)
		before := strings.Repeat("c", 64)
		edit, err := prepared.Complete(domain.Receipt{Operation: domain.EditKind, RelativePath: "file.md", Bytes: domain.MaxBytes, Replacements: domain.MaxEdits, BeforeSHA256: &before, AfterSHA256: strings.Repeat("b", 64)})
		if err != nil {
			t.Fatal(err)
		}
		for _, state := range []*domain.State{prepared, write, edit, failed, unknown} {
			raw, err := encode(state)
			if err != nil {
				t.Fatal(err)
			}
			got, err := decode(raw)
			if err != nil || got.Binding() != b || got.Phase() != state.Phase() {
				t.Fatal("owner roundtrip lost binding/phase", err)
			}
			if _, err = state.Apply(*got); err != nil {
				t.Fatal("roundtrip changed receipt/failure", err)
			}
			again, err := encode(got)
			if err != nil || !bytes.Equal(raw, again) {
				t.Fatal("owner bytes not canonical", err)
			}
		}
	}
}

func TestOwnerV2BoundedClassifiedFailuresOnly(t *testing.T) {
	_, _, s := ownerFixture(t)
	// These are classified codes/sources, never an open diagnostic string. Domain
	// Restore remains the single owner of allowed combinations and unknown phases.
	codes := []string{"WORKSPACE_INVALID_REQUEST", "WORKSPACE_POLICY_TOO_LARGE", "WORKSPACE_MUTATION_CANCELLED", "WORKSPACE_HELPER_UNTRUSTED", "WORKSPACE_INTERPRETER_UNTRUSTED", "WORKSPACE_PATH_REFUSED", "WORKSPACE_ROOT_CHANGED", "WORKSPACE_NOT_FOUND", "WORKSPACE_NOT_A_FILE", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_MUTATION_CONFLICT", "WORKSPACE_NOT_TEXT", "WORKSPACE_EDIT_NO_MATCH", "WORKSPACE_EDIT_NOT_UNIQUE", "WORKSPACE_EDIT_OVERLAP", "WORKSPACE_HELPER_FAILED", "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "COMPUTER_PARTICIPANT_NOT_FOUND", "COMPUTER_APPROVAL_NOT_FOUND", "AUTHORITY_OWNER_MISMATCH", "AUTHORITY_TASK_MISMATCH", "AUTHORITY_COMPUTER_MISMATCH", "AUTHORITY_EXPIRED", "AUTHORITY_INFLATION_DENIED", "AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_PATH_DENIED", "AUTHORITY_NETWORK_DENIED", "AUTHORITY_COMMAND_DENIED", "AUTHORITY_MUTATION_OWNERSHIP_DENIED"}
	sources := []string{"native-workspace", "operation-store", "computer-approval", "task-admission", "task-grant", "owner-restriction", "role", "computer-policy", "native-host", "authority-store"}
	for _, code := range codes {
		for _, source := range sources {
			f := domain.Failure{Code: code, Source: source}
			next, err := s.Refuse(f)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := encode(next)
			if err != nil {
				t.Fatal("classified owner failure refused", err)
			}
			got, err := decode(raw)
			if err != nil || got.Phase() != domain.Failed || *got.Failure() != f {
				t.Fatal("classified failure converted", err)
			}
		}
	}
	for _, source := range []string{"native-workspace", "operation-store"} {
		next, err := s.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: source})
		if err != nil {
			t.Fatal(err)
		}
		raw, err := encode(next)
		if err != nil {
			t.Fatal(err)
		}
		got, err := decode(raw)
		if err != nil || got.Phase() != domain.OutcomeUnknown || *got.Failure() != *next.Failure() {
			t.Fatal("unknown failure converted", err)
		}
	}
	for _, f := range []domain.Failure{
		{Code: "private diagnostic", Source: "authority-store"},
		{Code: "AUTHORITY_EXPIRED", Source: "/private/raw/path"},
		{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "authority-store"},
	} {
		if _, err := s.Refuse(f); err == nil {
			t.Fatal("unclassified failure accepted")
		}
	}
}

func TestOwnerV2UnicodeAndUTF16Bounds(t *testing.T) {
	_, _, s := ownerFixture(t)
	b := s.Binding()
	b.Identity.OperationID = "<>&😀\u2028\u2029\x00\b\f\n\r\t\\u2028"
	b.Identity.OwnerID = strings.Repeat("😀", 80)
	b.Identity.ProfileID = strings.Repeat("x", 160)
	b.Identity.ComputerID = "😀\\u2029"
	b.WorkspaceID = "<>&😀\u2028\\u2029"
	next, err := domain.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encode(next)
	if err != nil || !bytes.Contains(raw, []byte(quoteJS(b.Identity.OperationID))) || bytes.Contains(raw, []byte(`\u003c`)) {
		t.Fatalf("owner Unicode encoding: %q %v", raw, err)
	}
	got, err := decode(raw)
	if err != nil || got.Binding() != b {
		t.Fatal("owner Unicode roundtrip", err)
	}
	key, err := recordKey(b.Identity)
	i := b.Identity
	expected := `["owner-settings-v2",` + quoteJS(i.OperationID) + "," + quoteJS(i.OwnerID) + "," + quoteJS(i.ProfileID) + "," + quoteJS(i.ComputerID) + "]"
	digest := sha256.Sum256([]byte(expected))
	if err != nil || key != hex.EncodeToString(digest[:])+".json" {
		t.Fatal("owner Unicode key changed")
	}
}

func TestOwnerV2RejectsNoncanonicalMixedMissingAndOversizedRecords(t *testing.T) {
	_, _, s := ownerFixture(t)
	raw, err := encode(s)
	if err != nil {
		t.Fatal(err)
	}
	canonical := string(raw)
	cases := map[string]string{
		"no-newline":                   strings.TrimSuffix(canonical, "\n"),
		"extra-space":                  canonical + " ",
		"trailing-object":              canonical + "{}",
		"zero-version":                 strings.Replace(canonical, `"schemaVersion":2`, `"schemaVersion":0`, 1),
		"v1":                           strings.Replace(canonical, `"schemaVersion":2`, `"schemaVersion":1`, 1),
		"v3":                           strings.Replace(canonical, `"schemaVersion":2`, `"schemaVersion":3`, 1),
		"task-kind":                    strings.Replace(canonical, `workspace_owner_mutation`, `workspace_mutation`, 1),
		"case-kind":                    strings.Replace(canonical, `workspace_owner_mutation`, `WORKSPACE_OWNER_MUTATION`, 1),
		"duplicate-version":            strings.Replace(canonical, `"schemaVersion":2`, `"schemaVersion":2,"schemaVersion":2`, 1),
		"duplicate-id":                 strings.Replace(canonical, `"ownerId":"owner"`, `"ownerId":"owner","ownerId":"owner"`, 1),
		"unknown-envelope":             strings.Replace(canonical, `"record":`, `"extra":true,"record":`, 1),
		"unknown-record":               strings.Replace(canonical, `"phase":`, `"extra":true,"phase":`, 1),
		"unknown-identity":             strings.Replace(canonical, `"ownerId":"owner"`, `"ownerId":"owner","extra":true`, 1),
		"missing-scope":                strings.Replace(canonical, `"scope":"owner-settings",`, "", 1),
		"task-scope":                   strings.Replace(canonical, `"scope":"owner-settings"`, `"scope":"task"`, 1),
		"empty-scope":                  strings.Replace(canonical, `"scope":"owner-settings"`, `"scope":""`, 1),
		"missing-generation":           strings.Replace(canonical, `"computerGeneration":7,`, "", 1),
		"null-generation":              strings.Replace(canonical, `"computerGeneration":7`, `"computerGeneration":null`, 1),
		"unknown-phase":                strings.Replace(canonical, `"phase":"prepared"`, `"phase":"retry"`, 1),
		"empty-outcome":                strings.Replace(canonical, `"outcome":null`, `"outcome":{}`, 1),
		"missing-outcome":              strings.Replace(canonical, `,"outcome":null`, "", 1),
		"surrogate-high":               strings.Replace(canonical, `"ownerId":"owner"`, `"ownerId":"\ud800"`, 1),
		"surrogate-low":                strings.Replace(canonical, `"ownerId":"owner"`, `"ownerId":"\udc00"`, 1),
		"escaped-valid-surrogate-pair": strings.Replace(canonical, `"ownerId":"owner"`, `"ownerId":"\ud83d\ude00"`, 1),
		"alternate-string-escape":      strings.Replace(canonical, `"ownerId":"owner"`, `"ownerId":"\u006fwner"`, 1),
		"case-field":                   strings.Replace(canonical, `"computerId":`, `"ComputerId":`, 1),
		"field-order":                  strings.Replace(canonical, `"operationId":"op","ownerId":"owner"`, `"ownerId":"owner","operationId":"op"`, 1),
	}
	for _, number := range []string{"7.0", "7e0", "07", "-0", "-1", "9007199254740992", "18446744073709551616", `"7"`} {
		cases["generation-"+number] = strings.Replace(canonical, `"computerGeneration":7`, `"computerGeneration":`+number, 1)
	}
	for _, field := range []string{"operationId", "ownerId", "profileId", "computerId", "workspaceId", "requestDigest"} {
		// Replace individual fields directly so every other byte stays canonical.
		var value string
		switch field {
		case "operationId":
			value = "op"
		case "ownerId":
			value = "owner"
		case "profileId":
			value = "profile"
		case "computerId":
			value = "computer"
		case "workspaceId":
			value = "work"
		case "requestDigest":
			value = strings.Repeat("a", 64)
		}
		part := `"` + field + `":"` + value + `"`
		missing := strings.Replace(canonical, part+",", "", 1)
		if missing == canonical {
			missing = strings.Replace(canonical, ","+part, "", 1)
		}
		cases["missing-"+field] = missing
		cases["null-"+field] = strings.Replace(canonical, part, `"`+field+`":null`, 1)
		cases["empty-"+field] = strings.Replace(canonical, part, `"`+field+`":""`, 1)
		cases["overlimit-"+field] = strings.Replace(canonical, part, `"`+field+`":"`+strings.Repeat("x", 161)+`"`, 1)
		if field != "requestDigest" {
			cases["utf16-overlimit-"+field] = strings.Replace(canonical, part, `"`+field+`":"`+strings.Repeat("😀", 81)+`"`, 1)
		}
	}
	for _, part := range []string{`"sessionId":"session"`, `"sessionId":""`, `"taskId":"task"`, `"taskId":""`, `"taskEpoch":1`, `"taskEpoch":0`, `"participantId":"main"`, `"participantId":""`, `"computerGeneration":7`} {
		cases["task-field-"+part] = strings.Replace(canonical, `"scope":"owner-settings"`, `"scope":"owner-settings",`+part, 1)
	}
	// Missing generation is forbidden even when its valid domain value is zero.
	cases["missing-zero-generation"] = strings.Replace(strings.Replace(canonical, `"computerGeneration":7`, `"computerGeneration":0`, 1), `"computerGeneration":0,`, "", 1)
	cases["oversized"] = strings.Repeat("x", maxRecordBytes+1)
	cases["invalid-utf8"] = string([]byte{0xff})
	cases["empty"] = ""
	for name, candidate := range cases {
		t.Run(name, func(t *testing.T) {
			if candidate == canonical {
				t.Fatal("corruption fixture did not change the valid record")
			}
			got, err := decode([]byte(candidate))
			if got != nil {
				t.Fatal("corrupt owner record returned")
			}
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
}

func TestOwnerV2RejectsImpossibleOutcomesAndRawDiagnostics(t *testing.T) {
	_, _, s := ownerFixture(t)
	failed, err := s.Refuse(domain.Failure{Code: "AUTHORITY_EXPIRED", Source: "authority-store"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encode(failed)
	if err != nil {
		t.Fatal(err)
	}
	for _, replacement := range []struct{ from, to string }{
		{`"code":"AUTHORITY_EXPIRED"`, `"code":"raw diagnostic"`},
		{`"source":"authority-store"`, `"source":"raw path"`},
		{`"source":"authority-store"`, `"source":"authority-store","diagnostic":"private"`},
		{`"code":"AUTHORITY_EXPIRED"`, `"code":"WORKSPACE_MUTATION_OUTCOME_UNKNOWN"`},
		{`"phase":"failed"`, `"phase":"prepared"`},
		{`"phase":"failed"`, `"phase":"completed"`},
		{`"phase":"failed"`, `"phase":"outcome_unknown"`},
		{`"source":"authority-store"`, `"source":"authority-store","receipt":null`},
	} {
		candidate := bytes.Replace(raw, []byte(replacement.from), []byte(replacement.to), 1)
		got, err := decode(candidate)
		if got != nil {
			t.Fatal("impossible outcome returned")
		}
		code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	}
	final := completed(t, s)
	raw, err = encode(final)
	if err != nil {
		t.Fatal(err)
	}
	for _, replacement := range []struct{ from, to string }{
		{`"kind":"workspace.mutation"`, `"kind":"raw"`},
		{`"bytes":12`, `"bytes":8388609`},
		{`"replacements":0`, `"replacements":257`},
		{`"beforeSha256":null`, `"beforeSha256":"bad"`},
		{`"relativePath":"file.md"`, `"relativePath":"` + strings.Repeat("x", 4097) + `"`},
		{`"receipt":{`, `"code":"AUTHORITY_EXPIRED","source":"authority-store","receipt":{`},
	} {
		got, err := decode(bytes.Replace(raw, []byte(replacement.from), []byte(replacement.to), 1))
		if got != nil {
			t.Fatal("invalid owner receipt returned")
		}
		code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	}
}

func TestV1RejectsEveryOwnerV2FieldAndEnvelope(t *testing.T) {
	_, _, s := fixture()
	raw, err := encode(s)
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{`"scope":""`, `"scope":"task"`, `"scope":"owner-settings"`, `"profileId":""`, `"computerId":""`} {
		candidate := bytes.Replace(raw, []byte(`"operationId":"op"`), []byte(part+`,"operationId":"op"`), 1)
		got, err := decode(candidate)
		if got != nil {
			t.Fatal("v1 accepted owner identity field")
		}
		code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	}
	for _, replacement := range []struct{ from, to string }{
		{`"workspaceId":`, `"computerGeneration":0,"workspaceId":`},
		{`"schemaVersion":1,"kind":"workspace_mutation"`, `"schemaVersion":2,"kind":"workspace_owner_mutation"`},
	} {
		got, err := decode(bytes.Replace(raw, []byte(replacement.from), []byte(replacement.to), 1))
		if got != nil {
			t.Fatal("v1 converted to owner format")
		}
		code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	}
}
