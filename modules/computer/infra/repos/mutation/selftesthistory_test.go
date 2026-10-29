package mutation

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

type historyMemory struct {
	*memory
	keysCalls      int
	changeOnSecond bool
	err            error
}

func TestSelfTestHistoryRejectsUnsupportedAndChangingInventory(t *testing.T) {
	for _, mode := range []string{"unsupported", "wrong-key", "changed-bytes", "excess"} {
		t.Run(mode, func(t *testing.T) {
			_, original, _ := fixture()
			disk := &historyMemory{memory: original}
			binding := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
			record, err := domain.RestoreSelfTest(binding, domain.OutcomeUnknown, &domain.SelfTestResult{Status: "unknown"})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := encodeSelfTest(record)
			if err != nil {
				t.Fatal(err)
			}
			key, _ := selfTestKey(binding.Identity)
			switch mode {
			case "unsupported":
				disk.files[strings.Repeat("a", 64)+".json"] = []byte(`{"schemaVersion":77,"kind":"unknown","record":{}}`)
			case "wrong-key":
				key = strings.Repeat("b", 64) + ".json"
			case "changed-bytes":
				disk.afterRead = func() { disk.afterRead = nil; disk.files[key] = append(bytes.Clone(raw), ' ') }
			case "excess":
				for i := 0; i < maxSelfTestInventory; i++ {
					disk.files[strings.Repeat("a", 64)+string(rune(i))] = []byte("x")
				}
			}
			disk.files[key] = bytes.Clone(raw)
			entries, err := newRepository(disk).ListSelfTests(context.Background(), "owner", "profile", "computer")
			if err == nil || entries != nil {
				t.Fatal("unqualified history accepted", entries, err)
			}
			if disk.creates != 0 || disk.replaces != 0 {
				t.Fatal("history mutated")
			}
		})
	}
}

func (m *historyMemory) keys() ([]string, error) {
	m.keysCalls++
	if m.err != nil {
		return nil, m.err
	}
	keys := make([]string, 0, len(m.files))
	for key := range m.files {
		keys = append(keys, key)
	}
	if m.changeOnSecond && m.keysCalls == 2 {
		keys = append(keys, "unexpected")
	}
	slices.Sort(keys)
	return keys, nil
}

func TestSelfTestHistoryIsReadOnlyAndRetainsUnknown(t *testing.T) {
	for _, mode := range []string{"stable", "changed", "unavailable", "corrupt", "other-owner"} {
		t.Run(mode, func(t *testing.T) {
			_, original, _ := fixture()
			disk := &historyMemory{memory: original}
			b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
			if mode == "other-owner" {
				b.Identity.OwnerID = "other"
			}
			record, err := domain.RestoreSelfTest(b, domain.OutcomeUnknown, &domain.SelfTestResult{Status: "unknown"})
			if err != nil {
				t.Fatal(err)
			}
			raw, err := encodeSelfTest(record)
			if err != nil {
				t.Fatal(err)
			}
			key, _ := selfTestKey(b.Identity)
			if mode == "corrupt" {
				raw = []byte("{")
			}
			disk.files[key] = bytes.Clone(raw)
			disk.changeOnSecond = mode == "changed"
			if mode == "unavailable" {
				disk.err = errors.New("unavailable")
			}
			entries, err := newRepository(disk).ListSelfTests(context.Background(), "owner", "profile", "computer")
			if mode == "stable" {
				if err != nil || len(entries) != 1 || entries[0].Binding != b || entries[0].Phase != domain.OutcomeUnknown {
					t.Fatal("history lost", entries, err)
				}
			} else if err == nil || entries != nil {
				t.Fatal("unqualified history accepted", entries, err)
			}
			if !bytes.Equal(disk.files[key], raw) || disk.creates != 0 || disk.replaces != 0 {
				t.Fatal("history mutated")
			}
		})
	}
}
