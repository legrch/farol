package boot

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	"github.com/legrch/farol/modules/release/app/services/processwait"
	"github.com/legrch/farol/modules/release/infra/native/handoff"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	"github.com/legrch/farol/modules/release/infra/native/helperlocks"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	"github.com/legrch/farol/modules/release/infra/native/slotbinding"
)

// The pre-ACK refusal contract (see releasehelperrefusal.go) is asserted for the
// closed and the live compositions through one table. Both use the private
// symbolic seams of their unit fixtures; the native lanes prove the real
// descriptors and owners.

// refusalSite names where a failure is injected into a composition.
type refusalSite string

const (
	siteReady     refusalSite = "ready"
	siteCheck     refusalSite = "check"     // The first custody fence.
	siteAdmission refusalSite = "admission" // Admission construction.
	siteConfirm   refusalSite = "confirm"   // Live only: process identity.
	siteAcquire   refusalSite = "acquire"   // Live only: update lock.
)

type refusalRun struct {
	line   []byte
	exit   int
	frames [][]byte
	input  []byte
	// Effects that must never follow a refusal.
	effects int
	events  []string
}

type refusalInput struct {
	site refusalSite
	err  error
	// Seam behaviours.
	emitErr, channelClose error
	retainBeforeReady     bool
	expireBeforeReady     bool
}

type refusalHarness struct {
	name string
	run  func(t *testing.T, in refusalInput) refusalRun
	live bool
}

func closedRefusalRun(t *testing.T, in refusalInput) refusalRun {
	t.Helper()
	f := newClosedHelperFixture(t)
	deps := f.deps()
	f.emitErr, f.channelClose = in.emitErr, in.channelClose
	until := time.Now().Add(10 * time.Second)
	switch in.site {
	case siteReady:
		f.readyErr = in.err
	case siteCheck:
		f.failCheck, f.checkErr = 1, in.err
	case siteAdmission:
		deps.admission = func(helperroutes.Files, *os.File, releaseport.HelperRequest, []byte, time.Time) (closedHelperAdmission, error) {
			f.event("admission")
			return nil, in.err
		}
	default:
		t.Fatal("site", in.site)
	}
	if in.retainBeforeReady {
		f.beforeReady = func(context.Context) { f.readyHelper.retainUnknown(errors.New("sticky")) }
	}
	if in.expireBeforeReady {
		until = time.Now().Add(60 * time.Millisecond)
		f.beforeReady = func(context.Context) { time.Sleep(90 * time.Millisecond) }
	}
	line, exit := closedHelperEntry(context.Background(), closedHelperFiles{}, until, deps)
	return refusalRun{line, exit, f.frames, f.input, f.execCalls + f.acquired + f.callback, f.events}
}

func liveRefusalRun(t *testing.T, in refusalInput) refusalRun {
	t.Helper()
	f := newLiveHelperFixture(t)
	deps := f.deps()
	f.emitErr, f.channelClose = in.emitErr, in.channelClose
	until := time.Now().Add(10 * time.Second)
	switch in.site {
	case siteReady:
		f.readyErr = in.err
	case siteCheck:
		f.failCheck, f.checkErr = 1, in.err
	case siteAdmission:
		deps.admission = func(helperroutes.Files, releaseport.HelperRequest, []byte, time.Time) (liveHelperAdmission, error) {
			f.event("admission")
			return nil, in.err
		}
	case siteConfirm:
		f.confirmErr = in.err
	case siteAcquire:
		f.acquireErr = in.err
	default:
		t.Fatal("site", in.site)
	}
	if in.retainBeforeReady {
		f.beforeReady = func(h closedReleaseHelper) { h.retainUnknown(errors.New("sticky")) }
	}
	if in.expireBeforeReady {
		until = time.Now().Add(60 * time.Millisecond)
		f.beforeReady = func(closedReleaseHelper) { time.Sleep(90 * time.Millisecond) }
	}
	line, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, until, deps)
	return refusalRun{line, exit, f.frames, f.input, f.execCalls + f.count("wait") + f.count("quit"), f.events}
}

var refusalHarnesses = []refusalHarness{
	{name: "closed", run: closedRefusalRun},
	{name: "live", run: liveRefusalRun, live: true},
}

