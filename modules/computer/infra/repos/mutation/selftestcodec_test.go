package mutation

import (
	"bytes"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestCodecAndFreshHistoryPreserveUnknown(t *testing.T) {
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	key, err := selfTestKey(b.Identity)
	if err != nil {
		t.Fatal(err)
	}
	parentKey, _ := recordKey(b.Identity)
	if key == parentKey {
		t.Fatal("self-test collided with scratch key")
	}
	for _, phase := range []domain.Phase{domain.Prepared, domain.OutcomeUnknown, domain.Failed, domain.Completed} {
		var result *domain.SelfTestResult
		switch phase {
		case domain.OutcomeUnknown:
			result = &domain.SelfTestResult{Status: "unknown"}
		case domain.Failed:
			result = &domain.SelfTestResult{Status: "failed", Steps: []domain.SelfTestStep{{Name: "scratch", Status: "fail", Operation: b.Identity.OperationID}}}
		case domain.Completed:
			id := b.Identity.OperationID
			result = &domain.SelfTestResult{Status: "partial", Steps: []domain.SelfTestStep{{Name: "scratch", Status: "pass", Operation: id}, {Name: "write", Status: "pass", Operation: id + "-st1-write"}, {Name: "edit", Status: "pass", Operation: id + "-st1-edit"}, {Name: "mutation read", Status: "pass", Operation: id + "-st1-edit"}, {Name: "cleanup", Status: "pass", Operation: id}, {Name: "shell", Status: "pass", Operation: id + "-st1-quick"}, {Name: "shell cancel", Status: "pass", Operation: id + "-st1-cancel"}, {Name: "workspace reads", Status: "not_tested"}, {Name: "git and hooks", Status: "not_tested"}}}
		}
		original, err := domain.RestoreSelfTest(b, phase, result)
		if err != nil {
			t.Fatal(phase, err)
		}
		raw, err := encodeSelfTest(original)
		if err != nil {
			t.Fatal(err)
		}
		got, err := decodeSelfTest(raw)
		if err != nil || got.Binding() != b || got.Phase() != phase {
			t.Fatal("lost original facts", phase, err)
		}
		if _, err := decodeSelfTest(append(bytes.Clone(raw), ' ')); err == nil {
			t.Fatal("noncanonical accepted")
		}
		entries := []settledBytes{{key: key, raw: raw}}
		if _, err := qualifyFreshProcessHistory(entries, selection); err != nil {
			t.Fatal("fresh rejected retained history", phase, err)
		}
		eligible, err := qualifyStagingHistory(entries, selection)
		if err != nil || eligible != (phase == domain.Completed || phase == domain.Failed) {
			t.Fatal("staging classification", phase, eligible, err)
		}
		if _, err := qualifyFreshProcessHistory([]settledBytes{{key: parentKey, raw: raw}}, selection); err == nil {
			t.Fatal("wrong key accepted")
		}
	}
}
