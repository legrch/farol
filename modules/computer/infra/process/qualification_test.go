package process

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// All conformance results below come from a labelled PRIVATE boundary double.
// No file, endpoint, process identity, native constructor or OS executor is used.
// A PASS here is control/binding proof, never native qualification.
type probeDouble struct {
	calls  []string
	fail   string
	pid    int
	before func(string)
}

func (p *probeDouble) call(value string) error {
	p.calls = append(p.calls, value)
	if p.before != nil {
		p.before(value)
	}
	if value == p.fail {
		return errors.New("unqualified vector")
	}
	return nil
}
func (p *probeDouble) Allowed(_ context.Context, path, hash string) error {
	return p.call("baseline:" + path + ":" + hash)
}
func (p *probeDouble) DeniedRead(_ context.Context, path string) error { return p.call("read:" + path) }
func (p *probeDouble) DeniedWrite(_ context.Context, path string) error {
	return p.call("write:" + path)
}
func (p *probeDouble) DeniedConnect(_ context.Context, value string) error {
	return p.call("connect:" + value)
}
func (p *probeDouble) CurrentProcess() int { return p.pid }
func qualificationFixture(t *testing.T) (*QualificationAttempt, Command, Command, NativeFixture, *probeDouble, *testClock, time.Time) {
	t.Helper()
	p, _, clock, _ := fixture(t)
	original := copyCommand(p.command)
	original.Root, original.Cwd = "/private/tmp/farol-qualification", "/private/tmp/farol-qualification"
	original.Binding = &InvocationBinding{RuntimeID: "runtime", SessionID: "session", ModelID: "model", AdmissionID: "admission"}
	original.Confinement = &ConfinementBinding{ProfileSHA256: strings.Repeat("c", 64), MechanismSHA256: strings.Repeat("b", 64)}
	wrapped := copyCommand(original)
	wrapped.Executable, wrapped.ExecutableSHA256 = seatbeltExecutable, strings.Repeat("b", 64)
	wrapped.Args = append([]string{"-p", "synthetic profile double", "--", original.Executable}, original.Args...)
	f := NativeFixture{Nonce: strings.Repeat("d", 32), AllowedSHA256: strings.Repeat("e", 64), AllowedRead: original.Root + "/allowed", OutsideRead: "/private/tmp/farol-outside/read", CredentialRead: original.Root + "/.ssh/key", AliasRead: original.Root + "/alias", HardlinkRead: original.Root + "/hardlink", ReadOnlyWrite: original.Root + "/read-only", Loopback4: "127.0.0.1:32123", Loopback6: "[::1]:32124"}
	probe := &probeDouble{pid: 123}
	return &QualificationAttempt{probe: probe, clock: clock}, original, wrapped, f, probe, clock, clock.Now().Add(15 * time.Second)
}
func TestNativeQualificationDoubleRequiresEveryVectorOnceAndExactLease(t *testing.T) {
	a, original, wrapped, f, probe, clock, deadline := qualificationFixture(t)
	q, err := a.Run(context.Background(), original, wrapped, f, deadline)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"baseline:" + f.AllowedRead + ":" + f.AllowedSHA256, "read:" + f.OutsideRead, "read:" + f.CredentialRead, "read:" + f.AliasRead, "read:" + f.HardlinkRead, "write:" + f.ReadOnlyWrite, "connect:" + f.Loopback4, "connect:" + f.Loopback6}
	if !slices.Equal(probe.calls, expected) || !q.deadline.Equal(deadline) || !q.matchesGuest(original) {
		t.Fatal("missing or reordered vector / extended lease")
	}
	if q.Qualify(context.Background(), wrapped) != nil || len(probe.calls) != 8 {
		t.Fatal("inspection ran probes")
	}
	for _, change := range []func(*Command){func(c *Command) { c.Input[0] = 'X' }, func(c *Command) { c.Args[1] = "other" }, func(c *Command) { c.Binding.AdmissionID = "other" }, func(c *Command) { c.Confinement.ProfileSHA256 = strings.Repeat("f", 64) }, func(c *Command) { c.ExecutableSHA256 = strings.Repeat("f", 64) }} {
		changed := copyCommand(wrapped)
		change(&changed)
		if q.Qualify(context.Background(), changed) == nil {
			t.Fatal("command drift qualified")
		}
	}
	changed := copyCommand(original)
	changed.ExecutableSHA256 = strings.Repeat("f", 64)
	if q.matchesGuest(changed) {
		t.Fatal("original image seal omitted")
	}
	probe.pid++ // Different held process/restart cannot consume this in-memory proof.
	if q.Qualify(context.Background(), wrapped) == nil {
		t.Fatal("proof reused in another process")
	}
	probe.pid--
	clock.value = deadline
	if q.Qualify(context.Background(), wrapped) == nil {
		t.Fatal("proof renewed after original expiry")
	}
	_, err = a.Run(context.Background(), original, wrapped, f, deadline.Add(time.Hour))
	var failed *processsvc.NativeFailure
	if !errors.As(err, &failed) || !failed.Unknown || len(probe.calls) != 8 {
		t.Fatal("second attempt after expiry", err)
	}
}
func TestNativeQualificationDoubleStopsOnAnyMissingDenialWithoutRetry(t *testing.T) {
	for _, vector := range []string{"baseline", "outside", "credential", "alias", "hardlink", "write", "ipv4", "ipv6"} {
		t.Run(vector, func(t *testing.T) {
			a, original, wrapped, f, probe, _, deadline := qualificationFixture(t)
			values := map[string]string{"baseline": "baseline:" + f.AllowedRead + ":" + f.AllowedSHA256, "outside": "read:" + f.OutsideRead, "credential": "read:" + f.CredentialRead, "alias": "read:" + f.AliasRead, "hardlink": "read:" + f.HardlinkRead, "write": "write:" + f.ReadOnlyWrite, "ipv4": "connect:" + f.Loopback4, "ipv6": "connect:" + f.Loopback6}
			probe.fail = values[vector]
			if q, err := a.Run(context.Background(), original, wrapped, f, deadline); q != nil || err == nil {
				t.Fatal("unqualified vector ignored")
			}
			first := len(probe.calls)
			if probe.calls[first-1] != probe.fail {
				t.Fatal("continued after unqualified vector")
			}
			probe.fail = ""
			if _, err := a.Run(context.Background(), original, wrapped, f, deadline); err == nil || len(probe.calls) != first {
				t.Fatal("conformance retried after refusal")
			}
		})
	}
}
func TestNativeQualificationMalformedFixtureAndWrappedBindingHaveNoProbe(t *testing.T) {
	cases := map[string]func(*Command, *Command, *NativeFixture){
		"missing-hardlink":  func(_, _ *Command, f *NativeFixture) { f.HardlinkRead = "" },
		"duplicate":         func(_, _ *Command, f *NativeFixture) { f.AliasRead = f.AllowedRead },
		"wrong-scope":       func(_, w *Command, _ *NativeFixture) { w.Root = "/owner/code" },
		"external-endpoint": func(_, _ *Command, f *NativeFixture) { f.Loopback4 = "example.com:80" },
		"wrong-ipv6":        func(_, _ *Command, f *NativeFixture) { f.Loopback6 = "127.0.0.1:32124" },
		"noncanonical-port": func(_, _ *Command, f *NativeFixture) { f.Loopback4 = "127.0.0.1:032123" },
		"nonce":             func(_, _ *Command, f *NativeFixture) { f.Nonce = strings.Repeat("z", 32) },
		"write":             func(o, w *Command, _ *NativeFixture) { o.Write = true; w.Write = true },
		"argv":              func(_, w *Command, _ *NativeFixture) { w.Args[len(w.Args)-1] = "different" },
		"stdin":             func(_, w *Command, _ *NativeFixture) { w.Input = []byte("different") },
		"environment":       func(_, w *Command, _ *NativeFixture) { w.Environment = []string{} },
		"operation":         func(_, w *Command, _ *NativeFixture) { w.Binding.AdmissionID = "different" },
		"profile":           func(_, w *Command, _ *NativeFixture) { w.Confinement.ProfileSHA256 = strings.Repeat("f", 64) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			a, o, w, f, probe, _, deadline := qualificationFixture(t)
			change(&o, &w, &f)
			if q, err := a.Run(context.Background(), o, w, f, deadline); q != nil || err == nil || len(probe.calls) != 0 {
				t.Fatal("malformed qualification probed", err)
			}
		})
	}
}
func TestNativeQualificationFixedClockExpiryStopsBeforeNextVector(t *testing.T) {
	a, o, w, f, probe, clock, deadline := qualificationFixture(t)
	probe.before = func(string) { clock.value = deadline }
	if q, err := a.Run(context.Background(), o, w, f, deadline); q != nil || err == nil || len(probe.calls) != 1 {
		t.Fatal("continued after expiry", err)
	}
	a, o, w, f, probe, clock, deadline = qualificationFixture(t)
	if _, err := a.Run(context.Background(), o, w, f, deadline.Add(time.Nanosecond)); err == nil || len(probe.calls) != 0 {
		t.Fatal("longer deadline accepted")
	}
}

func TestNativeQualificationDispatchCannotRepeatOrExtendAfterCopy(t *testing.T) {
	a, o, w, f, _, _, deadline := qualificationFixture(t)
	q, err := a.Run(context.Background(), o, w, f, deadline)
	if err != nil {
		t.Fatal(err)
	}
	copied := *q
	if err = q.claimExec(o, w, deadline); err != nil {
		t.Fatal(err)
	}
	var failure *processsvc.NativeFailure
	if !errors.As(copied.claimExec(o, w, deadline), &failure) || !failure.Unknown {
		t.Fatal("copy replayed held dispatch")
	}
	a, o, w, f, _, _, deadline = qualificationFixture(t)
	q, err = a.Run(context.Background(), o, w, f, deadline)
	if err != nil {
		t.Fatal(err)
	}
	if q.claimExec(o, w, deadline.Add(time.Second)) == nil {
		t.Fatal("held role extended original lease")
	}
	if !errors.As(q.claimExec(o, w, deadline), &failure) || !failure.Unknown {
		t.Fatal("refused dispatch reset")
	}
}
