package authority

import (
	"testing"
	"time"
)

// Pure retained-value acceptance only; no producer or execution is activated.
func TestReaderBridgeNoAccessApprovalCannotAuthorizeOwnerEffects(t *testing.T) {
	a := ownerFixture()
	a.Workspaces, a.Capabilities = nil, nil
	if !ownerApprovalValid(a) || !a.NoAccess() {
		t.Fatal("retained no-access value rejected")
	}
	for _, authorize := range []func(Approval, string, string, time.Time) error{AuthorizeOwnerList, AuthorizeOwnerRead, AuthorizeOwnerWrite} {
		if err := authorize(a, "work", "/work/file", time.UnixMilli(1800000000000)); err == nil {
			t.Fatal("retained no-access proof authorized an effect")
		}
	}
	for name, change := range map[string]func(*Approval){
		"capability":  func(a *Approval) { a.Capabilities = []Capability{Read} },
		"network":     func(a *Approval) { a.Network = ApprovedNetwork },
		"commands":    func(a *Approval) { a.Commands = VerificationCommands },
		"exclusion":   func(a *Approval) { a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work"}} },
		"generation":  func(a *Approval) { a.Generation = 0 },
		"file policy": func(a *Approval) { a.FilePolicy = "unknown" },
		"expiry":      func(a *Approval) { a.ExpiresAt = time.Time{} },
	} {
		t.Run(name, func(t *testing.T) {
			changed := a.Clone()
			change(&changed)
			if ownerApprovalValid(changed) {
				t.Fatal("malformed no-access approval accepted")
			}
		})
	}
}
func TestReaderBridgeDoesNotEnableNoAccessRefresh(t *testing.T) {
	pin, stored, binding, witness, now := refreshFixture()
	for _, a := range []*Approval{&pin, &stored, &witness.Approval} {
		a.Workspaces, a.Capabilities, a.ExcludedPaths = nil, nil, nil
	}
	if plan, err := PlanApprovalRefresh(pin, stored, binding, witness, now); err == nil || plan != nil {
		t.Fatal("reader bridge activated no-access renewal")
	}
}
