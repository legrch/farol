package mutation

import "testing"

func TestSelfTestMarkerNeverSettlesUnknownOrAnotherOperation(t *testing.T) {
	b := SelfTestBinding{Identity: Identity{Scope: ScopeOwnerSettings, OperationID: "00000000-0000-4000-8000-000000000001", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	marker, err := RestoreSelfTestMarker(b, SelfTestMarkerSelected)
	if err != nil {
		t.Fatal(err)
	}
	settling, err := marker.BeginSettlement()
	if err != nil || marker.Phase() != SelfTestMarkerSelected {
		t.Fatal("selection changed", err)
	}
	if _, err := settling.BeginSettlement(); err == nil {
		t.Fatal("repeated settlement intent")
	}
	unknown, err := RestoreSelfTest(b, OutcomeUnknown, &SelfTestResult{Status: "unknown"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := settling.ConfirmSettlement(unknown); err == nil {
		t.Fatal("unknown settled")
	}
	other := b
	other.WorkspaceID = "elsewhere"
	foreign, err := RestoreSelfTest(other, Failed, &SelfTestResult{Status: "failed", Steps: []SelfTestStep{{Name: "scratch", Status: "fail", Operation: b.Identity.OperationID}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := settling.ConfirmSettlement(foreign); err == nil {
		t.Fatal("foreign result settled")
	}
	failed, err := RestoreSelfTest(b, Failed, &SelfTestResult{Status: "failed", Steps: []SelfTestStep{{Name: "scratch", Status: "fail", Operation: b.Identity.OperationID}}})
	if err != nil {
		t.Fatal(err)
	}
	settled, err := settling.ConfirmSettlement(failed)
	if err != nil || settled.Binding() != b || settled.Phase() != SelfTestMarkerSettled {
		t.Fatal("original terminal not settled", err)
	}
	if _, err := settled.BeginSettlement(); err == nil {
		t.Fatal("settled marker reopened")
	}
}

func TestSelfTestMarkerRestoreRejectsInvalidState(t *testing.T) {
	if _, err := RestoreSelfTestMarker(SelfTestBinding{}, SelfTestMarkerSelected); err == nil {
		t.Fatal("invalid binding accepted")
	}
	b := SelfTestBinding{Identity: Identity{Scope: ScopeOwnerSettings, OperationID: "00000000-0000-4000-8000-000000000001", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	if _, err := RestoreSelfTestMarker(b, "unknown"); err == nil {
		t.Fatal("invalid phase accepted")
	}
}
