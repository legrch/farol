package boot

import (
	"bytes"
	"testing"
	"time"
)

type emptyRecoveryTestInput struct{ *bytes.Buffer }
type emptyRecoveryTestOutput struct{ *bytes.Buffer }

func (emptyRecoveryTestInput) SetReadDeadline(time.Time) error   { return nil }
func (emptyRecoveryTestOutput) SetWriteDeadline(time.Time) error { return nil }

func TestEmptyRecoveryPreparationCommandRejectsInvalidInputBeforeEffects(t *testing.T) {
	args := []string{"--profile", "synthetic", "--profile-root", "/private/tmp/never-created-by-preparation", "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
	for _, raw := range []string{"", `{` + "\n", `{"unknown":true}` + "\n", `{"OwnerID":"one","ownerid":"two"}` + "\n", `{"Profile":{"ProfileID":"other"}}` + "\n", string(bytes.Repeat([]byte("x"), 65538)) + "\n"} {
		var out, diagnostics bytes.Buffer
		if code := runEmptyRecoveryPreparation(args, emptyRecoveryTestInput{bytes.NewBufferString(raw)}, emptyRecoveryTestOutput{&out}, &diagnostics); code != 2 || out.Len() != 0 {
			t.Fatal("malformed request reached preparation", code)
		}
	}
}
