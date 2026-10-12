//go:build darwin && farol_native_root_scoped

package boot

import (
	"bytes"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Explicit local transport fixtures only; no child, profile or execution.
// consume owns exactly the read descriptor; the test owns the peer writer.
func TestNativeShellLaunchPipe(t *testing.T) {
	for _, mode := range []string{"payload", "oversize", "no-eof"} {
		if passed := t.Run(mode, func(t *testing.T) {
			fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
			if err != nil {
				t.Fatal(err)
			}
			writer := os.NewFile(uintptr(fds[1]), "synthetic-shell-metadata")
			raw, launch := shellLaunchFixture(t)
			started := time.Now()
			if mode == "no-eof" {
				data, err := consumeShellLaunchPipe(fds[0])
				closeErr := writer.Close()
				if err == nil || data != nil || closeErr != nil || time.Since(started) > 5*time.Second {
					t.Fatal("missing EOF was not bounded", err, closeErr)
				}
				return
			}
			payload := []byte(raw)
			if mode == "oversize" {
				payload = bytes.Repeat([]byte("x"), shellLaunchMaximumBytes+1)
			}
			written := make(chan error, 1)
			go func() {
				_, writeErr := writer.Write(payload)
				closeErr := writer.Close()
				if writeErr != nil {
					written <- writeErr
				} else {
					written <- closeErr
				}
			}()
			data, err := consumeShellLaunchPipe(fds[0])
			writeErr := <-written
			if mode == "oversize" {
				if err == nil || data != nil {
					t.Fatal("oversize stream accepted")
				}
				return // peer write may observe the expected closed reader.
			}
			if err != nil || writeErr != nil || !bytes.Equal(data, payload) {
				t.Fatal("transport changed bytes", err, writeErr)
			}
			if _, err := decodeShellLaunch(data, launch); err != nil {
				t.Fatal(err)
			}
		}); !passed {
			return
		}
	}
}
