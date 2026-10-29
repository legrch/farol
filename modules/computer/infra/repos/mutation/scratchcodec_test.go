package mutation

import (
	"bytes"
	"context"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	"strings"
	"testing"
)

const scratchTestRun = "00000000-0000-4000-8000-000000000099"

func scratchPrepared(t *testing.T) *domain.State {
	t.Helper()
	_, _, old := ownerFixture(t)
	b := old.Binding()
	b.Identity.OperationID = scratchTestRun
	b.RelativePath = domain.ScratchPath(scratchTestRun)
	b.Scratch = domain.ScratchBinding{RunID: scratchTestRun, Root: "/work", RootIdentity: domain.DirectoryIdentity{Device: "7", Inode: "2"}, Leaf: b.RelativePath, ExpectedInventory: domain.EmptyScratchInventory}
	s, err := domain.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func scratchCompleted(t *testing.T, s *domain.State) *domain.State {
	t.Helper()
	next, err := s.Complete(domain.Receipt{Operation: domain.ScratchKind, RelativePath: s.Binding().RelativePath, Directory: domain.DirectoryIdentity{Device: "18446744073709551615", Inode: "9007199254740993"}})
	if err != nil {
		t.Fatal(err)
	}
	return next
}
func TestScratchCodecExactDurableIdentityAndNoHashSubstitution(t *testing.T) {
	s := scratchPrepared(t)
	final := scratchCompleted(t, s)
	raw, err := encode(final)
	want := `{"schemaVersion":7,"kind":"workspace_owner_selftest_scratch","record":{"identity":{"scope":"owner-settings","operationId":"` + scratchTestRun + `","ownerId":"owner","profileId":"profile","computerId":"computer"},"computerGeneration":7,"workspaceId":"work","relativePath":"` + s.Binding().RelativePath + `","requestDigest":"` + strings.Repeat("a", 64) + `","scratch":{"runId":"` + scratchTestRun + `","root":"/work","rootIdentity":{"device":"7","inode":"2"},"leaf":"` + s.Binding().RelativePath + `","expectedInventory":[]},"phase":"completed","outcome":{"receipt":{"kind":"workspace.selftest.scratch","operation":"self-test-scratch","relativePath":"` + s.Binding().RelativePath + `","directory":{"device":"18446744073709551615","inode":"9007199254740993"}}}}}` + "\n"
	if err != nil || string(raw) != want {
		t.Fatalf("%s %v", raw, err)
	}
	got, err := decode(raw)
	if err != nil || got.Binding() != final.Binding() || *got.Receipt() != *final.Receipt() {
		t.Fatal("identity lost", got, err)
	}
	key, _ := recordKey(s.Binding().Identity)
	_, _, owner := ownerFixture(t)
	b := owner.Binding()
	b.Identity = s.Binding().Identity
	oldKey, _ := recordKey(b.Identity)
	if key != oldKey {
		t.Fatal("new format created another attempt key")
	}
}
func TestScratchCodecAllPhasesAndUnknownIdentityRemainImmutable(t *testing.T) {
	s := scratchPrepared(t)
	dir := domain.DirectoryIdentity{Device: "7", Inode: "23"}
	for _, phase := range []string{"prepared", "completed", "failed", "unknown without identity", "unknown with identity"} {
		t.Run(phase, func(t *testing.T) {
			value := s
			var err error
			switch phase {
			case "completed":
				value = scratchCompleted(t, s)
			case "failed":
				value, err = s.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"})
			case "unknown without identity", "unknown with identity":
				f := domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"}
				if phase == "unknown with identity" {
					f.Directory = dir
				}
				value, err = s.Refuse(f)
			}
			if err != nil {
				t.Fatal(err)
			}
			raw, err := encode(value)
			if err != nil {
				t.Fatal(err)
			}
			out, err := decode(raw)
			if err != nil || out.Binding() != value.Binding() || out.Phase() != value.Phase() {
				t.Fatal("roundtrip", err)
			}
			again, err := encode(out)
			if err != nil || !bytes.Equal(raw, again) {
				t.Fatal("bytes changed")
			}
			if phase == "unknown with identity" {
				if out.Failure().Directory != dir {
					t.Fatal("unknown identity lost")
				}
				if _, err = out.Complete(*scratchCompleted(t, s).Receipt()); err == nil {
					t.Fatal("UNKNOWN upgraded to completed")
				}
			}
			if phase == "completed" {
				r := *out.Receipt()
				r.Directory.Inode = "24"
				changed, _ := domain.Restore(out.Binding(), domain.Completed, &r, nil)
				if _, err = out.Apply(*changed); err == nil {
					t.Fatal("identity rewritten")
				}
			}
		})
	}
}
func TestScratchCodecStrictCorruptionAndLegacySeparation(t *testing.T) {
	raw, _ := encode(scratchCompleted(t, scratchPrepared(t)))
	replacements := map[string][2]string{
		"version": {`"schemaVersion":7`, `"schemaVersion":8`}, "kind": {scratchKind, "workspace_owner_mutation"},
		"duplicate":      {`"schemaVersion":7`, `"schemaVersion":7,"schemaVersion":7`},
		"foreign field":  {`"expectedInventory":[]`, `"expectedInventory":[],"anything":true`},
		"null inventory": {`"expectedInventory":[]`, `"expectedInventory":null`}, "foreign inventory": {`"expectedInventory":[]`, `"expectedInventory":["foreign"]`},
		"numeric inode": {`"inode":"9007199254740993"`, `"inode":9007199254740993`}, "missing identity": {`,"directory":{"device":"18446744073709551615","inode":"9007199254740993"}`, ""},
		"hash instead": {`"directory":{"device":"18446744073709551615","inode":"9007199254740993"}`, `"afterSha256":"` + strings.Repeat("c", 64) + `"`},
		"overflow":     {`"9007199254740993"`, `"18446744073709551616"`}, "zero inode": {`"9007199254740993"`, `"0"`}, "leading zero": {`"9007199254740993"`, `"09007199254740993"`},
		"root inode": {`"inode":"2"`, `"inode":"-2"`}, "root path": {`"root":"/work"`, `"root":"/work/../other"`},
		"cross run":      {`"runId":"` + scratchTestRun + `"`, `"runId":"00000000-0000-4000-8000-000000000098"`},
		"task injection": {`"computerId":"computer"`, `"computerId":"computer","taskId":"fake"`},
		"file receipt":   {`"operation":"self-test-scratch"`, `"operation":"write"`},
	}
	for name, pair := range replacements {
		t.Run(name, func(t *testing.T) {
			candidate := bytes.Replace(raw, []byte(pair[0]), []byte(pair[1]), 1)
			if bytes.Equal(candidate, raw) {
				t.Fatal("mutation missed")
			}
			if got, err := decode(candidate); err == nil || got != nil {
				t.Fatal("corruption accepted")
			}
		})
	}
	_, _, v1 := fixture()
	v1raw, _ := encode(completed(t, v1))
	_, _, v2 := ownerFixture(t)
	v2raw, _ := encode(completed(t, v2))
	for _, old := range [][]byte{v1raw, v2raw} {
		for _, pair := range [][2]string{{`"operation":"write"`, `"operation":"self-test-scratch"`}, {`"replacements":0`, `"replacements":0,"directory":{"device":"7","inode":"23"}`}} {
			candidate := bytes.Replace(old, []byte(pair[0]), []byte(pair[1]), 1)
			if got, err := decode(candidate); err == nil || got != nil {
				t.Fatal("legacy format widened")
			}
		}
		got, err := decode(old)
		if err != nil {
			t.Fatal(err)
		}
		again, _ := encode(got)
		if !bytes.Equal(old, again) {
			t.Fatal("legacy bytes changed")
		}
	}
}
func TestScratchRepositoryRejoinAndUnknownNeverReadmit(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		r, m, _ := fixture()
		s := scratchPrepared(t)
		ctx := context.Background()
		if a, err := r.Admit(ctx, s); err != nil || a.Status != "admitted" {
			t.Fatal(a, err)
		}
		terminal := scratchCompleted(t, s)
		if unknown {
			var err error
			terminal, err = s.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace", Directory: terminal.Receipt().Directory})
			if err != nil {
				t.Fatal(err)
			}
		}
		if err := r.Save(ctx, terminal); err != nil {
			t.Fatal(err)
		}
		cold := newRepository(m)
		out, err := cold.Load(ctx, s.Binding().Identity)
		if err != nil || out.Phase() != terminal.Phase() {
			t.Fatal(out, err)
		}
		if unknown {
			if out.Failure().Directory != terminal.Failure().Directory {
				t.Fatal("unknown identity lost on disk")
			}
		} else if out.Receipt().Directory != terminal.Receipt().Directory {
			t.Fatal("created identity lost on disk")
		}
		admission, err := cold.Admit(ctx, s)
		if err != nil || admission.Status != "existing" {
			t.Fatal("readmitted", err)
		}
	}
}
func TestScratchFreshHistoryPreservesCanonicalRecords(t *testing.T) {
	s := scratchPrepared(t)
	for _, value := range []*domain.State{s, scratchCompleted(t, s)} {
		raw, _ := encode(value)
		key, _ := recordKey(value.Binding().Identity)
		before := bytes.Clone(raw)
		if _, err := qualifyFreshProcessHistory([]settledBytes{{key: key, raw: raw}}, SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}); err != nil {
			t.Fatal("valid scratch blocks cold observation", err)
		}
		if !bytes.Equal(raw, before) {
			t.Fatal("changed history")
		}
	}
}

