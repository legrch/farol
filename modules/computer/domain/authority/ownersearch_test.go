package authority

import (
	"errors"
	"testing"
	"time"
)

func TestAuthorizeOwnerSearch(t *testing.T) {
	now := time.UnixMilli(1800000000000)
	for _, tc := range []struct {
		name, path, code string
		change           func(*Approval)
	}{
		{"root", "/work", "", nil},
		{"file", "/work/nested/note.md", "", nil},
		{"read cannot grant search", "/work", "AUTHORITY_CAPABILITY_DENIED", func(a *Approval) { a.Capabilities = []Capability{Read} }},
		{"list cannot grant search", "/work", "AUTHORITY_CAPABILITY_DENIED", func(a *Approval) { a.Capabilities = []Capability{List} }},
		{"write cannot grant search", "/work", "AUTHORITY_CAPABILITY_DENIED", func(a *Approval) { a.Capabilities = []Capability{Write}; a.Workspaces[0].Access = WriteAccess }},
		{"expiry exact", "/work", "AUTHORITY_EXPIRED", func(a *Approval) { a.ExpiresAt = now }},
		{"aliased exclusion", "/work/CAFE/file", "AUTHORITY_PATH_DENIED", func(a *Approval) { a.ExcludedPaths = []Exclusion{{WorkspaceID: "work", Path: "/work/Café"}} }},
		{"positive root exact", "/WORK/file", "AUTHORITY_PATH_DENIED", nil},
		{"outside root", "/work-other/file", "AUTHORITY_PATH_DENIED", nil},
		{"traversal", "/work/../file", "COMPUTER_PATH_INVALID", nil},
		{"backslash path", "/work/alias\\file", "COMPUTER_PATH_INVALID", nil},
		{"no physical root identity", "/work", "COMPUTER_APPROVAL_INVALID", func(a *Approval) { a.Workspaces[0].RootIdentity.Inode = "" }},
		{"unknown file policy", "/work", "COMPUTER_APPROVAL_INVALID", func(a *Approval) { a.FilePolicy = "unknown" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := ownerFixture()
			a.Capabilities = []Capability{Search}
			if tc.change != nil {
				tc.change(&a)
			}
			err := AuthorizeOwnerSearch(a, "work", tc.path, now)
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
}

func TestAuthorizeOwnerSearchDoesNotGrantReadListOrWrite(t *testing.T) {
	a := ownerFixture()
	a.Capabilities = []Capability{Search}
	a.Workspaces[0].Access = WriteAccess
	for _, authorize := range []func(Approval, string, string, time.Time) error{AuthorizeOwnerList, AuthorizeOwnerRead, AuthorizeOwnerWrite} {
		if err := authorize(a, "work", "/work/file", time.UnixMilli(1800000000000)); err == nil {
			t.Fatal("Search granted another operation")
		}
	}
}
