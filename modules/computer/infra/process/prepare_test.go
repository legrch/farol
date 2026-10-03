package process

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Only value construction/digest mapping. Neither nativeBoundary.Start nor
// Qualification is invoked. No CLI, filesystem, signals or provider effects.
type qualificationDouble struct{ calls int }

func (q *qualificationDouble) Qualify(context.Context, Command) error { q.calls++; return nil }
func nativePreparerFixture(t *testing.T) (*Preparer, Command, *qualificationDouble, processsvc.Invocation) {
	t.Helper()
	p, _, c, _ := fixture(t)
	template := copyCommand(p.command)
	template.Args = nil
	template.Input = nil
	qualifier := &qualificationDouble{}
	builder, err := NewPreparer("cli", template, qualifier, c)
	if err != nil {
		t.Fatal(err)
	}
	invocation := processsvc.Invocation{RuntimeID: "cli", SessionID: "exact-session", ModelID: "selected-model", AdmissionID: "authority", Arguments: []string{"--session-id", "exact-session", "--model", "selected-model"}, Input: []byte("synthetic input")}
	return builder, template, qualifier, invocation
}
func TestInvocationProducerMapsExactSelectedCommandAndCopies(t *testing.T) {
	builder, template, q, invocation := nativePreparerFixture(t)
	template.Environment[0] = "changed"
	selected, err := builder.Prepare(context.Background(), invocation)
	if err != nil {
		t.Fatal(err)
	}
	p := selected.(*Prepared)
	if p.command.Executable != "/selected/command" || p.command.Environment[0] != "PATH=/usr/bin" || p.command.Args[1] != "exact-session" || string(p.command.Input) != "synthetic input" || p.command.Binding.ModelID != "selected-model" || p.command.Binding.AdmissionID != "authority" || q.calls != 0 || p.attempted {
		t.Fatal("construction drift/dispatch")
	}
	digest := p.Seal().Digest
	invocation.Arguments[1] = "changed"
	invocation.Input[0] = 'X'
	observed := p.Invocation()
	observed.Arguments[1] = "changed"
	observed.Input[0] = 'Y'
	observed.SessionID = "changed"
	if p.Invocation().Arguments[1] != "exact-session" || string(p.Invocation().Input) != "synthetic input" || p.Invocation().SessionID != "exact-session" || p.Seal().Digest != digest {
		t.Fatal("mutable aliases changed selected command")
	}
	copy := copyCommand(p.command)
	copy.Binding.ModelID = "changed"
	if p.command.Binding.ModelID != "selected-model" {
		t.Fatal("binding alias")
	}
}
func TestInvocationProducerDigestBindsEverySelectedField(t *testing.T) {
	builder, _, _, original := nativePreparerFixture(t)
	base, err := builder.Prepare(context.Background(), original)
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*processsvc.Invocation){func(v *processsvc.Invocation) { v.Arguments[0] = "changed" }, func(v *processsvc.Invocation) { v.Input[0] = 'X' }, func(v *processsvc.Invocation) { v.SessionID = "other-session" }, func(v *processsvc.Invocation) { v.ModelID = "other-model" }, func(v *processsvc.Invocation) { v.AdmissionID = "other-admission" }} {
		modified := original.Clone()
		change(&modified)
		next, err := builder.Prepare(context.Background(), modified)
		if err != nil || next.Seal().Digest == base.Seal().Digest {
			t.Fatal("digest did not bind selection", err)
		}
	}
}
func TestInvocationProducerRequiresTrustedTemplateAndQualification(t *testing.T) {
	builder, template, q, invocation := nativePreparerFixture(t)
	for _, change := range []func(*Command){func(c *Command) { c.Args = []string{"silently-prepend"} }, func(c *Command) { c.Input = []byte("silently-prepend") }, func(c *Command) { c.Binding = &InvocationBinding{RuntimeID: "another"} }, func(c *Command) { c.ExecutableSHA256 = "invalid" }, func(c *Command) { c.Environment = []string{"HOME=one", "HOME=two"} }} {
		bad := copyCommand(template)
		change(&bad)
		if _, err := NewPreparer("cli", bad, q, builder.clock); err == nil {
			t.Fatal("untrusted template accepted")
		}
	}
	if _, err := NewPreparer("cli", template, nil, builder.clock); err == nil {
		t.Fatal("unqualified default")
	}
	invocation.RuntimeID = "other"
	if _, err := builder.Prepare(context.Background(), invocation); err == nil {
		t.Fatal("runtime rebind")
	}
	invocation.RuntimeID = "cli"
	invocation.AdmissionID = "invalid admission"
	if _, err := builder.Prepare(context.Background(), invocation); err == nil {
		t.Fatal("invalid binding")
	}
	if q.calls != 0 {
		t.Fatal("construction qualified native effects")
	}
}
func TestInvocationProducerPreservesLegacyCommandEncoding(t *testing.T) {
	p, _, _, _ := fixture(t)
	encoded, err := json.Marshal(p.command)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), `"Binding"`) {
		t.Fatal("legacy fingerprint gained absent binding")
	}
}
