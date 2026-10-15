package currentsource

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/currentsource"
)

type decoderFunc func([]byte) (port.TaskCurrentSettingsFacts, error)

func (f decoderFunc) Decode(b []byte) (port.TaskCurrentSettingsFacts, error) { return f(b) }

type modelFunc func(context.Context, []byte) (port.TaskSourceModelResolution, error)

func (f modelFunc) ResolveTaskSourceModel(c context.Context, b []byte) (port.TaskSourceModelResolution, error) {
	return f(c, b)
}
func sentinelService(d decoderFunc) *app.Service {
	return app.New(d, modelFunc(func(context.Context, []byte) (port.TaskSourceModelResolution, error) {
		panic("sentinel must not resolve policy")
	}))
}
func checkFailure(t *testing.T, out *Response, err error, code string) {
	t.Helper()
	f, ok := err.(*Failure)
	if out != nil || !ok || f.Code != code {
		t.Fatalf("response=%+v error=%v want=%s", out, err, code)
	}
}

func TestBoundaryErrorsAndAbsentShape(t *testing.T) {
	ctx := context.Background()
	req := Request{Settings: []byte(`{"status":"settings-invalid"}`), NowMillis: 1}
	d := decoderFunc(func(b []byte) (port.TaskCurrentSettingsFacts, error) {
		b[0] = '!'
		return port.TaskCurrentSettingsFacts{Status: "settings-invalid"}, nil
	})
	c := New(sentinelService(d))
	out, err := c.Resolve(ctx, req)
	if err != nil || out == nil || out.Status != app.Absent || out.Source != nil || out.Read != nil {
		t.Fatalf("%+v %v", out, err)
	}
	if req.Settings[0] != '{' {
		t.Fatal("contract retained caller bytes")
	}
	b, _ := json.Marshal(out)
	if string(b) != `{"status":"absent"}` {
		t.Fatalf("absent shape %s", b)
	}
	var nilContract *Contract
	out, err = nilContract.Resolve(ctx, req)
	checkFailure(t, out, err, app.Unavailable)
	out, err = New(nil).Resolve(ctx, req)
	checkFailure(t, out, err, app.Unavailable)
	out, err = c.Resolve(nil, req)
	checkFailure(t, out, err, app.Unavailable)
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	out, err = c.Resolve(canceled, req)
	checkFailure(t, out, err, app.Unavailable)
	out, err = c.Resolve(ctx, Request{Settings: []byte(strings.Repeat(" ", app.MaxSnapshotBytes+1))})
	checkFailure(t, out, err, app.Invalid)
	out, err = c.Resolve(ctx, Request{Settings: req.Settings, NowMillis: 9007199254740992})
	checkFailure(t, out, err, app.Invalid)
	broken := New(sentinelService(decoderFunc(func([]byte) (port.TaskCurrentSettingsFacts, error) {
		return port.TaskCurrentSettingsFacts{}, errors.New("invalid")
	})))
	out, err = broken.Resolve(ctx, req)
	checkFailure(t, out, err, app.Invalid)
}

func TestExplicitMapperCopiesEveryFieldAndOptionalPointers(t *testing.T) {
	effort := "high"
	in := &app.CodexSource{
		ProjectID: "project", WorkspaceID: "workspace", Project: app.Root{Path: "/project", Device: "1", Inode: "2", GitCommonDirectory: "/git"}, Writer: app.Root{Path: "/writer", Device: "3", Inode: "4", GitCommonDirectory: "/git-writer"},
		ModelAlias: "alias", Model: "model", Effort: &effort, ConfigDigest: "config", ExecutablePath: "/exe", ExecutableSHA256: "exe-sha", Protocol: "protocol", BaseSchemaSHA256: "base", HandoffSchemaSHA256: "handoff",
		Followup:   &app.Followup{Kind: "kind", Protocol: "follow-protocol", BaseSchemaSHA256: "follow-base", SchemaSHA256: "follow-sha"},
		SocketPath: "/socket", ExpectedCodexHome: "/home", Sandbox: "sandbox", ApprovalPolicy: "approval", GrantedAt: "granted", ExpiresAt: "expires", HostGeneration: "1", ComputerGeneration: "2", GrantHostGeneration: "3", GrantComputerGeneration: "4", VerifiedWorkspaceID: "verified", VerifiedComputerGeneration: "5", Access: "access", ProjectBoundCreateStatus: true,
	}
	out := mapSource(in)
	want, _ := json.Marshal(in)
	got, _ := json.Marshal(out)
	if string(want) != string(got) {
		t.Fatalf("mapper omitted/changed fields\n%s\n%s", want, got)
	}
	effort = "changed"
	in.Project.Path = "/changed"
	in.Followup.SchemaSHA256 = "changed"
	got, _ = json.Marshal(out)
	if string(got) != string(want) {
		t.Fatal("mutable mapper alias")
	}
	in.Effort = nil
	in.Followup = nil
	out = mapSource(in)
	got, _ = json.Marshal(out)
	if strings.Contains(string(got), `"effort"`) || strings.Contains(string(got), `"followup"`) {
		t.Fatal("invented optional fields")
	}
}
