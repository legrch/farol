package helperinput

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

type decoder struct {
	request port.HelperRequest
	err     error
	calls   int
	after   func()
}

func (d *decoder) Decode([]byte) (port.HelperRequest, error) {
	d.calls++
	if d.after != nil {
		d.after()
	}
	return d.request, d.err
}

func valid() port.HelperRequest {
	return port.HelperRequest{
		Schema: "farol.installed-update/1", Action: "apply", Home: "/Users/fixture",
		OperationID: strings.Repeat("a", 32),
		Source:      port.HelperBuild{Digest: strings.Repeat("1", 64), Version: "0.2.4", BuildID: strings.Repeat("2", 64)},
		Target:      port.HelperBuild{Digest: strings.Repeat("3", 64), Version: "0.2.5", BuildID: strings.Repeat("4", 64)},
		Drain:       port.HelperDrain{Status: "reconciled", AcceptedSource: strings.Repeat("2", 64), AcceptedTarget: strings.Repeat("4", 64)},
		PID:         42, ProcessStart: "Mon Oct 12 12:00:00 2026", WaitSeconds: 30, Relaunch: true,
	}
}

func closed() port.HelperRequest {
	r := valid()
	loc := "shared"
	r.InstallLocation = &loc
	r.Predecessor = &port.HelperPredecessor{
		Kind: "confirmed_closed", StartedAt: "2026-10-12T12:00:00Z", LastQuitSHA256: strings.Repeat("b", 64),
		StateIdentity: port.HelperIdentity{Device: "0", Inode: "123"},
	}
	r.LeaseIdentity = &port.HelperIdentity{Device: "1", Inode: "456"}
	return r
}