func TestScratchHistoryInspectionPreservesEveryOriginalPhase(t *testing.T) {
	prepared := scratchPrepared(t)
	completed := scratchCompleted(t, prepared)
	unknown, err := prepared.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace", Directory: domain.DirectoryIdentity{Device: "7", Inode: "23"}})
	if err != nil {
		t.Fatal(err)
	}
	unknownNoDirectory, err := prepared.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	failed, err := prepared.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	selection := SettledSelection{OwnerID: prepared.Binding().Identity.OwnerID, ProfileID: prepared.Binding().Identity.ProfileID, ComputerID: prepared.Binding().Identity.ComputerID}
	for _, state := range []*domain.State{prepared, completed, failed, unknown, unknownNoDirectory} {
		raw, err := encode(state)
		if err != nil {
			t.Fatal(err)
		}
		key, err := recordKey(state.Binding().Identity)
		if err != nil {
			t.Fatal(err)
		}
		entry := []settledBytes{{key: key, raw: bytes.Clone(raw)}}
		if unknownProcess, err := qualifyFreshProcessHistory(entry, selection); err != nil || unknownProcess {
			t.Fatal("scratch changed fresh process observation", err)
		}
		if eligible, err := qualifyStagingHistory(entry, selection); err != nil || eligible != (state.Phase() == domain.Completed || state.Phase() == domain.Failed) {
			t.Fatal("scratch uncertainty did not fence staging", eligible, err)
		}
		if !bytes.Equal(entry[0].raw, raw) {
			t.Fatal("inspection changed original scratch bytes")
		}
		if state.Phase() == domain.Prepared || state.Phase() == domain.OutcomeUnknown {
			process := terminalValue(nil, nil)
			process.Intent.OperationID = "other-process"
			process.Intent.Seal.Write = true
			processRaw, chunks, err := encodeProcessTerminal(process)
			if err != nil || len(chunks) != 0 {
				t.Fatal(err)
			}
			processKey, err := recordKey(processIdentity(process.Scope, process.Intent.OperationID))
			if err != nil {
				t.Fatal(err)
			}
			mixed := []settledBytes{{key: processKey, raw: processRaw}, entry[0]}
			if eligible, err := qualifyStagingHistory(mixed, selection); err != nil || eligible {
				t.Fatal("mixed inventory hid scratch uncertainty", err)
			}
		}
	}
}
