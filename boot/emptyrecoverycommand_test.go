package boot

import (
	"bytes"
	"context"
	"io"
	"reflect"
	"testing"
)

func TestEmptyRecoveryCommandInvalidSelectionRefusesBeforeNativeIO(t *testing.T) {
	args := []string{"--profile", "synthetic", "--profile-root", "/private/tmp/never-created-by-this-command", "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
	for _, raw := range []string{"", `{`, `{"unknown":true}`, `{"Profile":{"ProfileID":"other"}}`, `{"OwnerID":"one","OwnerID":"two"}`, `{} {}`, string(bytes.Repeat([]byte(" "), 65537))} {
		var out, diagnostics bytes.Buffer
		if code := runEmptyRecoveryInspection(args, bytes.NewBufferString(raw), &out, &diagnostics); code != 2 || out.Len() != 0 {
			t.Fatal("malformed input reached native observation", code)
		}
	}
	var out, diagnostics bytes.Buffer
	if code := Run([]string{"inspect-empty-recovery"}, io.NopCloser(bytes.NewReader(nil)), inspectionCommandCloser{&out}, &diagnostics); code != 2 || out.Len() != 0 {
		t.Fatal(code)
	}
	if err := inspectEmptyRecovery(context.Background(), emptyRecoveryInspectionInput{}, func(emptyRecoveryInspection) error { t.Fatal("invalid source binding reached observer"); return nil }); err == nil {
		t.Fatal("invalid selection accepted")
	}
}

func TestEmptyRecoveryCommandRejectsCaseAliasesRecursively(t *testing.T) {
	for _, raw := range []string{
		`{"OwnerID":"wrong","ownerid":"selected"}`,
		`{"Selection":{"Current":{"ProfileID":"wrong","profileid":"selected"}}}`,
		`{"Mutations":[{"Binding":{"Identity":{"OwnerID":"wrong","ownerID":"selected"}}}]}`,
		`{"Selection":{"Next":{"backendGeneration":"selected"}}}`,
	} {
		if emptyRecoveryCanonicalFields([]byte(raw), reflect.TypeFor[emptyRecoveryInspectionInput]()) {
			t.Fatal("noncanonical destination spelling accepted", raw)
		}
	}
	if !emptyRecoveryCanonicalFields([]byte(`{"OwnerID":"selected","Selection":{"Current":{"ProfileID":"selected"}},"Mutations":[{"Binding":{"Identity":{"OwnerID":"selected"}}}]}`), reflect.TypeFor[emptyRecoveryInspectionInput]()) {
		t.Fatal("canonical nested selection refused")
	}
}

type inspectionCommandCloser struct{ *bytes.Buffer }

func (inspectionCommandCloser) Close() error { return nil }
