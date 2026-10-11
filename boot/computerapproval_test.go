package boot

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

const desktopApprovalFixture = `{"ownerId":"owner","computerId":"computer","generation":7,"workspaces":[{"workspaceId":"work","root":"/selected/work","access":"write","rootIdentity":{"device":"18446744073709551615","inode":"9007199254740993"},"gitMetadata":{"gitDirectory":"/selected/git","commonDirectory":"/selected/common"},"gitHistoryApproved":true,"shellVerified":true}],"excludedPaths":[{"workspaceId":"work","path":"/selected/work/private"}],"capabilities":["workspace.list","workspace.read","workspace.shell"],"network":"none","commands":"workspace","expiresAt":1791050000000}`

func TestDesktopEmptyApprovalRequiresExplicitNoAccess(t *testing.T) {
	const raw = `{"ownerId":"owner","computerId":"computer","generation":7,"workspaces":[],"excludedPaths":[],"capabilities":[],"network":"none","commands":"none","expiresAt":1791050000000}`
	a, err := parseDesktopApproval(json.RawMessage(raw), "owner", "computer")
	if err != nil || !a.NoAccess() || a.Generation != 7 {
		t.Fatal("explicit connection-only approval refused", err)
	}
	for _, field := range []string{"workspaces", "excludedPaths", "capabilities"} {
		for _, value := range []string{"missing", "null", "true", `{}`} {
			t.Run(field+"/"+value, func(t *testing.T) {
				replacement := `"` + field + `":` + value + `,`
				if value == "missing" {
					replacement = ""
				}
				body := strings.Replace(raw, `"`+field+`":[],`, replacement, 1)
				if _, err := parseDesktopApproval(json.RawMessage(body), "owner", "computer"); err == nil {
					t.Fatal("incomplete empty approval accepted")
				}
			})
		}
	}
	for _, pair := range [][2]string{
		{`"capabilities":[]`, `"capabilities":["workspace.list"]`},
		{`"network":"none"`, `"network":"approved"`},
		{`"commands":"none"`, `"commands":"verification"`},
		{`"excludedPaths":[]`, `"excludedPaths":[{"workspaceId":"old","path":"/old"}]`},
		{`"generation":7`, `"generation":0`},
	} {
		if _, err := parseDesktopApproval(json.RawMessage(strings.Replace(raw, pair[0], pair[1], 1)), "owner", "computer"); err == nil {
			t.Fatal("empty approval retained authority or lost identity")
		}
	}
}

func TestDesktopApprovalPreservesExistingQualifiedProjection(t *testing.T) {
	approval, err := parseDesktopApproval(json.RawMessage(desktopApprovalFixture), "owner", "computer")
	if err != nil {
		t.Fatal(err)
	}
	w := approval.Workspaces[0]
	if w.RootIdentity.Device != "18446744073709551615" || w.RootIdentity.Inode != "9007199254740993" || !w.ShellVerified || !w.GitHistoryApproved || w.GitMetadata.CommonDirectory != "/selected/common" || approval.Generation != 7 || approval.ExpiresAt != time.UnixMilli(1791050000000).UTC() {
		t.Fatalf("projection changed: %+v", approval)
	}
	if approval.ExcludedPaths[0].RestrictionSource != authority.ComputerApprovalSource {
		t.Fatal("missing explicit approval provenance")
	}
}

func TestDesktopApprovalFilePolicyIsClosedAndReadIntentRetainsIt(t *testing.T) {
	for _, mode := range []string{"", "approved-roots-v1"} {
		raw := strings.Replace(desktopApprovalFixture, `"commands":"workspace"`, `"commands":"workspace","filePolicy":"`+mode+`"`, 1)
		approval, err := parseDesktopApproval(json.RawMessage(raw), "owner", "computer")
		if err != nil || string(approval.FilePolicy) != mode {
			t.Fatal("trusted file policy lost", err)
		}
		policy, err := readIntentPolicy(approval, []string{"work"})
		if err != nil || policy.FilePolicy != approval.FilePolicy || len(policy.ExcludedPaths) != 1 {
			t.Fatal("read intent lost file policy or exclusions", err)
		}
	}
	for _, value := range []string{`"unknown"`, `null`, `true`, `1`} {
		raw := strings.Replace(desktopApprovalFixture, `"commands":"workspace"`, `"commands":"workspace","filePolicy":`+value, 1)
		if _, err := parseDesktopApproval(json.RawMessage(raw), "owner", "computer"); err == nil {
			t.Fatal("invalid file policy admitted", value)
		}
	}
}
func TestDesktopApprovalRejectsUnknownNullableAndLossyInputs(t *testing.T) {
	cases := map[string]string{
		"nested-extra":          strings.Replace(desktopApprovalFixture, `"device":"18446744073709551615"`, `"extra":1,"device":"18446744073709551615"`, 1),
		"unknown-capability":    strings.Replace(desktopApprovalFixture, `"workspace.shell"`, `"network.use"`, 1),
		"fractional-generation": strings.Replace(desktopApprovalFixture, `"generation":7`, `"generation":7.5`, 1),
		"unsafe-generation":     strings.Replace(desktopApprovalFixture, `"generation":7`, `"generation":9007199254740992`, 1),
		"null-proof":            strings.Replace(desktopApprovalFixture, `"shellVerified":true`, `"shellVerified":null`, 1),
		"duplicate-owner":       strings.Replace(desktopApprovalFixture, `"ownerId":"owner"`, `"ownerId":"owner","ownerId":"owner"`, 1),
		"numeric-root":          strings.Replace(desktopApprovalFixture, `"inode":"9007199254740993"`, `"inode":9007199254740993`, 1),
		"aliased-root":          strings.Replace(desktopApprovalFixture, `"inode":"9007199254740993"`, `"inode":"09007199254740993"`, 1),
		"zero-expiry":           strings.Replace(desktopApprovalFixture, `"expiresAt":1791050000000`, `"expiresAt":0`, 1),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := parseDesktopApproval(json.RawMessage(body), "owner", "computer"); err == nil {
				t.Fatal("invalid projection accepted")
			}
		})
	}
	if _, err := parseDesktopApproval(json.RawMessage(desktopApprovalFixture), "different-owner", "computer"); err == nil {
		t.Fatal("crossed owner")
	}
}
func TestReadIntentUsesOnlyPublishedRootsAndOriginalExpiry(t *testing.T) {
	approval, err := parseDesktopApproval(json.RawMessage(desktopApprovalFixture), "owner", "computer")
	if err != nil {
		t.Fatal(err)
	}
	policy, err := readIntentPolicy(approval, []string{"work"})
	if err != nil {
		t.Fatal(err)
	}
	if policy.ExpiresAt != approval.ExpiresAt || policy.Commands != authority.NoCommands || policy.Network != authority.NoNetwork || len(policy.Workspaces) != 1 || policy.Workspaces[0].Root != "/selected/work" || policy.Workspaces[0].Access != authority.ReadAccess || len(policy.ExcludedPaths) != 1 || len(policy.Capabilities) != 2 {
		t.Fatalf("not narrowed: %+v", policy)
	}
	for _, ids := range [][]string{nil, {"unpublished"}, {"work", "work"}} {
		if _, err := readIntentPolicy(approval, ids); err == nil {
			t.Fatal("unselected scope")
		}
	}
	approval.Capabilities = []authority.Capability{authority.List}
	if _, err := readIntentPolicy(approval, []string{"work"}); err == nil {
		t.Fatal("inferred read capability")
	}
}
