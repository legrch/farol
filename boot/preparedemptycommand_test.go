//go:build darwin

package boot

import (
	"bytes"
	"io"
	"testing"
)

func TestPreparedEmptyCommandRefusesUnsafeScopeBeforeIO(t *testing.T) {
	for _, root := range []string{"/private/tmp/not-dev", "/Users/owner/Library/Application Support/io.github.legrch.farol/farol-state/go-core", "/private/tmp/Farol Dev/farol-state/other"} {
		args := []string{"--profile", "synthetic", "--profile-root", root, "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
		if code := runPreparedEmptyInspection(args, panicEmptyRecoveryIO{}, panicEmptyRecoveryIO{}, io.Discard); code != 2 {
			t.Fatal("unsafe scope reached observation", code)
		}
	}
}

func TestPreparedEmptyCommandRejectsUntrustedBoundaryBeforeNativeIO(t *testing.T) {
	args := []string{"--profile", "synthetic", "--profile-root", "/private/tmp/Farol Dev/farol-state/go-core", "--profile-device", "1", "--profile-inode", "2", "--expected-build", BuildID}
	for _, raw := range []string{"", "{", `{"unknown":true}`, `{"Original":{"Profile":{"ProfileID":"other"}}}`, `{"Original":{"OwnerID":"one","OwnerID":"two"}}`, `{"Original":{"OwnerID":"one","ownerid":"two"}}`, `{"PendingSHA":[],"pendingsha":[]}`, "{} {}", string(bytes.Repeat([]byte(" "), 65537))} {
		var out, diagnostics bytes.Buffer
		if code := runPreparedEmptyInspection(args, bytes.NewBufferString(raw), &out, &diagnostics); code != 2 || out.Len() != 0 {
			t.Fatal("untrusted selection reached native IO", code)
		}
	}
}
