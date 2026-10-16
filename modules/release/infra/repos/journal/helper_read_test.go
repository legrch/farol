package journal

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"golang.org/x/sys/unix"
)

// These tests use actual disposable filesystem objects with symbolic admission.
// They establish no live helper, installed profile, package or startup authority.
func helperContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestNativeHelperReadExactByteBoundaryAndGenericCompatibility(t *testing.T) {
	for _, size := range []int{8192, 8193, records.MaxRecordBytes} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			data := f.encoded(t, "prepared")
			data = append(data, bytes.Repeat([]byte(" \n\t"), (size-len(data))/3)...)
			data = append(data, bytes.Repeat([]byte(" "), size-len(data))...)
			if len(data) != size {
				t.Fatal("incorrect physical fixture size")
			}
			if err := os.WriteFile(filepath.Join(f.path, filename), data, 0o600); err != nil {
				t.Fatal(err)
			}
			generic := mustRead(t, r)
			view, err := r.ReadHelper(helperContext(t))
			if size == 8192 {
				if err != nil || !reflect.DeepEqual(view, generic) {
					t.Fatalf("exact helper bound refused or changed view: %v", err)
				}
			} else {
				if view != nil {
					t.Fatal("oversized helper view admitted")
				}
				requireError(t, err, records.Oversized)
			}
			if !reflect.DeepEqual(mustRead(t, r), generic) {
				t.Fatal("helper read changed generic revision")
			}
		})
	}
}

func TestNativeHelperReadRejectsUnsafeAndUnboundRecords(t *testing.T) {
	for _, kind := range []string{"malformed", "crossed", "oversized-malformed", "symlink", "hardlink", "directory", "fifo", "mode", "setuid"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			name := filepath.Join(f.path, filename)
			want := error(records.Invalid)
			switch kind {
			case "malformed":
				if err := os.WriteFile(name, []byte("private invalid input"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "crossed":
				data := bytes.ReplaceAll(f.encoded(t, "prepared"), []byte(f.operation.Target.Digest), []byte(strings.Repeat("f", 64)))
				if err := os.WriteFile(name, data, 0o600); err != nil {
					t.Fatal(err)
				}
				want = records.BindingMismatch
			case "oversized-malformed":
				if err := os.WriteFile(name, bytes.Repeat([]byte("!"), 8193), 0o600); err != nil {
					t.Fatal(err)
				}
				want = records.Oversized
			case "symlink":
				if err := os.WriteFile(filepath.Join(f.path, "other"), f.encoded(t, "prepared"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("other", name); err != nil {
					t.Fatal(err)
				}
			case "hardlink":
				f.put(t, "prepared")
				if err := os.Link(name, name+".alias"); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(name, 0o700); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := unix.Mkfifo(name, 0o600); err != nil {
					t.Fatal(err)
				}
			case "mode":
				f.put(t, "prepared")
				if err := os.Chmod(name, 0o640); err != nil {
					t.Fatal(err)
				}
			case "setuid":
				f.put(t, "prepared")
				if err := os.Chmod(name, 0o600|os.ModeSetuid); err != nil {
					t.Fatal(err)
				}
			}
			view, err := r.ReadHelper(helperContext(t))
			if view != nil {
				t.Fatal("unsafe helper view admitted")
			}
			requireError(t, err, want)
			if strings.Contains(err.Error(), f.path) || strings.Contains(err.Error(), "private invalid") {
				t.Fatal("private bytes leaked")
			}
		})
	}
}

func helperFileState(t *testing.T, name string) fileState {
	t.Helper()
	info, err := os.Lstat(name)
	if err != nil {
		t.Fatal(err)
	}
	state, ok := metadata(info)
	if !ok {
		t.Fatal("native metadata unavailable")
	}
	return state
}

func TestNativeHelperReadPreservesBytesMetadataAndAbsence(t *testing.T) {
	for _, present := range []bool{false, true} {
		t.Run(map[bool]string{false: "absent", true: "present"}[present], func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			name := filepath.Join(f.path, filename)
			var before fileState
			if present {
				f.put(t, "launch_requested")
				before = helperFileState(t, name)
			}
			directory := helperFileState(t, f.path)
			ancestor := helperFileState(t, filepath.Dir(f.path))
			entries, err := os.ReadDir(f.path)
			if err != nil {
				t.Fatal(err)
			}
			view, err := r.ReadHelper(helperContext(t))
			if err != nil || view == nil || (view.Value != nil) != present {
				t.Fatalf("read: %+v %v", view, err)
			}
			if present {
				data, err := os.ReadFile(name)
				if err != nil || !bytes.Equal(data, f.encoded(t, "launch_requested")) || helperFileState(t, name) != before {
					t.Fatal("helper read changed bytes, identity, owner, mode, links, mtime or ctime")
				}
			} else if _, err := os.Lstat(name); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("absent journal changed")
			}
			afterEntries, err := os.ReadDir(f.path)
			if err != nil || !reflect.DeepEqual(entries, afterEntries) || helperFileState(t, f.path) != directory || helperFileState(t, filepath.Dir(f.path)) != ancestor {
				t.Fatal("helper read changed directory metadata or entries")
			}
			if f.admission.verified != 1 || f.admission.retained != 0 || f.admission.unknown || r.unknown {
				t.Fatal("read invoked admission or changed uncertainty")
			}
		})
	}
}

