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

func TestAuthorizeOwnerRead(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	a := ownerFixture()
	if err := AuthorizeOwnerRead(a, "work", "/work/file.txt", now); err == nil {
		t.Fatal("List implied Read")
	}
	a.Capabilities = []Capability{Read}
	if err := AuthorizeOwnerRead(a, "work", "/work/file.txt", now); err != nil {
		t.Fatal(err)
	}
	if err := AuthorizeOwnerList(a, "work", "/work", now); err == nil {
		t.Fatal("Read implied List")
	}
	// Both entrypoints must enforce the same owner validation and path policy.
	changes := []struct {
		name   string
		change func(*Approval)
		path   string
		now    time.Time
	}{
		{"owner", func(a *Approval) { a.OwnerID = "" }, "/work/file", now},
		{"computer", func(a *Approval) { a.ComputerID = "" }, "/work/file", now},
		{"root", func(a *Approval) { a.Workspaces[0].Root = "/" }, "/work/file", now},
		{"root identity", func(a *Approval) { a.Workspaces[0].RootIdentity.Device = "private" }, "/work/file", now},
		{"git metadata", func(a *Approval) {
			a.Workspaces[0].GitMetadata = &GitMetadata{GitDirectory: "relative", CommonDirectory: "/work/.git"}
		}, "/work/file", now},
		{"duplicates", func(a *Approval) { a.Workspaces = append(a.Workspaces, a.Workspaces[0]) }, "/work/file", now},
		{"expiry", func(a *Approval) { a.ExpiresAt = now }, "/work/file", now},
		{"fractional expiry", func(a *Approval) { a.ExpiresAt = a.ExpiresAt.Add(time.Nanosecond) }, "/work/file", now},
		{"exclusion alias", func(a *Approval) { a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/Café"}} }, "/work/CAFE/file", now},
		{"provenance", func(a *Approval) {
			a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/secret", RestrictionSource: "private"}}
		}, "/work/file", now},
		{"network", func(a *Approval) { a.Network = "unknown" }, "/work/file", now},
		{"commands", func(a *Approval) { a.Commands = "unknown" }, "/work/file", now},
		{"outside", nil, "/other/file", now},
		{"traversal", nil, "/work/../file", now},
		{"invalid utf8", nil, "/work/\xff", now},
		{"zero clock", nil, "/work/file", time.Time{}},
		{"future clock", nil, "/work/file", time.UnixMilli(9007199254740992)},
	}
	for _, tc := range changes {
		t.Run(tc.name, func(t *testing.T) {
			a := ownerFixture()
			if tc.change != nil {
				tc.change(&a)
			}
			listErr := AuthorizeOwnerList(a, "work", tc.path, tc.now)
			a.Capabilities = []Capability{Read}
			readErr := AuthorizeOwnerRead(a, "work", tc.path, tc.now)
			var listFailure, readFailure *Failure
			if !errors.As(listErr, &listFailure) || !errors.As(readErr, &readFailure) || *listFailure != *readFailure {
				t.Fatalf("list=%v read=%v", listErr, readErr)
			}
		})
	}
}

func TestAuthorizeOwnerWriteRequiresExactWriteAuthority(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	a := ownerFixture()
	a.Capabilities = []Capability{Write}
	if err := AuthorizeOwnerWrite(a, "work", "/work/file", now); err == nil {
		t.Fatal("write capability inflated read-only workspace")
	}
	a.Workspaces[0].Access = WriteAccess
	if err := AuthorizeOwnerWrite(a, "work", "/work/file", now); err != nil {
		t.Fatal(err)
	}
	for _, capability := range []Capability{Read, List, Search} {
		a.Capabilities = []Capability{capability}
		if err := AuthorizeOwnerWrite(a, "work", "/work/file", now); err == nil {
			t.Fatal("non-write capability granted mutation")
		}
	}
	a.Capabilities = []Capability{Write}
	a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/Café"}}
	if err := AuthorizeOwnerWrite(a, "work", "/work/CAFE/file", now); err == nil {
		t.Fatal("aliased exclusion bypassed")
	}
	if err := AuthorizeOwnerWrite(a, "work", "/work/file", a.ExpiresAt); err == nil {
		t.Fatal("expired write granted")
	}
}
