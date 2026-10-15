//go:build linux || darwin

package installcopy

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// laggingDeadline has a fixed absolute deadline but deliberately never delivers
// cancellation. It models a delayed context timer without a scheduler race.
type laggingDeadline struct {
	context.Context
	deadline time.Time
}

func (c laggingDeadline) Deadline() (time.Time, bool) { return c.deadline, true }
func (laggingDeadline) Done() <-chan struct{}         { return nil }
func (laggingDeadline) Err() error                    { return nil }

func TestElapsedCallerDeadlineWithoutErrRefusesBeforeIO(t *testing.T) {
	f := setup(t)
	put(t, filepath.Join(f.source, "a"), "data", 0600)
	fences, attempts := 0, 0
	op := f.prepare(t, func(context.Context) error { fences++; return nil })
	ctx := laggingDeadline{context.Background(), time.Now().Add(-time.Hour)}
	err := op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, hooks{before: func(string) { attempts++ }})
	if attempts != 0 || fences != 0 {
		t.Fatalf("expired caller dispatched I/O=%d fences=%d", attempts, fences)
	}
	failure(t, err, "deadline", false, false)
	if !errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		t.Fatal("absolute caller deadline was not retained independently of Err")
	}
	entries, err := os.ReadDir(f.destination)
	if err != nil || len(entries) != 0 {
		t.Fatal("expired caller changed the private destination")
	}
	failure(t, op.Run(context.Background()), "consumed", true, false)
}

func TestCallerDeadlineAfterNativeReturnWithoutErr(t *testing.T) {
	for _, nativeError := range []error{nil, unix.EIO} {
		name := "success-result"
		if nativeError != nil {
			name = "native-error"
		}
		t.Run(name, func(t *testing.T) {
			f := setup(t)
			put(t, filepath.Join(f.source, "a"), "actual write witness", 0600)
			fences := 0
			op := f.prepare(t, func(context.Context) error { fences++; return nil })
			originalUntil := op.capture.until
			// Five seconds gives entry/traversal ample budget even under race
			// instrumentation. The fixed earlier deadline is never renewed.
			ctx := laggingDeadline{context.Background(), time.Now().Add(5 * time.Second)}
			attempts := 0
			h := hooks{write: func(fd int, p []byte) (int, error) {
				attempts++
				if !time.Now().Before(ctx.deadline) {
					t.Fatal("fixture did not enter the native call before its generous deadline")
				}
				n, err := unix.Write(fd, p)
				if err != nil {
					t.Fatal(err)
				}
				// The syscall is real; only its delayed synchronous return is
				// injected. No context timer or Err delivery can satisfy this check.
				time.Sleep(time.Until(ctx.deadline) + time.Millisecond)
				return n, nativeError
			}}
			err := op.run(ctx, limits{maxEntries, maxDepth, maxBytes}, h)
			if attempts != 1 || ctx.Err() != nil || time.Now().Before(ctx.deadline) {
				t.Fatal("native attempt/deadline/lagging Err witness missing")
			}
			got, readErr := os.ReadFile(filepath.Join(f.destination, "a"))
			if readErr != nil || string(got) != "actual write witness" {
				t.Fatal("real private mutation witness missing")
			}
			t.Logf("native attempts=%d, lagging Err=%v, native error=%v", attempts, ctx.Err(), nativeError)
			if nativeError == nil {
				failure(t, err, "deadline", true, false)
			} else {
				failure(t, err, "io", true, true)
				if !errors.Is(err, nativeError) {
					t.Fatal("deadline hid the original native error")
				}
			}
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("post-native absolute caller deadline cause lost")
			}
			if fences != 1 || !op.capture.until.Equal(originalUntil) {
				t.Fatal("operation continued after its deadline or renewed the original bound")
			}
			failure(t, op.Run(context.Background()), "consumed", true, false)
		})
	}
}