type helperLaggingContext struct {
	context.Context
	until time.Time
	calls atomic.Int32
	once  chan struct{}
}

func (c *helperLaggingContext) Deadline() (time.Time, bool) {
	if c.calls.Add(1) == 1 && c.once != nil {
		close(c.once)
	}
	return c.until, true
}

func TestHelperReadRejectsInvalidAndCancelledContextBeforeQuery(t *testing.T) {
	cancelled, cancel := context.WithDeadline(context.Background(), time.Now().Add(time.Second))
	cancel()
	for _, tc := range []struct {
		name string
		ctx  context.Context
		want error
	}{
		{"nil", nil, port.JournalInvalid},
		{"missing-deadline", context.Background(), port.JournalInvalid},
		{"zero-deadline", &helperLaggingContext{Context: context.Background()}, port.JournalInvalid},
		{"cancelled", cancelled, context.Canceled},
		{"stale-deadline-delayed-err", &helperLaggingContext{Context: context.Background(), until: time.Now().Add(-time.Second)}, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			view, err := r.readHelper(tc.ctx, func(readOptions) (*observation, error) {
				t.Fatal("query issued with invalid context")
				return nil, nil
			})
			if view != nil {
				t.Fatal("invalid context returned view")
			}
			requireError(t, err, tc.want)
		})
	}
}

func TestHelperReadCapturesOriginalDeadlineBeforeGateWait(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	ctx := &helperLaggingContext{Context: context.Background(), until: time.Now().Add(25 * time.Millisecond), once: make(chan struct{})}
	f.gate.Lock()
	result := make(chan error, 1)
	var queried atomic.Bool
	go func() {
		view, err := r.readHelper(ctx, func(readOptions) (*observation, error) {
			queried.Store(true)
			return nil, errors.New("query must not run after original deadline")
		})
		if view != nil {
			result <- errors.New("late gate acquisition returned success")
			return
		}
		result <- err
	}()
	<-ctx.once
	time.Sleep(time.Until(ctx.until) + time.Millisecond)
	f.gate.Unlock()
	requireError(t, <-result, context.DeadlineExceeded)
	if queried.Load() || ctx.calls.Load() != 1 || ctx.Err() != nil || ctx.Done() != nil {
		t.Fatal("deadline renewed or delayed-timer fixture invalid")
	}
}

