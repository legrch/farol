package helperprotocol

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

type parserFunc func(context.Context, []byte) (port.HelperRequest, error)

func (f parserFunc) Parse(ctx context.Context, b []byte) (port.HelperRequest, error) {
	return f(ctx, b)
}

type codecFixture struct {
	handoff      func(port.HelperHandoffFrame) ([]byte, error)
	continuation func([]byte) (port.HelperContinueFrame, error)
}

func (c codecFixture) Handoff(f port.HelperHandoffFrame) ([]byte, error)   { return c.handoff(f) }
func (c codecFixture) Continue(b []byte) (port.HelperContinueFrame, error) { return c.continuation(b) }

func requestFixture() port.HelperRequest {
	location := "shared"
	return port.HelperRequest{Schema: "farol.installed-update/1", Action: "apply", Home: "/fixture/home", OperationID: strings.Repeat("a", 32),
		Source: port.HelperBuild{Digest: strings.Repeat("b", 64), Version: "0.2.7", BuildID: strings.Repeat("c", 64)},
		Target: port.HelperBuild{Digest: strings.Repeat("d", 64), Version: "0.2.8", BuildID: strings.Repeat("e", 64)},
		PID:    2345, ProcessStart: "Thu Oct 15 12:34:56 2026", WaitSeconds: 30, Relaunch: true, InstallLocation: &location,
		Predecessor:   &port.HelperPredecessor{Kind: "confirmed_closed", StartedAt: "2026-10-15T12:00:00Z", LastQuitSHA256: strings.Repeat("f", 64), StateIdentity: port.HelperIdentity{Device: "1", Inode: "2"}},
		LeaseIdentity: &port.HelperIdentity{Device: "1", Inode: "3"}}
}

func bindFixture(t *testing.T, r port.HelperRequest, c port.HelperProtocolCodec) *Service {
	t.Helper()
	s, err := Bind(context.Background(), []byte("captured input"), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) { return r, nil }), c)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func requireFailure(t *testing.T, err error, code string, isInternal bool) {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f == nil || f.Code != code || f.Internal != isInternal {
		t.Fatalf("failure=%#v (%v), want %s internal=%t", f, err, code, isInternal)
	}
}

