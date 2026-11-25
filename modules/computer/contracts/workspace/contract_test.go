package workspace

import (
	"errors"
	"testing"

	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestClassifiedFailureRetainsProvenanceAndNeverRetry(t *testing.T) {
	err := failure(&authority.Failure{Code: "AUTHORITY_PATH_DENIED", Source: "owner-restriction", Retry: "later"})
	var out *Failure
	if !errors.As(err, &out) || out.Code != "AUTHORITY_PATH_DENIED" || out.Source != "owner-restriction" || out.Retry != "never" {
		t.Fatalf("wrong classification %v", err)
	}
}
func TestUnknownNativeErrorAndPrivateDiagnosticsCannotEscape(t *testing.T) {
	for _, err := range []error{errors.New("private raw path or environment"), &authority.Failure{Code: "PRIVATE_NATIVE_DETAIL", Source: "native-workspace"}, &authority.Failure{Code: "WORKSPACE_NOT_FOUND", Source: "private-setting"}, nil} {
		converted := failure(err)
		var out *Failure
		if !errors.As(converted, &out) || out.Code != "WORKSPACE_HELPER_FAILED" || out.Source != "native-workspace" || out.Retry != "never" {
			t.Fatalf("unsafe error %v", converted)
		}
	}
}

func TestPathDiagnosticAllowsOnlyBoundedPairs(t *testing.T) {
	for _, tc := range []struct{ code, source, stage, reason, wantStage, wantReason string }{
		{"WORKSPACE_PATH_REFUSED", "native-workspace", "policy", "policy_denied", "policy", "policy_denied"},
		{"WORKSPACE_PATH_REFUSED", "native-workspace", "target", "hardlink_not_supported", "target", "hardlink_not_supported"},
		{"WORKSPACE_PATH_REFUSED", "native-workspace", "target", "/private/secret", "", ""},
		{"WORKSPACE_PATH_REFUSED", "native-workspace", "policy", "unsafe_root", "", ""},
		{"WORKSPACE_PATH_REFUSED", "task-grant", "policy", "policy_denied", "", ""},
		{"WORKSPACE_NOT_FOUND", "native-workspace", "policy", "policy_denied", "", ""},
	} {
		out := failure(&authority.Failure{Code: tc.code, Source: tc.source, Stage: tc.stage, Reason: tc.reason}).(*Failure)
		if out.Stage != tc.wantStage || out.Reason != tc.wantReason || out.Retry != "never" {
			t.Fatalf("unsafe or lost diagnostic: %+v", out)
		}
	}
}

func TestCatalogueRefusalIsReallowlistedAtTheBoundary(t *testing.T) {
	for _, tc := range []struct{ in, want CatalogueRefusal }{
		{CatalogueRefusal{"WORKSPACE_PATH_REFUSED", "native-workspace", "root", "unsafe_root"}, CatalogueRefusal{"WORKSPACE_PATH_REFUSED", "native-workspace", "root", "unsafe_root"}},
		{CatalogueRefusal{"WORKSPACE_PATH_REFUSED", "native-workspace", "root", "/private/path"}, CatalogueRefusal{"WORKSPACE_PATH_REFUSED", "native-workspace", "", ""}},
		{CatalogueRefusal{"WORKSPACE_NOT_FOUND", "native-workspace", "root", "unsafe_root"}, CatalogueRefusal{"WORKSPACE_NOT_FOUND", "native-workspace", "", ""}},
		{CatalogueRefusal{"PRIVATE_NATIVE_DETAIL", "native-workspace", "", ""}, CatalogueRefusal{"WORKSPACE_HELPER_FAILED", "native-workspace", "", ""}},
		{CatalogueRefusal{"WORKSPACE_NOT_FOUND", "private-setting", "", ""}, CatalogueRefusal{"WORKSPACE_HELPER_FAILED", "native-workspace", "", ""}},
	} {
		in := workspacesvc.CatalogueRefusal(tc.in)
		if got := catalogueRefusal(in); got == nil || *got != tc.want {
			t.Fatalf("%+v became %+v, want %+v", tc.in, got, tc.want)
		}
	}
}

func TestCatalogueMatchReportsRefusalAndMissing(t *testing.T) {
	r := &CatalogueResponse{Workspaces: []CatalogueEntry{
		{WorkspaceID: "ok"},
		{WorkspaceID: "bad", Refusal: &CatalogueRefusal{Code: "WORKSPACE_PATH_REFUSED"}},
	}}
	for _, c := range []struct {
		id    string
		match bool
		code  string
	}{{"ok", true, "fb"}, {"bad", false, "WORKSPACE_PATH_REFUSED"}, {"gone", false, "fb"}} {
		if match, code := r.Match(c.id, "fb"); match != c.match || code != c.code {
			t.Fatalf("%s: %v %q", c.id, match, code)
		}
	}
	var none *CatalogueResponse
	if match, code := none.Match("ok", "fb"); match || code != "fb" {
		t.Fatal("nil receiver")
	}
}
