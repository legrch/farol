package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
)

func terminatedCommandSelection(t *testing.T) ([]string, []byte, terminatedProfileInspectionInput) {
	t.Helper()
	selected, _, _, _, _ := terminatedProfilePureFixture(false)
	profile := selected.Profile
	selected.Profile = ProfileBinding{}
	raw, err := json.Marshal(selected)
	if err != nil {
		t.Fatal(err)
	}
	selected.Profile = profile
	args := []string{"--profile", profile.ProfileID, "--profile-root", profile.Root, "--profile-device", strconv.FormatUint(profile.Device, 10), "--profile-inode", strconv.FormatUint(profile.Inode, 10), "--expected-build", BuildID}
	return args, raw, selected
}

func TestTerminatedInspectionCommandInvalidBeforeNativeIO(t *testing.T) {
	args, valid, _ := terminatedCommandSelection(t)
	for _, raw := range []string{"", `{`, `{"Unknown":true}`, `{"Profile":{"ProfileID":"other"}}`, `{"OwnerID":"one","OwnerID":"two"}`, `{} {}`, string(bytes.Repeat([]byte(" "), 65537)), `{"Publication":{"Binding":{"profileid":"other"}}}`} {
		var out, diagnostic bytes.Buffer
		code := runTerminatedProfileInspection(args, strings.NewReader(raw), &out, &diagnostic, func(context.Context, terminatedProfileInspectionInput, func(terminatedProfileInspection) error) error {
			t.Fatal("invalid selection reached native")
			return nil
		})
		if code != 2 || out.Len() != 0 || !strings.Contains(diagnostic.String(), "INPUT_INVALID") {
			t.Fatal(code, out.String(), diagnostic.String())
		}
	}
	for _, kind := range []string{"flags", "nil-input", "nil-output", "nil-observer", "read-error"} {
		t.Run(kind, func(t *testing.T) {
			var out, diagnostic bytes.Buffer
			a := args
			var in io.Reader = bytes.NewReader(valid)
			var sink io.Writer = &out
			inspect := func(context.Context, terminatedProfileInspectionInput, func(terminatedProfileInspection) error) error {
				t.Fatal("invalid adapter reached native")
				return nil
			}
			switch kind {
			case "flags":
				a = append([]string(nil), args...)
				a[len(a)-1] = "other-build"
			case "nil-input":
				in = nil
			case "nil-output":
				sink = nil
			case "nil-observer":
				inspect = nil
			case "read-error":
				in = terminatedCommandReadFailure{}
			}
			if code := runTerminatedProfileInspection(a, in, sink, &diagnostic, inspect); code != 2 || out.Len() != 0 {
				t.Fatal(code)
			}
		})
	}
	var out, diagnostic bytes.Buffer
	if code := Run([]string{"inspect-terminated-profile"}, io.NopCloser(bytes.NewReader(nil)), inspectionCommandCloser{&out}, &diagnostic); code != 2 || out.Len() != 0 {
		t.Fatal("Run diagnostic dispatch failed", code)
	}
}

type terminatedCommandReadFailure struct{}

func (terminatedCommandReadFailure) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

type terminatedCommandWriteFailure struct{ short bool }

func (w terminatedCommandWriteFailure) Write(p []byte) (int, error) {
	if w.short {
		return len(p) - 1, nil
	}
	return 0, io.ErrClosedPipe
}

func TestTerminatedInspectionCommandKnownCompletionBeforeDisclosure(t *testing.T) {
	args, raw, selected := terminatedCommandSelection(t)
	for _, kind := range []string{"success", "pre-refusal", "late-recheck", "missing-visitor", "duplicate-visitor", "write-error", "short-write"} {
		t.Run(kind, func(t *testing.T) {
			var out, diagnostic bytes.Buffer
			var sink io.Writer = &out
			if kind == "write-error" || kind == "short-write" {
				sink = terminatedCommandWriteFailure{short: kind == "short-write"}
			}
			completed := false
			code := runTerminatedProfileInspection(args, bytes.NewReader(raw), sink, &diagnostic, func(ctx context.Context, got terminatedProfileInspectionInput, visit func(terminatedProfileInspection) error) error {
				if !reflect.DeepEqual(got, selected) {
					t.Fatal("original selection changed")
				}
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > 5*time.Second {
					t.Fatal("missing original bounded observation")
				}
				if kind == "pre-refusal" {
					return errors.New("synthetic refusal")
				}
				if kind != "missing-visitor" {
					v := terminatedProfileInspection{Scope: chatport.JournalScope{ProfileID: selected.Profile.ProfileID, BackendGeneration: selected.Publication.Binding.BackendGeneration}, HandoffSteps: 3, HandoffDigest: [32]byte{1}, LifecycleDigest: [32]byte{2}, ResultClaimDigest: [32]byte{3}}
					if err := visit(v); err != nil {
						return err
					}
					if out.Len() != 0 {
						t.Fatal("output disclosed before final original checks/Close")
					}
					if kind == "duplicate-visitor" {
						return visit(v)
					}
				}
				completed = true
				if kind == "late-recheck" {
					return errors.New("synthetic final check/Close failed")
				}
				return nil
			})
			if kind != "success" {
				if code != 1 || out.Len() != 0 {
					t.Fatal("refusal/late/lost output became success", kind, code, out.String())
				}
				return
			}
			var result terminatedInspectionOutput
			if code != 0 || !completed || json.Unmarshal(out.Bytes(), &result) != nil || result.Schema != "farol-terminated-profile-inspection/1" || result.BuildID != BuildID || result.ProfileID != selected.Profile.ProfileID || result.RecoveryAuthorized || len(result.Retained) != 2 || strings.Contains(out.String(), selected.Profile.Root) || strings.Contains(out.String(), "Receipt") {
				t.Fatal("metadata contract changed", code, out.String())
			}
		})
	}
}
