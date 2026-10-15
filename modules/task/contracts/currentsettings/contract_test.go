package currentsettings_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/currentsettings"
	"github.com/legrch/farol/modules/task/app/services/modelpolicy"
	contract "github.com/legrch/farol/modules/task/contracts/currentsettings"
	native "github.com/legrch/farol/modules/task/infra/currentsettings"
	policy "github.com/legrch/farol/modules/task/infra/modelpolicy"
)

type decoder struct {
	calls int
	seen  []string
	hook  func()
	err   error
}

func (d *decoder) Decode(raw []byte) (port.TaskCurrentSettingsFacts, error) {
	d.calls++
	d.seen = append(d.seen, string(raw))
	if d.hook != nil {
		d.hook()
	}
	if len(raw) > 0 {
		raw[0] = 'x'
	}
	return port.TaskCurrentSettingsFacts{Status: "settings-invalid"}, d.err
}

type identityPolicy struct{ service *modelpolicy.Service }

func (p identityPolicy) IdentifyTaskPolicy(raw []byte) (port.TaskSettingsPolicyIdentity, error) {
	identity := p.service.Identity(raw)
	switch identity.Status {
	case modelpolicy.Ready:
		return port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyValid, SHA256: identity.ConfigSHA256}, nil
	case modelpolicy.ConfigMissing:
		return port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyMissing}, nil
	case modelpolicy.ConfigInvalid:
		return port.TaskSettingsPolicyIdentity{Kind: port.TaskSettingsPolicyInvalid}, nil
	default:
		return port.TaskSettingsPolicyIdentity{}, errors.New("unavailable")
	}
}
func model() port.TaskSettingsPolicyIdentityResolver {
	return identityPolicy{modelpolicy.New(policy.JSONDecoder{}, policy.SHA256Digester{}, []string{"codex"})}
}
func failure(t *testing.T, c *contract.Contract, ctx context.Context, in contract.Request, code string) {
	t.Helper()
	out, err := c.Compare(ctx, in)
	f, ok := err.(*contract.Failure)
	if out != nil || !ok || f.Code != code || err.Error() != code {
		t.Fatalf("out=%+v err=%v, want %s", out, err, code)
	}
}
func TestContractCopyAndIndependentResponses(t *testing.T) {
	before, candidate := []byte("before"), []byte("candidate")
	d := &decoder{}
	c := contract.New(app.New(d, model()))
	out, err := c.Compare(context.Background(), contract.Request{Before: before, Candidate: candidate})
	if err != nil || out == nil || out.Changed || d.calls != 2 || string(before) != "before" || string(candidate) != "candidate" {
		t.Fatalf("%+v %v", out, err)
	}
	out.Changed = true
	out, err = c.Compare(context.Background(), contract.Request{Before: before, Candidate: candidate})
	if err != nil || out.Changed {
		t.Fatal("retained response state")
	}
	// Copy both fields before invoking any application port. This synchronous
	// hook changes the original candidate after request capture.
	candidate = []byte(`{"status":"settings-invalid"}`)
	d.calls = 0
	d.seen = nil
	d.hook = func() { candidate[0] = 'x' }
	out, err = c.Compare(context.Background(), contract.Request{Before: []byte("before"), Candidate: candidate})
	if err != nil || out.Changed || len(d.seen) != 2 || d.seen[1] != `{"status":"settings-invalid"}` {
		t.Fatal("request alias escaped")
	}
}
func TestContractRefusesWithoutResponse(t *testing.T) {
	in := contract.Request{Before: []byte(`{"status":"settings-invalid"}`), Candidate: []byte(`{"status":"settings-invalid"}`)}
	c := contract.New(app.New(native.JSONDecoder{}, model()))
	failure(t, nil, context.Background(), in, app.Unavailable)
	failure(t, contract.New(nil), context.Background(), in, app.Unavailable)
	failure(t, c, nil, in, app.Unavailable)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	failure(t, c, ctx, in, app.Unavailable)
	for _, raw := range [][]byte{nil, []byte(`null`), []byte(`{"status":"settings-invalid","extra":true}`), []byte(strings.Repeat(" ", app.MaxSnapshotBytes+1))} {
		failure(t, c, context.Background(), contract.Request{Before: raw, Candidate: in.Candidate}, app.Invalid)
		failure(t, c, context.Background(), contract.Request{Before: in.Before, Candidate: raw}, app.Invalid)
	}
	ctx, cancel = context.WithCancel(context.Background())
	d := &decoder{hook: cancel}
	failure(t, contract.New(app.New(d, model())), ctx, in, app.Unavailable)
	if d.calls != 1 {
		t.Fatal("continued after cancellation")
	}
	d = &decoder{err: errors.New("private settings path")}
	failure(t, contract.New(app.New(d, model())), context.Background(), in, app.Invalid)
}
