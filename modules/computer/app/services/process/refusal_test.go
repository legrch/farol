package process

import (
	"errors"
	"testing"
)

func TestBoundaryPreservesClosedNativeRefusalReasons(t *testing.T) {
	for _, reason := range []NativeRefusalReason{
		RefusalAdmissionPolicy, RefusalConfinementPolicy, RefusalExecutableIntegrity,
		RefusalWorkspaceRootIdentity, RefusalCwdFence, RefusalDirectoryPolicy,
		RefusalFilesystemPolicy, RefusalRuntimeIntegrity, RefusalHelperPreflight, RefusalUnclassified,
	} {
		t.Run(string(reason), func(t *testing.T) {
			var got *Failure
			if !errors.As(boundary(&NativeFailure{Reason: reason}), &got) || got.Code != "PROCESS_NATIVE_REFUSED" || got.Unknown || got.NativeRefusalReason != reason {
				t.Fatalf("reason lost: %#v", got)
			}
		})
	}
}
func TestBoundaryDoesNotDiscloseUnknownReasonOrReclassifyUnknownEffect(t *testing.T) {
	for _, reason := range []NativeRefusalReason{"", "future_reason", "/outside/private token=fixture"} {
		var got *Failure
		errors.As(boundary(&NativeFailure{Reason: reason}), &got)
		if got.NativeRefusalReason != RefusalUnclassified {
			t.Fatalf("untrusted reason escaped: %#v", got)
		}
		errors.As(boundary(&NativeFailure{Reason: reason, Unknown: true}), &got)
		if got.Code != "PROCESS_OUTCOME_UNKNOWN" || !got.Unknown || got.NativeRefusalReason != "" {
			t.Fatalf("unknown effect changed: %#v", got)
		}
	}
}
