package mutation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// fixture uses injected memory storage only; no native constructor or effects.
func connectorV3Fixture(t *testing.T) (*Repository, *memory, *domain.State) {
	t.Helper()
	r, m, _ := fixture()
	b := domain.Binding{
		Identity:           domain.Identity{Scope: domain.ScopeConnector, OperationID: "op", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"},
		ComputerGeneration: 7, WorkspaceID: "work", RelativePath: "file.md", RequestDigest: strings.Repeat("a", 64),
		Connector: domain.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2,
			SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", CallID: "call", TaskEpoch: 3, Generation: 4, Operation: domain.WriteKind},
	}
	s, err := domain.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	return r, m, s
}

func TestConnectorV3CanonicalFixtureAndLegacyNamespaces(t *testing.T) {
	_, _, connector := connectorV3Fixture(t)
	_, _, task := fixture()
	_, _, owner := ownerFixture(t)
	digest := strings.Repeat("a", 64)
	cases := []struct {
		name          string
		state         *domain.State
		raw, keyInput string
	}{
		{"v1", task, `{"schemaVersion":1,"kind":"workspace_mutation","record":{"identity":{"operationId":"op","ownerId":"owner","sessionId":"session","taskId":"task","taskEpoch":7,"participantId":"participant"},"workspaceId":"work","requestDigest":"` + digest + `","phase":"prepared","outcome":null}}` + "\n", `["op","owner","session","task",7,"participant"]`},
		{"v2", owner, `{"schemaVersion":2,"kind":"workspace_owner_mutation","record":{"identity":{"scope":"owner-settings","operationId":"op","ownerId":"owner","profileId":"profile","computerId":"computer"},"computerGeneration":7,"workspaceId":"work","relativePath":"file.md","requestDigest":"` + digest + `","phase":"prepared","outcome":null}}` + "\n", `["owner-settings-v2","op","owner","profile","computer"]`},
		{"v3", connector, `{"schemaVersion":3,"kind":"workspace_connector_mutation","record":{"identity":{"scope":"external-connector","operationId":"op","ownerId":"owner","profileId":"profile","computerId":"computer"},"computerGeneration":7,"workspaceId":"work","relativePath":"file.md","origin":{"buildId":"build","backendGeneration":"backend","runtimeId":"runtime","connectorGeneration":2,"sessionId":"session","taskId":"task","participantId":"participant","turnId":"turn","callId":"call","taskEpoch":3,"generation":4,"operation":"write"},"requestDigest":"` + digest + `","phase":"prepared","outcome":null}}` + "\n", `["external-connector-v3","op","owner","profile","computer"]`},
	}
	keys := make(map[string]bool)
	for _, v := range cases {
		t.Run(v.name, func(t *testing.T) {
			raw, err := encode(v.state)
			if err != nil || string(raw) != v.raw {
				t.Fatalf("canonical bytes changed: %q %v", raw, err)
			}
			got, err := decode([]byte(v.raw))
			if err != nil || got == nil || got.Binding() != v.state.Binding() || got.Phase() != domain.Prepared {
				t.Fatal("canonical fixture rejected", err)
			}
			key, err := recordKey(v.state.Binding().Identity)
			hash := sha256.Sum256([]byte(v.keyInput))
			if err != nil || key != hex.EncodeToString(hash[:])+".json" {
				t.Fatalf("wrong stable key: %q %v", key, err)
			}
			if keys[key] {
				t.Fatal("v1/v2/v3 namespaces overlap")
			}
			keys[key] = true
		})
	}
	base, err := recordKey(connector.Binding().Identity)
	if err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*domain.Identity){
		"operation": func(i *domain.Identity) { i.OperationID += "2" },
		"owner":     func(i *domain.Identity) { i.OwnerID += "2" },
		"profile":   func(i *domain.Identity) { i.ProfileID += "2" },
		"computer":  func(i *domain.Identity) { i.ComputerID += "2" },
	} {
		t.Run(name, func(t *testing.T) {
			i := connector.Binding().Identity
			change(&i)
			key, err := recordKey(i)
			if err != nil || key == base {
				t.Fatal("stable identity dimension omitted", err)
			}
		})
	}
}

