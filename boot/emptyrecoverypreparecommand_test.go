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
	args := []string{"--profile", "synthetic", "--profile-root", "/private/tmp/Farol Dev/farol-state/go-core", "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
	for _, raw := range []string{"", `{` + "\n", `{"unknown":true}` + "\n", `{"OwnerID":"one","ownerid":"two"}` + "\n", `{"Profile":{"ProfileID":"other"}}` + "\n", string(bytes.Repeat([]byte("x"), 65538)) + "\n"} {
		var out, diagnostics bytes.Buffer
		if code := runEmptyRecoveryPreparation(args, emptyRecoveryTestInput{bytes.NewBufferString(raw)}, emptyRecoveryTestOutput{&out}, &diagnostics); code != 2 || out.Len() != 0 {
			t.Fatal("malformed request reached preparation", code)
		}
	}
}

func TestEmptyRecoveryPreparationDevScopeBeforeIO(t *testing.T) {
	for _, name := range []string{"Farol Dev", "Farol DEV"} {
		if !emptyRecoveryDevRoot("/private/tmp/" + name + "/farol-state/go-core") {
			t.Fatal("qualified Dev namespace refused", name)
		}
	}
	for _, root := range []string{
		"/Users/owner/Library/Application Support/io.github.legrch.farol/farol-state/go-core",
		"/Users/owner/Library/Application Support/Farol/farol-state/go-core",
		"/private/tmp/Farol Dev/go-core",
		"/private/tmp/Farol Dev/farol-state/../farol-state/go-core",
		"/private/tmp/Farol Dev copy/farol-state/go-core",
	} {
		args := []string{"--profile", "synthetic", "--profile-root", root, "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
		var diagnostics bytes.Buffer
		if emptyRecoveryDevRoot(root) || runEmptyRecoveryPreparation(args, panicEmptyRecoveryIO{}, panicEmptyRecoveryIO{}, &diagnostics) != 2 {
			t.Fatal("non-Dev root passed effectful CLI admission", root)
		}
	}
}

type panicEmptyRecoveryIO struct{}

func (panicEmptyRecoveryIO) Read([]byte) (int, error) { panic("input touched before scope admission") }
func (panicEmptyRecoveryIO) Write([]byte) (int, error) {
	panic("output touched before scope admission")
}
func (panicEmptyRecoveryIO) SetReadDeadline(time.Time) error {
	panic("input deadline touched before scope admission")
}
func (panicEmptyRecoveryIO) SetWriteDeadline(time.Time) error {
	panic("output deadline touched before scope admission")
}

func TestInstalledEmptyRecoveryPreparationScopeBeforeIO(t *testing.T) {
	for _, root := range []string{
		"/private/tmp/Farol Dev/farol-state/go-core",
		"/private/tmp/Farol DEV/farol-state/go-core",
		"/private/tmp/Farol/farol-state/go-core",
		"/private/tmp/Farol copy/farol-state/go-core",
		"/private/tmp/Farol/go-core",
		"/private/tmp/Farol/farol-state/../farol-state/go-core",
	} {
		args := []string{"--profile", "synthetic", "--profile-root", root, "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
		var diagnostics bytes.Buffer
		if emptyRecoveryInstalledRoot(root) || runInstalledEmptyRecoveryPreparation(args, panicEmptyRecoveryIO{}, panicEmptyRecoveryIO{}, &diagnostics) != 2 {
			t.Fatal("non-installed namespace reached IO", root)
		}
	}
	if !emptyRecoveryInstalledRoot("/private/tmp/io.github.legrch.farol/farol-state/go-core") {
		t.Fatal("fixed installed namespace refused")
	}
}