func checkCode(t *testing.T, err error, want string) {
	t.Helper()
	if want == "" {
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != want || err.Error() != want {
		t.Fatalf("error = %v, want Failure %s", err, want)
	}
}

func TestSemanticPolicy(t *testing.T) {
	cases := []struct {
		name string
		edit func(*port.HelperRequest)
		code string
	}{
		{"live apply", func(*port.HelperRequest) {}, ""},
		{"live recover", func(r *port.HelperRequest) { r.Action = "recover" }, ""},
		{"live rollback", func(r *port.HelperRequest) { r.Action = "rollback" }, ""},
		{"legacy location", func(r *port.HelperRequest) { s := "legacy"; r.InstallLocation = &s }, ""},
		{"location invalid", func(r *port.HelperRequest) { s := "other"; r.InstallLocation = &s }, "input"},
		{"schema", func(r *port.HelperRequest) { r.Schema += "/2" }, "input"},
		{"action", func(r *port.HelperRequest) { r.Action = "launch" }, "input"},
		{"operation uppercase", func(r *port.HelperRequest) { r.OperationID = strings.Repeat("A", 32) }, "input"},
		{"operation short", func(r *port.HelperRequest) { r.OperationID = "a" }, "input"},
		{"source digest", func(r *port.HelperRequest) { r.Source.Digest = strings.Repeat("g", 64) }, "input"},
		{"target buildID", func(r *port.HelperRequest) { r.Target.BuildID = strings.Repeat("A", 64) }, "input"},
		{"empty version", func(r *port.HelperRequest) { r.Source.Version = "" }, "input"},
		{"scalar version boundary", func(r *port.HelperRequest) { r.Target.Version = strings.Repeat("😀", 128) }, ""},
		{"scalar version over", func(r *port.HelperRequest) { r.Target.Version = strings.Repeat("😀", 129) }, "input"},
		{"invalid UTF8 version", func(r *port.HelperRequest) { r.Target.Version = string([]byte{0xff}) }, "input"},
		{"equal builds", func(r *port.HelperRequest) { r.Target = r.Source; r.Drain.AcceptedTarget = r.Source.BuildID }, "acceptance"},
		{"same digest distinct full build", func(r *port.HelperRequest) { r.Target.Digest = r.Source.Digest }, ""},
		{"same ID distinct version", func(r *port.HelperRequest) {
			r.Target = r.Source
			r.Target.Version += "x"
			r.Drain.AcceptedTarget = r.Source.BuildID
		}, ""},
		{"drain status", func(r *port.HelperRequest) { r.Drain.Status = "pending" }, "acceptance"},
		{"drain source", func(r *port.HelperRequest) { r.Drain.AcceptedSource = r.Target.BuildID }, "acceptance"},
		{"drain target", func(r *port.HelperRequest) { r.Drain.AcceptedTarget = r.Source.BuildID }, "acceptance"},
		{"PID minimum", func(r *port.HelperRequest) { r.PID = 2 }, ""},
		{"PID maximum", func(r *port.HelperRequest) { r.PID = 2147483647 }, ""},
		{"PID low", func(r *port.HelperRequest) { r.PID = 1 }, "input"},
		{"PID negative", func(r *port.HelperRequest) { r.PID = -2 }, "input"},
		{"PID upper hardening", func(r *port.HelperRequest) { r.PID = 2147483648 }, "input"},
		{"start empty", func(r *port.HelperRequest) { r.ProcessStart = "" }, "input"},
		{"start scalar bound", func(r *port.HelperRequest) { r.ProcessStart = strings.Repeat("😀", 128) }, ""},
		{"start scalar over", func(r *port.HelperRequest) { r.ProcessStart = strings.Repeat("😀", 129) }, "input"},
		{"start whitespace existing policy", func(r *port.HelperRequest) { r.ProcessStart = " " }, ""},
		{"wait minimum", func(r *port.HelperRequest) { r.WaitSeconds = 1 }, ""},
		{"wait maximum", func(r *port.HelperRequest) { r.WaitSeconds = 120 }, ""},
		{"wait low", func(r *port.HelperRequest) { r.WaitSeconds = 0 }, "input"},
		{"wait negative", func(r *port.HelperRequest) { r.WaitSeconds = -1 }, "input"},
		{"wait high", func(r *port.HelperRequest) { r.WaitSeconds = 121 }, "input"},
		{"home root", func(r *port.HelperRequest) { r.Home = "/" }, "input"},
		{"home empty", func(r *port.HelperRequest) { r.Home = "" }, "input"},
		{"home relative", func(r *port.HelperRequest) { r.Home = "Users/fixture" }, "input"},
		{"home repeated slash", func(r *port.HelperRequest) { r.Home = "/Users//fixture" }, "input"},
		{"home trailing slash", func(r *port.HelperRequest) { r.Home += "/" }, "input"},
		{"home dot", func(r *port.HelperRequest) { r.Home = "/Users/./fixture" }, "input"},
		{"home dotdot", func(r *port.HelperRequest) { r.Home = "/Users/../fixture" }, "input"},
		{"home NUL", func(r *port.HelperRequest) { r.Home += "\x00" }, "input"},
		{"home invalid UTF8", func(r *port.HelperRequest) { r.Home += string([]byte{0xff}) }, "input"},
		{"home byte boundary", func(r *port.HelperRequest) { r.Home = "/" + strings.Repeat("é", 127) + "a" }, ""},
		{"home byte over", func(r *port.HelperRequest) { r.Home = "/" + strings.Repeat("é", 128) }, "input"},
		{"lease without proof", func(r *port.HelperRequest) { r.LeaseIdentity = &port.HelperIdentity{Device: "1", Inode: "2"} }, "input"},
		{"acceptance before PID and home", func(r *port.HelperRequest) { r.PID = 0; r.Home = "/"; r.Drain.Status = "no" }, "acceptance"},
		{"build before acceptance", func(r *port.HelperRequest) { r.Source.Version = ""; r.Drain.Status = "no" }, "input"},
		{"location before acceptance", func(r *port.HelperRequest) { s := "bad"; r.InstallLocation = &s; r.Drain.Status = "no" }, "input"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := valid()
			tc.edit(&r)
			d := &decoder{request: r}
			got, err := New(d).Parse(context.Background(), []byte("trusted decoder fixture"))
			checkCode(t, err, tc.code)
			if tc.code != "" && got != (port.HelperRequest{}) {
				t.Fatal("refusal exposed partial input")
			}
		})
	}
}