func refusalLine(phase, code string) string {
	return `{"phase": "` + phase + `", "error": "` + code + `", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
}

// wantRefusedFrame is the exact frame the existing protocol owner builds.
func wantRefusedFrame(t *testing.T, input []byte, code string) []byte {
	t.Helper()
	protocol, err := protocolapp.Bind(context.Background(), input, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	want, err := protocol.BuildHandoff(context.Background(), protocolapp.Refused, &code)
	if err != nil || len(want) == 0 {
		t.Fatal("refused frame", err)
	}
	return want
}

func TestHelperCleanPreACKRefusalSendsOneRefusedFrame(t *testing.T) {
	type tc struct {
		name        string
		in          refusalInput
		phase, code string
		liveOnly    bool
	}
	cases := []tc{
		{name: "readiness-operation_exists", in: refusalInput{site: siteReady, err: &executionapp.Failure{Phase: "refused", Code: "operation_exists"}}, phase: "refused", code: "operation_exists"},
		{name: "readiness-staged_missing", in: refusalInput{site: siteReady, err: &executionapp.Failure{Phase: "refused", Code: "staged_missing"}}, phase: "refused", code: "staged_missing"},
		{name: "readiness-digest-keeps-its-phase", in: refusalInput{site: siteReady, err: &executionapp.Failure{Phase: "prepared", Code: "digest"}}, phase: "prepared", code: "digest"},
		{name: "slot-binding-at-admission", in: refusalInput{site: siteAdmission, err: &slotbinding.VerificationFailure{Code: "slot_binding_mismatch"}}, phase: "refused", code: "slot_binding_mismatch"},
		{name: "slot-binding-at-custody-fence", in: refusalInput{site: siteCheck, err: &slotbinding.VerificationFailure{Code: "slot_binding_changed"}}, phase: "refused", code: "slot_binding_changed"},
		{name: "custody-code", in: refusalInput{site: siteCheck, err: handoff.ErrProcessRunning}, phase: "refused", code: "closed_process_running"},
		{name: "route-refusal", in: refusalInput{site: siteAdmission, err: &helperroutes.Error{Code: helperroutes.CodeChanged}}, phase: "refused", code: "changed"},
		{name: "live-identity-mismatch", in: refusalInput{site: siteConfirm, err: &processwait.Failure{Code: "process_identity"}}, phase: "refused", code: "process_identity", liveOnly: true},
		{name: "live-update-busy", in: refusalInput{site: siteAcquire, err: &helperlocks.Failure{Code: "update_busy"}}, phase: "refused", code: "update_busy", liveOnly: true},
	}
	for _, h := range refusalHarnesses {
		for _, c := range cases {
			if c.liveOnly && !h.live {
				continue
			}
			t.Run(h.name+"/"+c.name, func(t *testing.T) {
				r := h.run(t, c.in)
				if r.exit != 70 || string(r.line) != refusalLine(c.phase, c.code) {
					t.Fatalf("exit %d line %q", r.exit, r.line)
				}
				if len(r.frames) != 1 || !bytes.Equal(r.frames[0], wantRefusedFrame(t, r.input, c.code)) {
					t.Fatalf("frames %q", r.frames)
				}
				if r.effects != 0 {
					t.Fatalf("a refusal reached an effect: %v", r.events)
				}
				for _, e := range []string{"continue", "execute", "callback"} {
					if closedHelperHas(r.events, e) {
						t.Fatalf("refusal reached %s: %v", e, r.events)
					}
				}
			})
		}
	}
}

func TestHelperPreACKFailuresStayUnknownWithoutAFrame(t *testing.T) {
	clean := func() *executionapp.Failure { return &executionapp.Failure{Phase: "refused", Code: "operation_exists"} }
	var typedNil *executionapp.Failure
	cases := map[string]refusalInput{
		"uncertain":       {site: siteReady, err: &executionapp.Failure{Phase: "refused", Code: "operation_exists", Uncertain: true}},
		"internal":        {site: siteReady, err: &executionapp.Failure{Phase: "refused", Code: "internal", Internal: true}},
		"opaque":          {site: siteReady, err: errors.New("opaque")},
		"joined":          {site: siteReady, err: errors.Join(clean())},
		"wrapped":         {site: siteReady, err: fmt.Errorf("wrapped: %w", clean())},
		"typed-nil":       {site: siteReady, err: typedNil},
		"bad-code":        {site: siteReady, err: &executionapp.Failure{Phase: "refused", Code: "Not A Code"}},
		"bad-phase":       {site: siteReady, err: &executionapp.Failure{Phase: "Not A Phase", Code: "operation_exists"}},
		"slot-internal":   {site: siteAdmission, err: &slotbinding.VerificationFailure{Code: "slot_binding_internal"}},
		"slot-flagged":    {site: siteAdmission, err: &slotbinding.VerificationFailure{Code: "slot_binding_mismatch", Internal: true}},
		"handoff-unsure":  {site: siteCheck, err: &handoff.Failure{Code: handoff.ErrProcessRunning, Uncertain: true}},
		"sticky":          {site: siteReady, err: clean(), retainBeforeReady: true},
		"bound-elapsed":   {site: siteReady, err: clean(), expireBeforeReady: true},
		"opaque-check":    {site: siteCheck, err: errors.New("opaque")},
		"opaque-ctor":     {site: siteAdmission, err: errors.New("opaque")},
		"cancel-in-check": {site: siteCheck, err: context.Canceled},
	}
	for _, h := range refusalHarnesses {
		for name, in := range cases {
			t.Run(h.name+"/"+name, func(t *testing.T) {
				r := h.run(t, in)
				// The ID is learned when the readiness scope holds the parsed request;
				// an earlier failure names none.
				want := liveHelperUnknownLine
				if !closedHelperHas(r.events, "ready") {
					want = `{"phase": "unknown", "error": "internal"}` + "\n"
				}
				if r.exit != 79 || string(r.line) != want {
					t.Fatalf("exit %d line %q want %q", r.exit, r.line, want)
				}
				if len(r.frames) != 0 || r.effects != 0 {
					t.Fatalf("an unproven failure sent a frame or reached an effect: %q %v", r.frames, r.events)
				}
			})
		}
	}
}

// A failed refused-frame write may have exposed bytes: unknown, one attempt only.
func TestHelperRefusedFrameWriteFailureIsUnknownAndNeverRetried(t *testing.T) {
	for _, h := range refusalHarnesses {
		t.Run(h.name, func(t *testing.T) {
			r := h.run(t, refusalInput{site: siteReady, err: &executionapp.Failure{Phase: "refused", Code: "digest"}, emitErr: errors.New("write failed")})
			if r.exit != 79 || string(r.line) != liveHelperUnknownLine {
				t.Fatalf("exit %d line %q", r.exit, r.line)
			}
			if len(r.frames) != 1 {
				t.Fatalf("refused frame attempts %d, want exactly one", len(r.frames))
			}
			if r.effects != 0 {
				t.Fatal("effects after a failed refusal", r.events)
			}
		})
	}
}

// Cleanup that fails after the refused frame makes the outcome unknown.
func TestHelperRefusedFrameThenCleanupFailureIsUnknown(t *testing.T) {
	for _, h := range refusalHarnesses {
		t.Run(h.name, func(t *testing.T) {
			r := h.run(t, refusalInput{site: siteReady, err: &executionapp.Failure{Phase: "refused", Code: "digest"}, channelClose: errors.New("close failed")})
			if r.exit != 79 || string(r.line) != liveHelperUnknownLine || len(r.frames) != 1 {
				t.Fatalf("exit %d line %q frames %d", r.exit, r.line, len(r.frames))
			}
		})
	}
}

// After the first frame no refused frame follows: the post-ACK failure is unknown
// and the only frame is the ready / waiting_for_exit one.
func TestHelperNoRefusedFrameAfterTheFirstFrame(t *testing.T) {
	t.Run("closed", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		f.continueErr = handoff.ErrProcessRunning
		line, exit := closedHelperEntryRun(t, f)
		if exit != 79 || string(line) != liveHelperUnknownLine || len(f.frames) != 1 || bytes.Contains(f.frames[0], []byte(`"refused"`)) {
			t.Fatalf("exit %d line %q frames %q", exit, line, f.frames)
		}
		g := newClosedHelperFixture(t)
		g.failCheck, g.checkErr = 3, handoff.ErrProcessRunning // The fence after the ready frame.
		line, exit = closedHelperEntryRun(t, g)
		if exit != 79 || string(line) != liveHelperUnknownLine || len(g.frames) != 1 || bytes.Contains(g.frames[0], []byte(`"refused"`)) {
			t.Fatalf("exit %d line %q frames %q", exit, line, g.frames)
		}
	})
	t.Run("live", func(t *testing.T) {
		for name, set := range map[string]func(*liveHelperFixture){
			"wait":  func(f *liveHelperFixture) { f.waitErr = &processwait.Failure{Code: "process_running"} },
			"quit":  func(f *liveHelperFixture) { f.quitErr = handoff.ErrQuitStale },
			"fence": func(f *liveHelperFixture) { f.failCheck, f.checkErr = 5, handoff.ErrProcessRunning },
		} {
			t.Run(name, func(t *testing.T) {
				f := newLiveHelperFixture(t)
				set(f)
				line, exit := f.entry()
				if exit != 79 || string(line) != liveHelperUnknownLine || len(f.frames) != 1 || bytes.Contains(f.frames[0], []byte(`"refused"`)) {
					t.Fatalf("exit %d line %q frames %q", exit, line, f.frames)
				}
			})
		}
	})
}