func TestConnectorV3RoundTripPhases(t *testing.T) {
	_, _, original := connectorV3Fixture(t)
	for _, kind := range []domain.Kind{domain.WriteKind, domain.EditKind} {
		t.Run(string(kind), func(t *testing.T) {
			b := original.Binding()
			b.Connector.Operation = kind
			prepared, err := domain.NewPrepared(b)
			if err != nil {
				t.Fatal(err)
			}
			before := strings.Repeat("c", 64)
			receipt := domain.Receipt{Operation: kind, RelativePath: b.RelativePath, Bytes: 12, AfterSHA256: strings.Repeat("b", 64)}
			if kind == domain.EditKind {
				receipt.BeforeSHA256 = &before
				receipt.Replacements = 1
			}
			final, err := prepared.Complete(receipt)
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
			for _, state := range []*domain.State{prepared, final, failed, unknown} {
				t.Run(string(state.Phase()), func(t *testing.T) {
					raw, err := encode(state)
					if err != nil {
						t.Fatal(err)
					}
					got, err := decode(raw)
					if err != nil || got == nil || got.Binding() != b || got.Phase() != state.Phase() {
						t.Fatal("roundtrip changed binding/phase", err)
					}
					if _, err := state.Apply(*got); err != nil {
						t.Fatal("roundtrip changed receipt/failure", err)
					}
					again, err := encode(got)
					if err != nil || !bytes.Equal(raw, again) {
						t.Fatal("roundtrip changed canonical bytes", err)
					}
				})
			}
		})
	}
}

