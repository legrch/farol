package authority

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func ownerFixture() Approval {
	return Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7,
		Workspaces:   []ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: ReadAccess, RootIdentity: RootIdentity{Device: "12", Inode: "34"}}},
		Capabilities: []Capability{List}, Network: NoNetwork, Commands: NoCommands, ExpiresAt: time.UnixMilli(1800000060000)}
}
func TestAuthorizeOwnerList(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	cases := []struct {
		name, code, path string
		change           func(*Approval)
	}{
		{"approved", "", "/work/folder", nil},
		{"list cannot borrow read", "AUTHORITY_CAPABILITY_DENIED", "/work", func(a *Approval) { a.Capabilities = []Capability{Read} }},
		{"expiry exact", "AUTHORITY_EXPIRED", "/work", func(a *Approval) { a.ExpiresAt = now }},
		{"exclusion alias", "AUTHORITY_PATH_DENIED", "/work/CAFE/child", func(a *Approval) { a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/Café"}} }},
		{"positive root stays exact", "AUTHORITY_PATH_DENIED", "/WORK", nil},
		{"outside", "AUTHORITY_PATH_DENIED", "/work-other", nil},
		{"traversal", "COMPUTER_PATH_INVALID", "/work/../other", nil},
		{"backslash", "COMPUTER_PATH_INVALID", "/work/alias\\file", nil},
		{"invalid utf8", "COMPUTER_PATH_INVALID", "/work/\xff", nil},
		{"empty owner", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.OwnerID = "" }},
		{"empty computer", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.ComputerID = "" }},
		{"duplicate cap", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Capabilities = []Capability{List, List} }},
		{"unknown cap", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Capabilities = []Capability{List, "arbitrary"} }},
		{"root slash", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Workspaces[0].Root = "/" }},
		{"invalid root", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Workspaces[0].Root = "/work/.." }},
		{"invalid access", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Workspaces[0].Access = "unknown" }},
		{"invalid device", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Workspaces[0].RootIdentity.Device = "private" }},
		{"overflow inode", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Workspaces[0].RootIdentity.Inode = "18446744073709551616" }},
		{"invalid exclusion", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.ExcludedPaths = []Exclusion{{WorkspaceID: "other", Path: "/other"}} }},
		{"duplicate exclusion", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) {
			e := Exclusion{WorkspaceID: "work", Path: "/work/secret"}
			a.ExcludedPaths = []Exclusion{e, e}
		}},
		{"private provenance", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) {
			a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/secret", RestrictionSource: "private"}}
		}},
		{"invalid network", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Network = "unknown" }},
		{"invalid commands", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.Commands = "unknown" }},
		{"zero expiry", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.ExpiresAt = time.Time{} }},
		{"fractional expiry", "COMPUTER_APPROVAL_INVALID", "/work", func(a *Approval) { a.ExpiresAt = a.ExpiresAt.Add(time.Nanosecond) }},
		{"long component", "COMPUTER_PATH_INVALID", "/work/" + strings.Repeat("x", 256), nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := ownerFixture()
			if tc.change != nil {
				tc.change(&a)
			}
			err := AuthorizeOwnerList(a, "work", tc.path, now)
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			var f *Failure
			if !errors.As(err, &f) || f.Code != tc.code || f.Source != "computer-approval" {
				t.Fatalf("%v, want %s", err, tc.code)
			}
		})
	}
	for _, invalid := range []time.Time{time.Time{}, time.UnixMilli(9007199254740992)} {
		if err := AuthorizeOwnerList(ownerFixture(), "work", "/work", invalid); err == nil {
			t.Fatal("invalid clock authorized")
		}
	}
}
