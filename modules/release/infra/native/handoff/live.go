package handoff

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"math"
	"os"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
)

// Live is the original running-marker/Quit owner for live and offline helpers.
// It has no inherited lease, closed-proof adapter or effect capability. Boot
// holds its separately acquired promotion lease before VerifyQuit/CheckStopped.
type Live struct {
	route *Verifier
	wait  port.ProcessWaiter
	until time.Time
	state *liveState
}

// Copies retain the same one-shot attempts and receipt/marker witnesses. The
// original route gate serializes this state with borrowed native operations.
type liveState struct {
	markerAttempt, markerCaptured, waitAttempt, stopped bool
	started                                             string
	quitDigest                                          [32]byte
	quitBound                                           bool
	markerDigest                                        [32]byte
}

const errRunMarkerMismatch Code = "run_marker_mismatch"

func NewLive(homePath string, home, state *os.File, identity Identity, pid int, start string, wait port.ProcessWaiter, until time.Time) (*Live, error) {
	if home == nil || state == nil || !validHome(homePath) || !validIdentity(identity) || until.IsZero() || pid <= 1 || !validText(start, 128) || wait == nil {
		return nil, ErrInput
	}
	return &Live{state: &liveState{}, route: &Verifier{homePath: homePath, home: home, state: state, expected: Expected{StateIdentity: identity, PID: pid, ProcessStart: start}, now: time.Now, gate: make(chan struct{}, 1), reopen: openRoute}, wait: wait, until: until}, nil
}

func (l *Live) run(ctx context.Context, fn func(context.Context, int, int) error) error {
	if l == nil || l.route == nil || l.state == nil || ctx == nil {
		return ErrDependency
	}
	ctx, cancel := context.WithDeadline(ctx, l.until)
	defer cancel()
	v := l.route
	return v.withFiles(ctx, []*os.File{v.home, v.state}, func(fds []int) error {
		if err := v.verifyRoute(ctx, fds[0], fds[1]); err != nil {
			return err
		}
		if err := fn(ctx, fds[0], fds[1]); err != nil {
			return err
		}
		return v.verifyRoute(ctx, fds[0], fds[1])
	})
}

// CaptureMarker consumes the single original marker observation. The strict
// parser and before/held/named physical checks belong to this handoff owner.
func (l *Live) CaptureMarker(ctx context.Context) error {
	return l.run(ctx, func(ctx context.Context, _ int, state int) error {
		if l.state.markerAttempt {
			return ErrRunningMarker
		}
		l.state.markerAttempt = true
		data, err := readRecord(ctx, state, "running.json", 4096)
		if err != nil {
			return err
		}
		at, err := liveMarker(data, l.route.expected.PID, l.route.expected.ProcessStart)
		if err != nil {
			return err
		}
		if err := canceled(ctx); err != nil {
			return err
		}
		l.state.started, l.state.markerCaptured = at, true
		l.state.markerDigest = sha256.Sum256(data)
		return nil
	})
}

func liveMarker(data []byte, expectedPID int, expectedStart string) (string, error) {
	fields, err := recordFields(data)
	if err != nil || len(fields) != 5 || !bytes.Equal(bytes.TrimSpace(fields["schema"]), []byte("1")) {
		return "", errRunMarkerMismatch
	}
	var pid int
	var start, at string
	_, bootPresent := fields["bootTime"]
	// Match the current producer's value schema. These fields still supply no
	// process or lease authentication; the original native owners supply that.
	if !bootPresent || json.Unmarshal(fields["pid"], &pid) != nil || pid != expectedPID || json.Unmarshal(fields["processStart"], &start) != nil || start != expectedStart || json.Unmarshal(fields["startedAt"], &at) != nil {
		return "", errRunMarkerMismatch
	}
	boot := bytes.TrimSpace(fields["bootTime"])
	var bootMillis float64
	if !bytes.Equal(boot, []byte("null")) && (json.Unmarshal(boot, &bootMillis) != nil || bootMillis < 0 || bootMillis > 9007199254740991 || math.Trunc(bootMillis) != bootMillis) {
		return "", errRunMarkerMismatch
	}
	parsed, ok := timestamp(at)
	if !ok || parsed.UTC().Format("2006-01-02T15:04:05.000Z") != at {
		return "", errRunMarkerMismatch
	}
	return at, nil
}

