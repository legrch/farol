//go:build darwin

package boot

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestNativeEmptyRecoveryDeadlineStreamsQualifyOwnedBlockingDescriptors(t *testing.T) {
	if !*ingressNative {
		t.Skip("Requires exclusive native lane and -ingress-native")
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	// Reproduce Go's inherited blocking stdio initialization. This is a native
	// descriptor test, not assembled-child/host terminal qualification.
	raw, err := reader.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	fd := -1
	var nativeErr error
	if err := raw.Control(func(original uintptr) {
		fd, nativeErr = unix.Dup(int(original))
		if nativeErr == nil {
			unix.CloseOnExec(fd)
			nativeErr = unix.SetNonblock(fd, false)
		}
	}); err != nil || nativeErr != nil {
		t.Fatal(err, nativeErr)
	}
	inherited := os.NewFile(uintptr(fd), "synthetic-inherited-input")
	defer inherited.Close()
	if inherited.SetReadDeadline(time.Now().Add(time.Second)) == nil {
		t.Fatal("fixture did not reproduce nonpollable inherited descriptor")
	}
	in, _, closeStreams, err := emptyRecoveryDeadlineStreams(inherited, writer)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(50 * time.Millisecond)
	if err := in.(interface{ SetReadDeadline(time.Time) error }).SetReadDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	_, err = in.Read(make([]byte, 1))
	if !errors.Is(err, os.ErrDeadlineExceeded) || time.Now().Before(deadline) {
		t.Fatal("blocking descriptor did not cancel at deadline", err)
	}
	if err := closeStreams(); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("x")); err != nil {
		t.Fatal("original stream closed", err)
	}
	if n, err := inherited.Read(make([]byte, 1)); n != 1 || err != nil {
		t.Fatal("original stream no longer owned", n, err)
	}
}

func TestNativeEmptyRecoveryDeadlineStreamsRefuseRegularFile(t *testing.T) {
	if !*ingressNative {
		t.Skip("Requires exclusive native lane and -ingress-native")
	}
	f, err := os.Create(filepath.Join(t.TempDir(), "ordinary-file"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, _, closeStreams, err := emptyRecoveryDeadlineStreams(f, io.Discard); err == nil || closeStreams != nil {
		t.Fatal("regular file accepted as child pipe")
	}
}
