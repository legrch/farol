package mutation

import "testing"

func TestSelfTestStateRetainsOriginalUnknown(t *testing.T) {
	b := SelfTestBinding{Identity: Identity{Scope: ScopeOwnerSettings, OperationID: "00000000-0000-4000-8000-000000000001", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	prepared, err := RestoreSelfTest(b, Prepared, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := &SelfTestResult{Status: "unknown", Steps: []SelfTestStep{{Name: "scratch", Status: "pass", Operation: b.Identity.OperationID}, {Name: "write", Status: "unknown", Operation: b.Identity.OperationID + "-st1-write", Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"}}}
	terminal, err := RestoreSelfTest(b, OutcomeUnknown, r)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := prepared.Apply(*terminal)
	if err != nil {
		t.Fatal(err)
	}
	r.Steps[1].Code = "tampered"
	if accepted.Result().Steps[1].Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
		t.Fatal("mutable input escaped")
	}
	observed := accepted.Result()
	observed.Steps[1].Status = "pass"
	if accepted.Result().Steps[1].Status != "unknown" {
		t.Fatal("mutable output escaped")
	}
	if _, err := accepted.Apply(*prepared); err == nil {
		t.Fatal("unknown was reopened")
	}
	changed := b
	changed.WorkspaceID = "other"
	other, _ := RestoreSelfTest(changed, OutcomeUnknown, &SelfTestResult{Status: "unknown"})
	if _, err := prepared.Apply(*other); err == nil {
		t.Fatal("changed binding accepted")
	}
}

func TestSelfTestStateRejectsForgedAndPrivateContent(t *testing.T) {
	b := SelfTestBinding{Identity: Identity{Scope: ScopeOwnerSettings, OperationID: "00000000-0000-4000-8000-000000000001", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	for _, r := range []SelfTestResult{
		{Status: "partial"},
		{Status: "unknown", Steps: []SelfTestStep{{Name: "scratch", Status: "unknown", Operation: "different"}}},
		{Status: "unknown", Steps: []SelfTestStep{{Name: "scratch", Status: "unknown", Operation: b.Identity.OperationID, Code: "private value"}}},
		{Status: "unknown", Steps: []SelfTestStep{{Name: "write", Status: "unknown", Operation: b.Identity.OperationID + "-st1-write"}}},
	} {
		phase := OutcomeUnknown
		if r.Status == "partial" {
			phase = Completed
		}
		if _, err := RestoreSelfTest(b, phase, &r); err == nil {
			t.Fatal("forged result accepted", r)
		}
	}
}
