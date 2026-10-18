package handoff

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Pure bounded parser regression; this test performs no native observation.
func TestLiveRecordDeterministicStrictFields(t *testing.T) {
	for _, data := range []string{`{"schema":1,"schema":1}`, `{"private":"\ud800"}`, `[]`, `{"pid":1} true`, `{"pid":1,"pid":2}`} {
		if _, err := recordFields([]byte(data)); err == nil {
			t.Fatal("ambiguous record accepted", data)
		}
	}
	fields, err := recordFields([]byte(`{"schema":1,"pid":2,"startedAt":"2026-10-18T00:00:00Z","bootTime":"fixture","processStart":"birth"}`))
	if err != nil || len(fields) != 5 {
		t.Fatal(fields, err)
	}
}

func TestLiveRecordDeterministicOriginalMarker(t *testing.T) {
	for _, boot := range []string{"null", "0", "1792000000000"} {
		wire := fmt.Sprintf(`{"schema":1,"pid":42,"startedAt":"2026-10-18T00:00:00.000Z","bootTime":%s,"processStart":"birth"}`, boot)
		if at, err := liveMarker([]byte(wire), 42, "birth"); err != nil || at != "2026-10-18T00:00:00.000Z" {
			t.Fatal("original producer refused", wire, err)
		}
		if _, err := liveMarker([]byte(wire), 43, "birth"); err != errRunMarkerMismatch {
			t.Fatal("crossed process refusal changed", err)
		}
		if _, err := liveMarker([]byte(wire), 42, "other"); err != errRunMarkerMismatch {
			t.Fatal("crossed birth refusal changed", err)
		}
	}
}

// Match the actual current RunMarkerSchema values. This validates record shape,
// not process identity, authoritative lease custody or a trusted clock source.
func TestLiveRecordDeterministicProducerSchema(t *testing.T) {
	wire := func(at, boot string) []byte {
		return []byte(fmt.Sprintf(`{"schema":1,"pid":42,"startedAt":%q,"bootTime":%s,"processStart":"birth"}`, at, boot))
	}
	for _, boot := range []string{`{}`, `[]`, `true`, `"0"`, `-1`, `0.25`, `9007199254740992`, `1e20`} {
		if _, err := liveMarker(wire("2026-10-18T00:00:00.000Z", boot), 42, "birth"); err != errRunMarkerMismatch {
			t.Error("malformed producer boot time accepted", boot, err)
		}
	}
	for _, at := range []string{"2026-10-18T00:00:00Z", "2026-10-18T00:00:00.00Z", "2026-10-18T00:00:00.0000Z", "2026-10-18T00:00:00.000+00:00", "2026-02-30T00:00:00.000Z"} {
		if _, err := liveMarker(wire(at, "null"), 42, "birth"); err != errRunMarkerMismatch {
			t.Error("noncanonical producer timestamp accepted", at, err)
		}
	}
	for _, boot := range []string{"null", "0", "-0", "0.0", "1e3", "1792000000000", "9007199254740991"} {
		if at, err := liveMarker(wire("2026-10-18T00:00:00.000Z", boot), 42, "birth"); err != nil || at != "2026-10-18T00:00:00.000Z" {
			t.Error("valid producer values refused", boot, err)
		}
	}
}

type liveBoundWaiter struct {
	calls               int
	until, contextUntil time.Time
}

func (w *liveBoundWaiter) ConfirmIdentity(context.Context, time.Time) error { return nil }
func (w *liveBoundWaiter) WaitExit(ctx context.Context, until time.Time) error {
	w.calls++
	w.until = until
	w.contextUntil, _ = ctx.Deadline()
	return nil
}

// Real disposable route/borrow/cleanup with a symbolic prepared waiter. This
// proves wrapper lifetime only, not actual process absence or writer admission.
func TestLiveWaitExitNativeKeepsWrapperBound(t *testing.T) {
	if os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled physical Live wrapper lifetime")
	}
	for _, boundary := range []string{"final-route-return", "final-route-cleanup"} {
		t.Run(boundary, func(t *testing.T) {
			f := newFixture(t)
			waiter := &liveBoundWaiter{}
			live, err := NewLive(f.homePath, f.home, f.state, f.v.expected.StateIdentity, 42, f.v.expected.ProcessStart, waiter, time.Now().Add(time.Hour))
			if err != nil {
				t.Fatal(err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			released := false
			defer func() {
				if !released {
					close(release)
				}
			}()
			visits, final, blocked := 0, false, false
			live.route.reopen = func(ctx context.Context, p string) (int, int, error) {
				home, state, err := fixtureRoute(ctx, p)
				if err == nil {
					visits++
					if visits == 2 {
						final = true
						if boundary == "final-route-return" {
							close(entered)
							<-release
						}
					}
				}
				return home, state, err
			}
			n := nativeCalls{close: func(fd int) error {
				err := unix.Close(fd)
				if boundary == "final-route-cleanup" && final && !blocked {
					blocked = true
					close(entered)
					<-release
				}
				return err
			}}
			until := time.Now().Add(time.Second)
			done := make(chan error, 1)
			go func() { done <- live.WaitExit(context.WithValue(context.Background(), nativeKey{}, n), until) }()
			select {
			case <-entered:
			case err := <-done:
				t.Fatal("wrapper did not reach final owned boundary before the original bound", err)
			}
			var premature *error
			select {
			case early := <-done:
				premature = &early
				t.Error("wrapper detached entered native work or cleanup")
			default:
			}
			time.Sleep(time.Until(until) + time.Millisecond)
			close(release)
			released = true
			if premature != nil {
				err = *premature
			} else {
				err = <-done
			}
			if err == nil || !errors.Is(err, ErrCanceled) || !errors.Is(err, context.DeadlineExceeded) {
				t.Error("wrapper returned late success after the shorter original wait bound")
			}
			if waiter.calls != 1 || !waiter.until.Equal(until) || !waiter.contextUntil.Equal(until) {
				t.Error("shorter captured wait bound did not cover the complete native wrapper")
			}
			f.assertCustody()
		})
	}
}