func TestHelperReadRetainsGateAndQueryFailureThroughActualReturn(t *testing.T) {
	for _, kind := range []string{"cancel-success", "deadline-success", "cancel-opaque", "deadline-unknown"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			r := f.open(t)
			f.put(t, "prepared")
			ctx := helperContext(t)
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			var lag *helperLaggingContext
			if strings.HasPrefix(kind, "deadline") {
				lag = &helperLaggingContext{Context: context.Background(), until: time.Now().Add(250 * time.Millisecond)}
				ctx = lag
			}
			var queryErr error
			if kind == "cancel-opaque" {
				queryErr = errors.New("opaque query failure")
			} else if kind == "deadline-unknown" {
				queryErr = port.JournalUnknown
			}
			entered, drain := make(chan struct{}), make(chan struct{})
			result := make(chan error, 1)
			go func() {
				view, err := r.readHelper(ctx, func(options readOptions) (*observation, error) {
					observed, err := r.readWithOptions(options)
					if err != nil {
						return nil, err
					}
					close(entered)
					<-drain
					return observed, queryErr
				})
				if view != nil {
					result <- errors.New("late query success")
					return
				}
				result <- err
			}()
			select {
			case <-entered:
			case err := <-result:
				t.Fatalf("native query did not reach drain: %v", err)
			}
			if lag == nil {
				cancel()
			} else {
				time.Sleep(time.Until(lag.until) + time.Millisecond)
			}
			if f.gate.TryLock() {
				f.gate.Unlock()
				close(drain)
				t.Fatal("gate released before actual query return")
			}
			closing := make(chan error, 1)
			go func() { closing <- r.Close() }()
			select {
			case <-result:
				close(drain)
				t.Fatal("returned before query drain")
			case <-closing:
				close(drain)
				t.Fatal("Close bypassed query custody")
			default:
			}
			close(drain)
			err := <-result
			requireError(t, err, port.JournalCancelled)
			want := context.Canceled
			if lag != nil {
				want = context.DeadlineExceeded
				if lag.calls.Load() != 1 || lag.Err() != nil {
					t.Fatal("original deadline not retained independently")
				}
			}
			requireError(t, err, want)
			if queryErr != nil {
				requireError(t, err, queryErr)
			}
			if err := <-closing; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNativeHelperReadCancellationAtIOCheckpoints(t *testing.T) {
	for _, point := range []string{"read-absence", "read-open", "read-bytes"} {
		for _, kind := range []string{"cancel", "deadline", "cancel-failure", "deadline-failure"} {
			t.Run(point+"-"+kind, func(t *testing.T) {
				f := newFixture(t)
				r := f.open(t)
				if point != "read-absence" {
					f.put(t, "prepared")
				}
				ctx, cancel := context.WithCancel(helperContext(t))
				defer cancel()
				stop := cancel
				want := context.Canceled
				if strings.HasPrefix(kind, "deadline") {
					lag := &helperLaggingContext{Context: context.Background(), until: time.Now().Add(100 * time.Millisecond)}
					ctx = lag
					stop = func() { time.Sleep(time.Until(lag.until) + time.Millisecond) }
					want = context.DeadlineExceeded
				}
				failure := strings.HasSuffix(kind, "failure")
				r.step = func(at string) error {
					if at == point {
						stop()
						if failure {
							return errors.New("synthetic snapshot race")
						}
					}
					return nil
				}
				view, err := r.ReadHelper(ctx)
				if view != nil {
					t.Fatal("cancelled IO returned late success")
				}
				requireError(t, err, port.JournalCancelled)
				requireError(t, err, want)
				if failure {
					requireError(t, err, port.JournalChanged)
				}
			})
		}
	}
}

func TestHelperReadPreservesQueryFailureWithoutReclassification(t *testing.T) {
	for _, cause := range []error{errors.New("opaque query failure"), port.JournalUnknown} {
		f := newFixture(t)
		r := f.open(t)
		view, err := r.readHelper(helperContext(t), func(readOptions) (*observation, error) {
			return nil, cause
		})
		if view != nil || err != cause {
			t.Fatalf("query failure reclassified: %v", err)
		}
	}
}

func TestNativeHelperReadDoesNotClearOriginalUnknown(t *testing.T) {
	f := newFixture(t)
	first, alias := f.open(t), f.open(t)
	before := mustRead(t, first)
	first.step = func(at string) error {
		if at == "ack-before" {
			return errors.New("synthetic lost acknowledgement")
		}
		return nil
	}
	_, err := first.CompareAndSwap(context.Background(), before.Revision, f.value("launch_requested"))
	requireError(t, err, port.JournalUnknown)
	calls, retained := f.admission.verified, f.admission.retained
	for _, r := range []*Repo{first, alias} {
		view, err := r.ReadHelper(helperContext(t))
		if err != nil || view == nil || view.Value == nil || view.Value.Phase != "launch_requested" {
			t.Fatalf("physical uncertain intent missing: %v", err)
		}
		if release.Assess(release.Observation{Operation: f.operation, Journal: view.Value}).Kind != release.Unresolved {
			t.Fatal("readback supplied effect or startup acceptance")
		}
		_, err = r.CompareAndSwap(context.Background(), view.Revision, f.value("prepared"))
		requireError(t, err, port.JournalUnknown)
		if err := r.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if !first.unknown || !f.admission.unknown || f.admission.verified != calls || f.admission.retained != retained {
		t.Fatal("helper read or Close changed original unknown retention")
	}
}