func (l *Live) ConfirmIdentity(ctx context.Context) error {
	return l.run(ctx, func(ctx context.Context, _ int, _ int) error {
		if !l.state.markerCaptured {
			return ErrRunningMarker
		}
		return l.wait.ConfirmIdentity(ctx, l.until)
	})
}

// CheckMarker rechecks the original marker without adopting a replacement or
// consuming another process confirmation.
func (l *Live) CheckMarker(ctx context.Context) error {
	return l.run(ctx, func(ctx context.Context, _ int, state int) error {
		if !l.state.markerCaptured || l.state.stopped {
			return ErrRunningMarker
		}
		data, err := readRecord(ctx, state, "running.json", 4096)
		if err != nil {
			return err
		}
		if sha256.Sum256(data) != l.state.markerDigest {
			return ErrRunningMarker
		}
		return nil
	})
}

// WaitExit observes only the already positively identified original process.
// Its timeout/unknown state is never converted into a closed predecessor proof.
func (l *Live) WaitExit(ctx context.Context, originalUntil time.Time) error {
	if ctx == nil {
		return ErrDependency
	}
	// The wait's original end covers final route verification and joined
	// cleanup too. run independently keeps any earlier operation/caller bound.
	ctx, cancel := context.WithDeadline(ctx, originalUntil)
	defer cancel()
	return l.run(ctx, func(ctx context.Context, _ int, _ int) error {
		if l.state.waitAttempt {
			return ErrProcessUnknown
		}
		l.state.waitAttempt = true
		until := l.until
		if originalUntil.Before(until) {
			until = originalUntil
		}
		if err := l.wait.WaitExit(ctx, until); err != nil {
			return err
		}
		if err := canceled(ctx); err != nil {
			return err
		}
		l.state.stopped = true
		return nil
	})
}

// VerifyQuit follows actual WaitExit (live) or the offline owner's acquired
// promotion lease. It records the first exact confirmed receipt and never adopts
// a later replacement. This observation alone grants no writer admission.
func (l *Live) VerifyQuit(ctx context.Context, offline bool) error {
	return l.run(ctx, func(ctx context.Context, _ int, state int) error {
		if !offline && (!l.state.stopped || !l.state.markerCaptured) || offline && l.state.markerAttempt {
			return ErrProcessUnknown
		}
		if _, present, err := named(ctx, state, "running.json", ErrProcessUnknown); err != nil {
			return err
		} else if present {
			return ErrRunningMarker
		}
		data, err := readQuit(ctx, state)
		if err != nil {
			return err
		}
		at, err := quitTimestamp(data)
		if err != nil {
			return err
		}
		var started *time.Time
		if !offline {
			value, _ := timestamp(l.state.started)
			started = &value
		}
		if l.route.now == nil {
			return ErrDependency
		}
		if err := canceled(ctx); err != nil {
			return err
		}
		now := l.route.now()
		if err := canceled(ctx); err != nil {
			return err
		}
		if err := verifyQuitTime(at, started, now); err != nil {
			return err
		}
		digest := sha256.Sum256(data)
		if l.state.quitBound && digest != l.state.quitDigest {
			return ErrQuitChanged
		}
		if err := canceled(ctx); err != nil {
			return err
		}
		// Later route/absence/cleanup refusal cannot authorize adopting another
		// receipt. Rechecks retain these first physically verified bytes.
		l.state.quitDigest, l.state.quitBound = digest, true
		if _, present, err := named(ctx, state, "running.json", ErrProcessUnknown); err != nil {
			return err
		} else if present {
			return ErrRunningMarker
		}
		return canceled(ctx)
	})
}

// recordFields rejects duplicate keys and replacement Unicode before decoding.
// Both original marker and Quit parsing remain within this handoff owner.
func recordFields(data []byte) (map[string]json.RawMessage, error) {
	if !strictUnicode(data) {
		return nil, ErrQuitInvalid
	}
	d := json.NewDecoder(bytes.NewReader(data))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return nil, ErrQuitInvalid
	}
	fields := make(map[string]json.RawMessage)
	for d.More() {
		t, err = d.Token()
		key, ok := t.(string)
		if err != nil || !ok {
			return nil, ErrQuitInvalid
		}
		if _, exists := fields[key]; exists {
			return nil, ErrQuitInvalid
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, ErrQuitInvalid
		}
		fields[key] = value
	}
	t, err = d.Token()
	var extra any
	if err != nil || t != json.Delim('}') || d.Decode(&extra) != io.EOF {
		return nil, ErrQuitInvalid
	}
	return fields, nil
}
