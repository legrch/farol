package claude

import (
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/task/domain"
)

func TestSelectedInvocationKeepsQueuedModelAndCopiesPrivateInput(t *testing.T) {
	config := fixtureSelection()
	d := fixtureDispatch(config)
	selected, err := NewSelection(config)
	if err != nil {
		t.Fatal(err)
	}
	config.Binding.Model = "changed-model-b"
	config.ReportedModel = "changed-model-b"
	config.Efforts[0].Argument = "low"
	inv, err := selected.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	f := &strictFixture{effort: "high"}
	if err := f.submit(inv.Arguments(), inv.Input()); err != nil || f.accepted != 1 {
		t.Fatal(err)
	}
	args := inv.Arguments()
	args[0] = "--bare"
	input := inv.Input()
	input[0] = 'X'
	if err := f.submit(inv.Arguments(), inv.Input()); err != nil {
		t.Fatal("private arrays alias", err)
	}
	facts := inv.Models()
	if facts.Requested.Alias != "chosen-alias" || facts.Resolved.Model != "fixture-model-a" || facts.Resolved.ConfigDigest != "fixture-config-a" || facts.AdmissionEvidence != "not_observed" {
		t.Fatal(facts)
	}
	stream, _ := NewStream(inv.Expected())
	if stream.Snapshot().Observed.Evidence != "" {
		t.Fatal("requested identity became observed")
	}
	stream.Feed([]byte(fixtureInit))
	observed := stream.Snapshot().Observed
	if observed.Evidence != "provider_reported" || observed.EffortEvidence != "unknown" {
		t.Fatal("provider echo became verified", observed)
	}
	changed := d
	changed.Intent.Binding.Model = "changed-model-b"
	if _, err := selected.Build(changed); !errors.Is(err, task.ErrIdentity) {
		t.Fatal("queued request re-resolved", err)
	}
}
func TestRouteSpecificEffortPreservesOmittedExplicitAndLegacy(t *testing.T) {
	for _, tc := range []struct {
		name, requested, argument string
		mapping                   []EffortMapping
		fail                      bool
	}{
		{"omitted", "", "", nil, false}, {"explicit-high", "high", "high", []EffortMapping{{"high", "high"}}, false},
		{"explicit-max", "max", "max", []EffortMapping{{"max", "max"}}, false},
		{"xhigh-unsupported", "xhigh", "", []EffortMapping{{"high", "high"}}, true},
		{"ultra-unsupported", "ultra", "", nil, true},
		{"fixture-legacy-ultra", "ultra", "max", []EffortMapping{{"ultra", "max"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			config := fixtureSelection()
			config.Binding.Effort = tc.requested
			config.Efforts = tc.mapping
			selected, err := NewSelection(config)
			if tc.fail {
				if !errors.Is(err, task.ErrUnsupported) {
					t.Fatal(err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			inv, err := selected.Build(fixtureDispatch(config))
			if err != nil {
				t.Fatal(err)
			}
			f := &strictFixture{effort: tc.argument}
			if err := f.submit(inv.Arguments(), inv.Input()); err != nil {
				t.Fatal(err)
			}
			if inv.Models().Requested.Effort != tc.requested || inv.Models().Resolved.EffortArgument != tc.argument {
				t.Fatal(inv.Models())
			}
		})
	}
}
func TestOnlyDeclaredExactSessionResumeNoActiveInputOrLatestLookup(t *testing.T) {
	config := fixtureSelection()
	d := fixtureDispatch(config)
	d.Intent.Action = task.Resume
	d.Intent.Expected = task.Reference{SessionID: fixtureSession, InvocationID: "previous-operation"}
	selected, _ := NewSelection(config)
	inv, err := selected.Build(d)
	if err != nil {
		t.Fatal(err)
	}
	f := &strictFixture{resume: true, effort: "high"}
	if err := f.submit(inv.Arguments(), inv.Input()); err != nil {
		t.Fatal(err)
	}
	if err := f.input([]byte("steer")); err == nil || f.accepted != 1 {
		t.Fatal("fixture claimed active input")
	}
	config.ExactResume = false
	unsupported, _ := NewSelection(config)
	if _, err := unsupported.Build(d); !errors.Is(err, task.ErrUnsupported) {
		t.Fatal(err)
	}
	for _, action := range []task.Action{task.Continue, task.Message, task.Cancel} {
		d.Intent.Action = action
		if _, err := selected.Build(d); !errors.Is(err, task.ErrUnsupported) {
			t.Fatal(action, err)
		}
	}
	d.Intent.Action = task.Resume
	d.Intent.Expected.SessionID = "other-session"
	if _, err := selected.Build(d); !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
}
func TestStrictFixtureRejectsUnexpectedFlagStdinAndDuplicateFlags(t *testing.T) {
	config := fixtureSelection()
	s, _ := NewSelection(config)
	inv, _ := s.Build(fixtureDispatch(config))
	for _, flag := range []string{"--bare", "--dangerously-skip-permissions", "--continue", "--append-system-prompt", "--print"} {
		f := &strictFixture{effort: "high"}
		if err := f.submit(append(inv.Arguments(), flag), inv.Input()); err == nil || f.accepted != 0 {
			t.Fatal("unexpected flag accepted", flag)
		}
	}
	f := &strictFixture{effort: "high"}
	if err := f.submit(inv.Arguments(), []byte("other prompt")); err == nil || f.accepted != 0 {
		t.Fatal("stdin ignored")
	}
	want := []string{"--print", "--output-format", "stream-json", "--verbose", "--session-id", fixtureSession, "--model", "fixture-model-a", "--permission-mode", "default", "--permission-prompts", "none", "--effort", "high"}
	if !reflect.DeepEqual(inv.Arguments(), want) {
		t.Fatal("serialized flags changed")
	}
}