func TestConnectorV3RejectsMissingMixedAndCorruptRaw(t *testing.T) {
	_, _, s := connectorV3Fixture(t)
	raw, err := encode(s)
	if err != nil {
		t.Fatal(err)
	}
	origin := `"origin":{"buildId":"build","backendGeneration":"backend","runtimeId":"runtime","connectorGeneration":2,"sessionId":"session","taskId":"task","participantId":"participant","turnId":"turn","callId":"call","taskEpoch":3,"generation":4,"operation":"write"}`
	for name, pair := range map[string][2]string{
		"missing-origin":            {origin + ",", ""},
		"null-origin":               {origin, `"origin":null`},
		"empty-origin":              {origin, `"origin":{}`},
		"missing-origin-field":      {`"callId":"call",`, ""},
		"empty-id":                  {`"callId":"call"`, `"callId":""`},
		"oversized-id":              {`"buildId":"build"`, `"buildId":"` + strings.Repeat("x", 121) + `"`},
		"zero-connector-generation": {`"connectorGeneration":2`, `"connectorGeneration":0`},
		"unsafe-number":             {`"taskEpoch":3`, `"taskEpoch":9007199254740992`},
		"fraction":                  {`"generation":4`, `"generation":4.5`},
		"unsupported-operation":     {`"operation":"write"`, `"operation":"read"`},
		"legacy-session":            {`"scope":"external-connector"`, `"scope":"external-connector","sessionId":"session"`},
		"legacy-task":               {`"scope":"external-connector"`, `"scope":"external-connector","taskId":"task"`},
		"legacy-epoch":              {`"scope":"external-connector"`, `"scope":"external-connector","taskEpoch":0`},
		"legacy-participant":        {`"scope":"external-connector"`, `"scope":"external-connector","participantId":"participant"`},
		"wrong-scope":               {`"scope":"external-connector"`, `"scope":"owner-settings"`},
		"wrong-version":             {`"schemaVersion":3`, `"schemaVersion":2`},
		"wrong-kind":                {`"kind":"workspace_connector_mutation"`, `"kind":"workspace_owner_mutation"`},
		"unknown-origin-field":      {`"callId":"call"`, `"callId":"call","extra":true`},
		"duplicate":                 {`"callId":"call"`, `"callId":"call","callId":"call"`},
		"surrogate":                 {`"callId":"call"`, `"callId":"\ud800"`},
	} {
		t.Run(name, func(t *testing.T) {
			if !bytes.Contains(raw, []byte(pair[0])) {
				t.Fatal("corruption target absent")
			}
			got, err := decode(bytes.Replace(raw, []byte(pair[0]), []byte(pair[1]), 1))
			if got != nil {
				t.Fatal("corrupt record returned")
			}
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	for name, candidate := range map[string][]byte{
		"no-newline":     bytes.TrimSuffix(raw, []byte("\n")),
		"trailing-value": append(bytes.Clone(raw), []byte("{}")...),
		"invalid-utf8":   {0xff},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := decode(candidate)
			if got != nil {
				t.Fatal("raw corruption returned")
			}
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	// A completed record must bind both receipt operation and target.
	final := completed(t, s)
	finalRaw, err := encode(final)
	if err != nil {
		t.Fatal(err)
	}
	for name, pair := range map[string][2]string{
		"receipt-kind": {`"kind":"workspace.mutation","operation":"write"`, `"kind":"workspace.mutation","operation":"edit"`},
		"receipt-path": {`"operation":"write","relativePath":"file.md"`, `"operation":"write","relativePath":"other.md"`},
	} {
		t.Run(name, func(t *testing.T) {
			if !bytes.Contains(finalRaw, []byte(pair[0])) {
				t.Fatal("receipt corruption target absent")
			}
			got, err := decode(bytes.Replace(finalRaw, []byte(pair[0]), []byte(pair[1]), 1))
			if got != nil {
				t.Fatal("mismatched receipt returned")
			}
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	_, _, task := fixture()
	_, _, owner := ownerFixture(t)
	for _, legacy := range []*domain.State{task, owner} {
		legacyRaw, err := encode(legacy)
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range []string{origin, `"origin":{}`, `"origin":null`} {
			candidate := bytes.Replace(legacyRaw, []byte(`"requestDigest":`), []byte(value+`,"requestDigest":`), 1)
			got, err := decode(candidate)
			if got != nil {
				t.Fatal("legacy byte contract accepted origin")
			}
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		}
	}
}

func TestConnectorV3SameKeyChangedOriginPublishesNothing(t *testing.T) {
	for name, change := range map[string]func(*domain.Binding){
		"build":                func(b *domain.Binding) { b.Connector.BuildID += "2" },
		"backend":              func(b *domain.Binding) { b.Connector.BackendGeneration += "2" },
		"runtime":              func(b *domain.Binding) { b.Connector.RuntimeID += "2" },
		"connector-generation": func(b *domain.Binding) { b.Connector.ConnectorGeneration++ },
		"session":              func(b *domain.Binding) { b.Connector.SessionID += "2" },
		"task":                 func(b *domain.Binding) { b.Connector.TaskID += "2" },
		"participant":          func(b *domain.Binding) { b.Connector.ParticipantID += "2" },
		"turn":                 func(b *domain.Binding) { b.Connector.TurnID += "2" },
		"call":                 func(b *domain.Binding) { b.Connector.CallID += "2" },
		"epoch":                func(b *domain.Binding) { b.Connector.TaskEpoch++ },
		"generation":           func(b *domain.Binding) { b.Connector.Generation++ },
		"operation":            func(b *domain.Binding) { b.Connector.Operation = domain.EditKind },
	} {
		t.Run(name, func(t *testing.T) {
			r, m, s := connectorV3Fixture(t)
			admitted(t, r, s)
			key, err := recordKey(s.Binding().Identity)
			if err != nil {
				t.Fatal(err)
			}
			previous := bytes.Clone(m.files[key])
			creates, replaces := m.creates, m.replaces
			b := s.Binding()
			change(&b)
			changed, err := domain.NewPrepared(b)
			if err != nil {
				t.Fatal(err)
			}
			changedKey, err := recordKey(changed.Binding().Identity)
			if err != nil || changedKey != key {
				t.Fatal("origin acquired another key", err)
			}
			a, err := r.Admit(context.Background(), changed)
			if err != nil || a.Status != port.MutationExisting || a.Record == nil || a.Record.Binding() != s.Binding() || a.Record.Phase() != domain.Prepared {
				t.Fatal("changed origin admitted or replaced existing record", err)
			}
			recovery, err := a.Record.Recover(b)
			var conflict *authority.Failure
			if recovery != nil || !errors.As(err, &conflict) || conflict.Code != "COMPUTER_MUTATION_OPERATION_CONFLICT" || conflict.Source != "operation-store" || conflict.Retry != "never" {
				t.Fatal("changed origin accepted in recovery", err)
			}
			receipt := domain.Receipt{Operation: b.Connector.Operation, RelativePath: b.RelativePath, Bytes: 12, AfterSHA256: strings.Repeat("b", 64)}
			if receipt.Operation == domain.EditKind {
				receipt.Replacements = 1
			}
			terminal, err := changed.Complete(receipt)
			if err != nil {
				t.Fatal(err)
			}
			code(t, r.Save(context.Background(), terminal), "WORKSPACE_MUTATION_BINDING_MISMATCH")
			loaded, err := r.Load(context.Background(), b.Identity)
			if err != nil || loaded == nil || loaded.Binding() != s.Binding() {
				t.Fatal("original origin lost", err)
			}
			if m.creates != creates || m.replaces != replaces || len(m.files) != 1 || !bytes.Equal(previous, m.files[key]) || r.fenced {
				t.Fatal("origin conflict published, repaired or fenced storage")
			}
		})
	}
}
