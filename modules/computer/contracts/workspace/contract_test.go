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
