package execution

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

// Symbolic reader, route and admission seams. These tests perform no filesystem,
// native process, helper launch or original stopped-writer qualification.
func observationFixture() (ObservationConfig, *testJournal) {
	request := port.HelperRequest{OperationID: strings.Repeat("1", 32), Source: port.HelperBuild{Digest: strings.Repeat("2", 64), Version: "1.0.1", BuildID: strings.Repeat("3", 64)}, Target: port.HelperBuild{Digest: strings.Repeat("4", 64), Version: "1.0.2", BuildID: strings.Repeat("5", 64)}}
	journal := &testJournal{view: port.JournalView{Revision: "observed", Value: &release.Journal{Operation: operation(request), Phase: "verified"}}}
	return ObservationConfig{Request: request, Journal: journal, Until: time.Now().Add(time.Minute), Reverify: func(ctx context.Context, _ port.HelperRequest) error { return ctx.Err() }, Unknown: func() error { return nil }, RetainUnknown: func(error) {}}, journal
}
func observationScope(ctx context.Context, c ObservationConfig, fn func(port.HelperInstallationObservation) error) error {
	return withObservation(ctx, c, func(c context.Context) error { return c.Err() }, fn)
}
func TestObservationScopeHasNoWriterAndEndsAfterReturn(t *testing.T) {
	c, j := observationFixture()
	var kept port.HelperInstallationObservation
	if err := observationScope(context.Background(), c, func(o port.HelperInstallationObservation) error {
		kept = o
		if _, writer := any(o).(port.HelperInstallationRuntime); writer {
			t.Fatal("observer exported installation effects")
		}
		if _, writer := any(o).(port.HelperRecoveryRuntime); writer {
			t.Fatal("observer exported recovery effects")
		}
		if _, writer := any(o).(port.JournalRepository); writer {
			t.Fatal("observer exported journal writer")
		}
		view, err := o.ReadJournal(context.Background())
		if err != nil {
			return err
		}
		view.Value.Phase = "changed"
		view.Revision = "changed"
		if j.view.Value.Phase != "verified" || j.view.Revision != "observed" {
			t.Fatal("read view aliases repository")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := kept.ReadJournal(context.Background()); err == nil {
		t.Fatal("retained observer survived scope")
	}
	if j.writes != 0 || j.closed {
		t.Fatal("observation mutated or closed borrowed journal")
	}
}
func TestObservationScopeRejectsRawFilesAndInvalidReaderResults(t *testing.T) {
	c, j := observationFixture()
	called := false
	if err := WithObservation(context.Background(), c, func(port.HelperInstallationObservation) error { called = true; return nil }); err == nil || called {
		t.Fatal("raw descriptors replaced live borrow")
	}
	for _, kind := range []string{"absent", "nil", "revision", "operation", "opaque"} {
		t.Run(kind, func(t *testing.T) {
			c, j := observationFixture()
			cause := errors.New("private reader cause")
			j.read = func(context.Context) (*port.JournalView, error) {
				switch kind {
				case "absent":
					return &port.JournalView{Revision: "absent"}, nil
				case "nil":
					return nil, nil
				case "revision":
					return &port.JournalView{}, nil
				case "operation":
					v := *j.view.Value
					v.Operation.ID = strings.Repeat("9", 32)
					return &port.JournalView{Revision: "other", Value: &v}, nil
				default:
					return nil, errors.Join(cause, context.Canceled)
				}
			}
			err := observationScope(context.Background(), c, func(o port.HelperInstallationObservation) error {
				v, err := o.ReadJournal(context.Background())
				if kind == "absent" && err == nil && (v == nil || v.Value != nil || v.Revision != "absent") {
					t.Fatal("absence semantics changed")
				}
				if kind != "absent" && v != nil {
					t.Fatal("failed observation returned values")
				}
				return err
			})
			if (kind == "absent") != (err == nil) {
				t.Fatal("reader disposition changed", kind, err)
			}
			if kind == "opaque" && !errors.Is(err, cause) {
				t.Fatal("private cause lost")
			}
			if j.writes != 0 || j.closed {
				t.Fatal("read consumed writer or cleanup")
			}
		})
	}
	if j.writes != 0 || j.closed {
		t.Fatal("borrow failure affected journal")
	}
}
func TestObservationScopeJoinsEnteredReaderAndSuppressesLateResult(t *testing.T) {
	c, j := observationFixture()
	entered, drain, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cause := errors.New("private late query failure")
	j.read = func(context.Context) (*port.JournalView, error) { close(entered); <-drain; return nil, cause }
	method, scope := make(chan error, 1), make(chan error, 1)
	go func() {
		scope <- observationScope(ctx, c, func(o port.HelperInstallationObservation) error {
			go func() {
				v, err := o.ReadJournal(context.Background())
				if v != nil {
					method <- errors.New("late read returned values")
					return
				}
				method <- err
			}()
			<-entered
			close(returned)
			return nil
		})
	}()
	<-returned
	cancel()
	select {
	case <-scope:
		t.Fatal("scope released before actual reader return")
	default:
	}
	close(drain)
	if err := <-method; !errors.Is(err, cause) || !errors.Is(err, context.Canceled) {
		t.Fatal("method lost concurrent causes", err)
	}
	if err := <-scope; !errors.Is(err, context.Canceled) {
		t.Fatal("scope accepted cancelled observation", err)
	}
	if j.closed || j.writes != 0 {
		t.Fatal("cancelled observer closed or mutated borrowed repository")
	}
}
func TestObservationScopeKeepsOriginalAbsoluteBound(t *testing.T) {
	c, j := observationFixture()
	ctx := laggingContext{Context: context.Background(), until: time.Now().Add(-time.Second)}
	calls := 0
	j.read = func(context.Context) (*port.JournalView, error) { calls++; return &j.view, nil }
	err := observationScope(ctx, c, func(o port.HelperInstallationObservation) error {
		_, err := o.ReadJournal(context.Background())
		return err
	})
	if err == nil || calls != 0 || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("expired original deadline renewed", err, calls)
	}
}