func TestClosedPredecessor(t *testing.T) {
	cases := []struct {
		name string
		edit func(*port.HelperRequest)
		code string
	}{
		{"closed apply", func(*port.HelperRequest) {}, ""},
		{"closed rollback", func(r *port.HelperRequest) { r.Action = "rollback"; r.Relaunch = false }, ""},
		{"closed recover", func(r *port.HelperRequest) { r.Action = "recover" }, "input"},
		{"rollback relaunch", func(r *port.HelperRequest) { r.Action = "rollback" }, "input"},
		{"missing lease", func(r *port.HelperRequest) { r.LeaseIdentity = nil }, "input"},
		{"kind", func(r *port.HelperRequest) { r.Predecessor.Kind = "closed" }, "input"},
		{"started empty", func(r *port.HelperRequest) { r.Predecessor.StartedAt = "" }, "input"},
		{"started scalar boundary", func(r *port.HelperRequest) { r.Predecessor.StartedAt = strings.Repeat("😀", 64) }, ""},
		{"started over", func(r *port.HelperRequest) { r.Predecessor.StartedAt = strings.Repeat("😀", 65) }, "input"},
		{"timestamp custody deferred", func(r *port.HelperRequest) { r.Predecessor.StartedAt = "not a timestamp" }, ""},
		{"hash uppercase", func(r *port.HelperRequest) { r.Predecessor.LastQuitSHA256 = strings.Repeat("A", 64) }, "input"},
		{"inode zero", func(r *port.HelperRequest) { r.Predecessor.StateIdentity.Inode = "0" }, ""},
		{"inode maximum", func(r *port.HelperRequest) { r.LeaseIdentity.Inode = strings.Repeat("9", 30) }, ""},
		{"inode too long", func(r *port.HelperRequest) { r.LeaseIdentity.Inode = strings.Repeat("9", 31) }, "input"},
		{"inode empty", func(r *port.HelperRequest) { r.Predecessor.StateIdentity.Inode = "" }, "input"},
		{"inode leading zero", func(r *port.HelperRequest) { r.Predecessor.StateIdentity.Inode = "01" }, "input"},
		{"device negative", func(r *port.HelperRequest) { r.LeaseIdentity.Device = "-1" }, "input"},
		{"device nondecimal", func(r *port.HelperRequest) { r.Predecessor.StateIdentity.Device = "１" }, "input"},
		{"proof before acceptance", func(r *port.HelperRequest) { r.Predecessor.Kind = "bad"; r.Drain.Status = "no" }, "input"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := closed()
			tc.edit(&r)
			_, err := New(&decoder{request: r}).Parse(context.Background(), []byte("fixture"))
			checkCode(t, err, tc.code)
		})
	}
}

func TestDependenciesBoundsAndCancellation(t *testing.T) {
	d := &decoder{request: valid()}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := New(d).Parse(ctx, []byte("fixture"))
	checkCode(t, err, "canceled")
	for _, raw := range [][]byte{nil, {}, make([]byte, 8193)} {
		_, err = New(d).Parse(context.Background(), raw)
		checkCode(t, err, "input")
	}
	if d.calls != 0 {
		t.Fatal("decoder called after pre-decode refusal")
	}
	for _, raw := range [][]byte{{'x'}, make([]byte, 8192)} {
		_, err = New(d).Parse(context.Background(), raw)
		checkCode(t, err, "")
	}
	for _, s := range []*Service{nil, New(nil)} {
		_, err = s.Parse(context.Background(), []byte("fixture"))
		checkCode(t, err, "unavailable")
	}
	_, err = New(d).Parse(nil, []byte("fixture"))
	checkCode(t, err, "unavailable")
	ctx, cancel = context.WithCancel(context.Background())
	d.after = cancel
	_, err = New(d).Parse(ctx, []byte("fixture"))
	checkCode(t, err, "canceled")
	ctx, cancel = context.WithCancel(context.Background())
	d.after = cancel
	d.err = errors.New("private input /Users/secret")
	_, err = New(d).Parse(ctx, []byte("fixture"))
	checkCode(t, err, "canceled")
	d.after = nil
	_, err = New(d).Parse(context.Background(), []byte("fixture"))
	checkCode(t, err, "input")
}

func TestResultsOwnOptionalValues(t *testing.T) {
	d := &decoder{request: closed()}
	s := New(d)
	a, err := s.Parse(context.Background(), []byte("fixture"))
	checkCode(t, err, "")
	b, err := s.Parse(context.Background(), []byte("fixture"))
	checkCode(t, err, "")
	*a.InstallLocation = "legacy"
	a.Predecessor.Kind = "changed"
	a.Predecessor.StateIdentity.Inode = "900"
	a.LeaseIdentity.Inode = "901"
	if *b.InstallLocation != "shared" || b.Predecessor.Kind != "confirmed_closed" || b.Predecessor.StateIdentity.Inode != "123" || b.LeaseIdentity.Inode != "456" {
		t.Fatal("independent result aliases another result")
	}
	if *d.request.InstallLocation != "shared" || d.request.Predecessor.Kind != "confirmed_closed" || d.request.Predecessor.StateIdentity.Inode != "123" || d.request.LeaseIdentity.Inode != "456" {
		t.Fatal("result aliases trusted decoder DTO")
	}
	d.request.Predecessor.LastQuitSHA256 = "changed"
	if b.Predecessor.LastQuitSHA256 != strings.Repeat("b", 64) {
		t.Fatal("decoder mutation changed prior result")
	}
}
