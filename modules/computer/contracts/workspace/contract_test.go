package workspace

import (
	"errors"
	"testing"

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
