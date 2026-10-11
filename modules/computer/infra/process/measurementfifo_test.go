//go:build darwin

package process

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Disposable native filesystem regression only: no child or sandbox dispatch.
func TestNativeProcessImageFIFORefusesWithoutWriter(t *testing.T) {
	for _, mode := range []string{"selected-image", "additional-protected-image", "watchdog-image"} {
		t.Run(mode, func(t *testing.T) {
			command, launch := measurementFixture(t)
			fifo := filepath.Join(filepath.Dir(command.Root), "fifo-image")
			if err := syscall.Mkfifo(fifo, 0700); err != nil {
				t.Fatal(err)
			}
			pin := ExecutablePin{fifo, strings.Repeat("a", 64)}
			if mode == "selected-image" {
				launch.pins[0] = pin
			} else {
				launch.pins = append(launch.pins, pin)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			type result struct {
				accepted bool
				err      error
			}
			done := make(chan result, 1)
			go func() {
				if mode == "watchdog-image" {
					held, err := pinnedExecutable(pin)
					if held != nil {
						held.Close()
					}
					done <- result{held != nil, err}
					return
				}
				held, err := retainLaunch(ctx, command, launch)
				if held != nil {
					held.Close()
				}
				done <- result{held != nil, err}
			}()
			select {
			case out := <-done:
				if out.err == nil || out.accepted {
					t.Fatal("FIFO image accepted")
				}
			case <-time.After(500 * time.Millisecond):
				// Unblock exactly this test-owned FIFO so the failed regression leaves no
				// stuck goroutine or descriptors. This is cleanup, not another measurement.
				peer, err := os.OpenFile(fifo, os.O_RDWR|syscall.O_NONBLOCK, 0)
				if err != nil {
					t.Fatal("cannot release original blocked FIFO", err)
				}
				defer peer.Close()
				select {
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("original FIFO measurement remains blocked")
				}
				t.Fatal("image open blocked past its context deadline waiting for a FIFO writer")
			}
		})
	}
}