func TestBindReusesInputOwnerAndKeepsOriginalSnapshot(t *testing.T) {
	r := requestFixture()
	input := []byte("original request")
	parser := parserFunc(func(_ context.Context, b []byte) (port.HelperRequest, error) {
		if string(b) != "original request" {
			t.Fatal("wrong captured request")
		}
		b[0] = 'X'
		return r, nil
	})
	var captured port.HelperHandoffFrame
	output := []byte("encoded")
	s, err := Bind(context.Background(), input, parser, codecFixture{handoff: func(f port.HelperHandoffFrame) ([]byte, error) {
		captured = f
		f.Correlation.Predecessor.Kind = "mutated adapter"
		return output, nil
	}})
	if err != nil || string(input) != "original request" {
		t.Fatal("binding retained parser input alias", err)
	}
	original := copyRequest(r)
	r.Predecessor.Kind = "mutated parser"
	r.LeaseIdentity.Inode = "999"
	*r.InstallLocation = "legacy"
	frame, err := s.BuildHandoff(context.Background(), ClosedPredecessorReady, nil)
	if err != nil || captured.Schema != HandoffSchema || captured.Phase != ClosedPredecessorReady || captured.Correlation.OperationID != original.OperationID || captured.Correlation.LeaseIdentity.Inode != original.LeaseIdentity.Inode {
		t.Fatal("binding drifted", captured, err)
	}
	output[0] = 'X'
	if string(frame) != "encoded" {
		t.Fatal("frame aliases adapter output")
	}
	got, err := s.Request(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.Predecessor.Kind != original.Predecessor.Kind || got.LeaseIdentity.Inode != original.LeaseIdentity.Inode || *got.InstallLocation != *original.InstallLocation {
		t.Fatal("request aliases parser or frame", got)
	}
	got.Predecessor.Kind = "mutated caller"
	got.LeaseIdentity.Inode = "1000"
	*got.InstallLocation = "elsewhere"
	again, _ := s.Request(context.Background())
	if again.Predecessor.Kind != original.Predecessor.Kind || again.LeaseIdentity.Inode != original.LeaseIdentity.Inode || *again.InstallLocation != *original.InstallLocation {
		t.Fatal("request accessor leaked owner state")
	}
}

func TestHandoffPhasePolicyMatchesExistingObserver(t *testing.T) {
	for _, closed := range []bool{false, true} {
		for _, action := range []string{"apply", "recover", "rollback"} {
			for _, relaunch := range []bool{false, true} {
				r := requestFixture()
				r.Action = action
				r.Relaunch = relaunch
				if !closed {
					r.Predecessor = nil
					r.LeaseIdentity = nil
				}
				s := bindFixture(t, r, codecFixture{handoff: func(port.HelperHandoffFrame) ([]byte, error) { return []byte("frame"), nil }})
				for _, phase := range []string{WaitingForExit, ClosedPredecessorReady, Refused, "unknown"} {
					code := "input"
					var errorCode *string
					if phase == Refused {
						errorCode = &code
					}
					out, err := s.BuildHandoff(context.Background(), phase, errorCode)
					valid := phase == Refused || phase == ClosedPredecessorReady && closed || phase == WaitingForExit && !closed && (action != "recover" || relaunch)
					if valid {
						if err != nil || len(out) == 0 {
							t.Fatal("valid phase refused", closed, action, relaunch, phase, err)
						}
					} else {
						requireFailure(t, err, "handoff_phase", false)
						if out != nil {
							t.Fatal("invalid phase exposed frame")
						}
					}
				}
			}
		}
	}
	for _, code := range []string{"", strings.Repeat("a", 81), "Upper", "bad-code", "line\n", "é", "a.b"} {
		s := bindFixture(t, requestFixture(), codecFixture{})
		_, err := s.BuildHandoff(context.Background(), Refused, &code)
		requireFailure(t, err, "handoff_phase", false)
	}
	for _, code := range []string{"a", strings.Repeat("z", 80), "input_123"} {
		s := bindFixture(t, requestFixture(), codecFixture{handoff: func(f port.HelperHandoffFrame) ([]byte, error) {
			if f.Error == nil || *f.Error != code {
				t.Fatal("error code lost")
			}
			return []byte("frame"), nil
		}})
		if _, err := s.BuildHandoff(context.Background(), Refused, &code); err != nil {
			t.Fatal(err)
		}
	}
}

func TestContinuationComparesEveryOriginalField(t *testing.T) {
	edits := map[string]func(*port.HelperContinueFrame){
		"schema":         func(f *port.HelperContinueFrame) { f.Schema = "other" },
		"operation":      func(f *port.HelperContinueFrame) { f.Correlation.OperationID = "other" },
		"action":         func(f *port.HelperContinueFrame) { f.Correlation.Action = "recover" },
		"source digest":  func(f *port.HelperContinueFrame) { f.Correlation.Source.Digest = "other" },
		"source version": func(f *port.HelperContinueFrame) { f.Correlation.Source.Version = "other" },
		"source build":   func(f *port.HelperContinueFrame) { f.Correlation.Source.BuildID = "other" },
		"target digest":  func(f *port.HelperContinueFrame) { f.Correlation.Target.Digest = "other" },
		"target version": func(f *port.HelperContinueFrame) { f.Correlation.Target.Version = "other" },
		"target build":   func(f *port.HelperContinueFrame) { f.Correlation.Target.BuildID = "other" },
		"pid":            func(f *port.HelperContinueFrame) { f.Correlation.PID++ },
		"birth":          func(f *port.HelperContinueFrame) { f.Correlation.ProcessStart += " " },
		"missing proof":  func(f *port.HelperContinueFrame) { f.Correlation.Predecessor = nil },
		"missing lease":  func(f *port.HelperContinueFrame) { f.Correlation.LeaseIdentity = nil },
		"kind":           func(f *port.HelperContinueFrame) { f.Correlation.Predecessor.Kind = "other" },
		"started":        func(f *port.HelperContinueFrame) { f.Correlation.Predecessor.StartedAt += " " },
		"quit":           func(f *port.HelperContinueFrame) { f.Correlation.Predecessor.LastQuitSHA256 = "other" },
		"state device":   func(f *port.HelperContinueFrame) { f.Correlation.Predecessor.StateIdentity.Device = "9" },
		"state inode":    func(f *port.HelperContinueFrame) { f.Correlation.Predecessor.StateIdentity.Inode = "9" },
		"lease device":   func(f *port.HelperContinueFrame) { f.Correlation.LeaseIdentity.Device = "9" },
		"lease inode":    func(f *port.HelperContinueFrame) { f.Correlation.LeaseIdentity.Inode = "9" },
	}
	for name, edit := range edits {
		t.Run(name, func(t *testing.T) {
			r := requestFixture()
			s := bindFixture(t, r, codecFixture{continuation: func(raw []byte) (port.HelperContinueFrame, error) {
				f := port.HelperContinueFrame{Schema: ContinueSchema, Correlation: correlation(r)}
				edit(&f)
				return f, nil
			}})
			requireFailure(t, s.ValidateContinuation(context.Background(), []byte("complete frame")), "continue_identity", false)
		})
	}
	r := requestFixture()
	s := bindFixture(t, r, codecFixture{continuation: func(raw []byte) (port.HelperContinueFrame, error) {
		return port.HelperContinueFrame{Schema: ContinueSchema, Correlation: correlation(r)}, nil
	}})
	for range 2 {
		if err := s.ValidateContinuation(context.Background(), []byte("complete frame")); err != nil {
			t.Fatal("pure validation should be repeatable", err)
		}
	}
	r.Predecessor = nil
	r.LeaseIdentity = nil
	s = bindFixture(t, r, codecFixture{})
	requireFailure(t, s.ValidateContinuation(context.Background(), []byte("frame")), "continue_identity", false)
}

func TestClosedErrorsBoundsAndCancellation(t *testing.T) {
	for _, code := range []string{"input", "acceptance", "canceled", "unavailable", "private adapter detail"} {
		_, err := Bind(context.Background(), []byte("raw"), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) {
			return port.HelperRequest{}, errors.New(code)
		}), codecFixture{})
		if code == "input" || code == "acceptance" || code == "canceled" {
			requireFailure(t, err, code, false)
		} else {
			requireFailure(t, err, "internal", true)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, err := Bind(ctx, []byte("raw"), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) { cancel(); return requestFixture(), nil }), codecFixture{})
	requireFailure(t, err, "canceled", false)
	for _, size := range []int{0, 8193} {
		_, err := Bind(context.Background(), make([]byte, size), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) {
			t.Fatal("out of bounds parsed")
			return port.HelperRequest{}, nil
		}), codecFixture{})
		requireFailure(t, err, "input", false)
	}
	for _, code := range []string{"helper_protocol_size", "helper_protocol_encoding", "other detail"} {
		s := bindFixture(t, requestFixture(), codecFixture{handoff: func(port.HelperHandoffFrame) ([]byte, error) { return nil, errors.New(code) }})
		_, err := s.BuildHandoff(context.Background(), ClosedPredecessorReady, nil)
		if code == "helper_protocol_size" {
			requireFailure(t, err, "handoff_size", false)
		} else {
			requireFailure(t, err, "internal", true)
		}
	}
	for _, code := range []string{"helper_protocol_size", "helper_protocol_input", "other detail"} {
		s := bindFixture(t, requestFixture(), codecFixture{continuation: func([]byte) (port.HelperContinueFrame, error) { return port.HelperContinueFrame{}, errors.New(code) }})
		err := s.ValidateContinuation(context.Background(), []byte("frame"))
		if code == "helper_protocol_size" {
			requireFailure(t, err, "continue_size", false)
		} else if code == "helper_protocol_input" {
			requireFailure(t, err, "continue_invalid", false)
		} else {
			requireFailure(t, err, "internal", true)
		}
	}
	for _, method := range []string{"handoff", "continue"} {
		ctx, cancel := context.WithCancel(context.Background())
		r := requestFixture()
		s := bindFixture(t, r, codecFixture{handoff: func(port.HelperHandoffFrame) ([]byte, error) { cancel(); return []byte("late"), nil }, continuation: func([]byte) (port.HelperContinueFrame, error) {
			cancel()
			return port.HelperContinueFrame{Schema: ContinueSchema, Correlation: correlation(r)}, nil
		}})
		if method == "handoff" {
			out, err := s.BuildHandoff(ctx, ClosedPredecessorReady, nil)
			requireFailure(t, err, "canceled", false)
			if out != nil {
				t.Fatal("late frame exposed")
			}
		} else {
			requireFailure(t, s.ValidateContinuation(ctx, []byte("frame")), "canceled", false)
		}
	}
}
