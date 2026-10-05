package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func inspectionArgs() []string {
	return []string{"--profile", "profile", "--profile-root", "/private/tmp/inspection-only", "--profile-device", "1", "--profile-inode", "9007199254740993", "--expected-build", BuildID}
}

func TestInspectionCommandRejectsCrossedInputBeforeSelection(t *testing.T) {
	for _, kind := range []string{"missing", "duplicate", "unknown", "build", "device", "inode", "zero", "root", "profile", "overflow"} {
		t.Run(kind, func(t *testing.T) {
			args := inspectionArgs()
			switch kind {
			case "missing":
				args = args[:len(args)-1]
			case "duplicate":
				args[8], args[9] = "--profile", "other"
			case "unknown":
				args[0] = "--home"
			case "build":
				args[9] += "-other"
			case "device":
				args[5] = "01"
			case "inode":
				args[7] = "+1"
			case "zero":
				args[7] = "0"
			case "root":
				args[3] = "/private/tmp/a/../b"
			case "profile":
				args[1] = ""
			case "overflow":
				args[7] = "18446744073709551616"
			}
			calls := 0
			var out, diagnostic bytes.Buffer
			code := runNativeStateInspection(args, &out, &diagnostic, func(context.Context, ProfileBinding) (*nativeStateInspection, error) {
				calls++
				return nil, nil
			})
			if code != 2 || calls != 0 || out.Len() != 0 || diagnostic.String() != "NATIVE_STATE_INSPECTION_INPUT_INVALID\n" {
				t.Fatal("invalid input reached selection or exposed details", code, calls)
			}
		})
	}
}

func TestInspectionCommandRetainsExactMetadataWithoutRecoveryAuthority(t *testing.T) {
	var out, diagnostic bytes.Buffer
	calls := 0
	code := runNativeStateInspection(inspectionArgs(), &out, &diagnostic, func(ctx context.Context, b ProfileBinding) (*nativeStateInspection, error) {
		calls++
		if _, ok := ctx.Deadline(); !ok || b.ProfileID != "profile" || b.Device != 1 || b.Inode != 9007199254740993 {
			t.Fatal("crossed binding or missing deadline", b)
		}
		return &nativeStateInspection{Schema: "farol-native-state-inspection/1", BuildID: BuildID, ProfileID: b.ProfileID, ProfileRoot: inspectionPhysical(b.Device, b.Inode)}, nil
	})
	var value map[string]any
	if code != 0 || calls != 1 || diagnostic.Len() != 0 || json.Unmarshal(out.Bytes(), &value) != nil || value["recoveryAuthorized"] != false || value["profileRoot"].(map[string]any)["inode"] != "9007199254740993" {
		t.Fatal("metadata lost identity/precision or invented authority", out.String())
	}
}

type inspectionShortWriter struct{}

func (inspectionShortWriter) Write(p []byte) (int, error) { return len(p) - 1, nil }

func TestInspectionCommandFailureDisclosesNoRawErrorAndNeverRepeats(t *testing.T) {
	for _, kind := range []string{"error", "missing", "short-write"} {
		t.Run(kind, func(t *testing.T) {
			var out, diagnostic bytes.Buffer
			var writer io.Writer = &out
			if kind == "short-write" {
				writer = inspectionShortWriter{}
			}
			calls := 0
			code := runNativeStateInspection(inspectionArgs(), writer, &diagnostic, func(context.Context, ProfileBinding) (*nativeStateInspection, error) {
				calls++
				if kind == "error" {
					return nil, errors.New("private raw diagnostic must not be disclosed")
				}
				if kind == "missing" {
					return nil, nil
				}
				return &nativeStateInspection{}, nil
			})
			if code != 1 || calls != 1 || out.Len() != 0 || strings.Contains(diagnostic.String(), "private") {
				t.Fatal("failed inspection repeated or disclosed raw data", code, calls)
			}
		})
	}
}
