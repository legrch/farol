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

func TestSelfTestPlanVersionsKeepDistinctHistory(t *testing.T) {
	b := SelfTestBinding{Identity: Identity{Scope: ScopeOwnerSettings, OperationID: "00000000-0000-4000-8000-000000000001", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	id := b.Identity.OperationID
	result := &SelfTestResult{Status: "partial", Steps: []SelfTestStep{
		{Name: "scratch", Status: "pass", Operation: id},
		{Name: "write", Status: "pass", Operation: id + "-st2-write"},
		{Name: "edit", Status: "pass", Operation: id + "-st2-edit"},
		{Name: "mutation read", Status: "pass", Operation: id + "-st2-edit"},
		{Name: "catalogue", Status: "pass", Operation: id + "-st2-catalogue"},
		{Name: "bootstrap", Status: "pass", Operation: id + "-st2-bootstrap"},
		{Name: "list", Status: "pass", Operation: id + "-st2-list"},
		{Name: "read", Status: "pass", Operation: id + "-st2-read"},
		{Name: "search", Status: "pass", Operation: id + "-st2-search"},
		{Name: "cleanup", Status: "pass", Operation: id},
		{Name: "shell", Status: "pass", Operation: id + "-st2-quick"},
		{Name: "shell cancel", Status: "pass", Operation: id + "-st2-cancel", CancelOperation: id + "-st2-cancel-op"},
		{Name: "directory search", Status: "not_tested"},
		{Name: "git and hooks", Status: "not_tested"},
	}}
	if _, err := RestoreSelfTest(b, Completed, result); err != nil {
		t.Fatal(err)
	}
	oldSteps := append([]SelfTestStep(nil), result.Steps[:12]...)
	oldSteps = append(oldSteps, result.Steps[13])
	oldState, err := RestoreSelfTest(b, Completed, &SelfTestResult{Status: "partial", Steps: oldSteps})
	if err != nil || len(oldState.Result().Steps) != 13 || oldState.Result().Steps[12].Name != "git and hooks" {
		t.Fatal("original version two history changed", err)
	}
	for failure := 4; failure <= 8; failure++ {
		for _, cleanup := range []string{"pass", "fail", "unknown"} {
			steps := append([]SelfTestStep(nil), result.Steps[:10]...)
			steps[failure].Status, steps[failure].Code = "fail", "AUTHORITY_CAPABILITY_DENIED"
			for i := failure + 1; i < 9; i++ {
				steps[i].Status = "not_tested"
			}
			steps[9].Status = cleanup
			phase, status := Failed, "failed"
			if cleanup == "unknown" {
				phase, status = OutcomeUnknown, "unknown"
			}
			if _, err := RestoreSelfTest(b, phase, &SelfTestResult{Status: status, Steps: steps}); err != nil {
				t.Fatal("failed read history lost", failure, cleanup, err)
			}
			steps[failure+1].Status = "pass" // Skipped checks cannot be forged as executed.
			if failure < 8 {
				if _, err := RestoreSelfTest(b, phase, &SelfTestResult{Status: status, Steps: steps}); err == nil {
					t.Fatal("check ran after refusal", failure)
				}
			}
		}
	}
	old := b
	old.Version = 1
	if _, err := RestoreSelfTest(old, Completed, result); err == nil {
		t.Fatal("version 2 history interpreted as version 1")
	}
	result.Steps[4].Status = "unknown"
	if _, err := RestoreSelfTest(b, Completed, result); err == nil {
		t.Fatal("unknown read presented as completed")
	}
	result.Steps = result.Steps[:5]
	result.Status = "unknown"
	if _, err := RestoreSelfTest(b, OutcomeUnknown, result); err != nil {
		t.Fatal("interrupted read lost", err)
	}
	result.Steps[4].Operation = id + "-st1-catalogue"
	if _, err := RestoreSelfTest(b, OutcomeUnknown, result); err == nil {
		t.Fatal("different plan identity accepted")
	}
}

func TestSelfTestVersionThreeBindsDirectoryCheckAndPreservesUnknown(t *testing.T) {
	b := SelfTestBinding{Identity: Identity{Scope: ScopeOwnerSettings, OperationID: "00000000-0000-4000-8000-000000000001", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 3}
	id := b.Identity.OperationID
	steps := []SelfTestStep{
		{Name: "scratch", Status: "pass", Operation: id},
		{Name: "write", Status: "pass", Operation: id + "-st3-write"},
		{Name: "edit", Status: "pass", Operation: id + "-st3-edit"},
		{Name: "mutation read", Status: "pass", Operation: id + "-st3-edit"},
		{Name: "catalogue", Status: "pass", Operation: id + "-st3-catalogue"},
		{Name: "bootstrap", Status: "pass", Operation: id + "-st3-bootstrap"},
		{Name: "list", Status: "pass", Operation: id + "-st3-list"},
		{Name: "read", Status: "pass", Operation: id + "-st3-read"},
		{Name: "search", Status: "pass", Operation: id + "-st3-search"},
		{Name: "directory search", Status: "pass", Operation: id + "-st3-directory-search"},
		{Name: "cleanup", Status: "pass", Operation: id},
		{Name: "shell", Status: "pass", Operation: id + "-st3-quick"},
		{Name: "shell cancel", Status: "pass", Operation: id + "-st3-cancel", CancelOperation: id + "-st3-cancel-op"},
		{Name: "git and hooks", Status: "not_tested"},
	}
	if _, err := RestoreSelfTest(b, Completed, &SelfTestResult{Status: "partial", Steps: steps}); err != nil {
		t.Fatal("valid v3 result rejected", err)
	}
	old := b
	old.Version = 2
	if _, err := RestoreSelfTest(old, Completed, &SelfTestResult{Status: "partial", Steps: steps}); err == nil {
		t.Fatal("v3 history interpreted as v2")
	}
	interrupted := append([]SelfTestStep(nil), steps[:10]...)
	interrupted[9].Status = "unknown"
	original, err := RestoreSelfTest(b, OutcomeUnknown, &SelfTestResult{Status: "unknown", Steps: interrupted})
	if err != nil || original.Result().Steps[9].Status != "unknown" {
		t.Fatal("interrupted directory search not retained", err)
	}
	interrupted[9].Operation = id + "-st2-search"
	if _, err := RestoreSelfTest(b, OutcomeUnknown, &SelfTestResult{Status: "unknown", Steps: interrupted}); err == nil {
		t.Fatal("foreign operation identity accepted")
	}
	for failure := 4; failure <= 9; failure++ {
		failureSteps := append([]SelfTestStep(nil), steps[:11]...)
		failureSteps[failure].Status = "fail"
		for i := failure + 1; i < 10; i++ {
			failureSteps[i].Status = "not_tested"
		}
		if _, err := RestoreSelfTest(b, Failed, &SelfTestResult{Status: "failed", Steps: failureSteps}); err != nil {
			t.Fatal("failure and cleanup not retained", failure, err)
		}
		failureSteps[10].Status = "unknown"
		if _, err := RestoreSelfTest(b, OutcomeUnknown, &SelfTestResult{Status: "unknown", Steps: failureSteps}); err != nil {
			t.Fatal("unknown cleanup not retained", failure, err)
		}
	}
}
