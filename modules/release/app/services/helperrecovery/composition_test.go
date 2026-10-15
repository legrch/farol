package helperrecovery

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
)

// This composes the actual native JSON decoder and existing input application
// owner with recovery policy. Tree observations and effects remain instrumented
// in runtimeFixture: no native custody, journal, lease or readiness is proved.
func TestActualInputOwnerBindsRecoveryWithoutStartingPreparedExchange(t *testing.T) {
	ctx := context.Background()
	input := recoveryWireInput(t)
	parser := inputapp.New(inputnative.JSONDecoder{})
	request, err := parser.Parse(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	runtime := newRuntime(t, request, "prepared", "st--")
	s, err := Bind(ctx, input, parser, runtime)
	if err != nil {
		t.Fatal(err)
	}
	input[0] = 'X'
	bound, err := s.Request(ctx)
	if err != nil || !reflect.DeepEqual(bound, request) || bound.Predecessor != nil || bound.LeaseIdentity != nil {
		t.Fatal("actual recovery request was not independently bound", bound, err)
	}
	if err = s.Inspect(ctx); err != nil {
		t.Fatal(err)
	}
	for _, call := range runtime.trace {
		if isEffect(call) || call == "fence" {
			t.Fatal("actual-input inspection dispatched", runtime.trace)
		}
	}
	runtime.trace = nil
	phase, err := s.Reconcile(ctx)
	if err != nil || phase != "cancelled" || !reflect.DeepEqual(runtime.trace, traceCases[0].trace) {
		t.Fatal("pre-exchange recovery did not cancel preparation", phase, err, runtime.trace)
	}
	if !runtime.entries[port.App].meta.Present || runtime.entries[port.App].build != request.Source ||
		!runtime.entries[port.Staged].meta.Present || runtime.entries[port.Staged].build != request.Target ||
		runtime.entries[port.Previous].meta.Present || runtime.entries[port.Failed].meta.Present {
		t.Fatal("prepared recovery moved application entries")
	}
}

func TestActualInputRefusalCannotReachRecoveryRuntime(t *testing.T) {
	valid := string(recoveryWireInput(t))
	for _, tc := range []struct{ name, input, code string }{
		{"duplicate key", strings.Replace(valid, `"action":"recover"`, `"action":"recover","action":"apply"`, 1), "input"},
		{"unknown field", strings.Replace(valid, `"action":"recover"`, `"action":"recover","other":true`, 1), "input"},
		{"crossed drain", strings.Replace(valid, `"acceptedSource":"`+strings.Repeat("c", 64)+`"`, `"acceptedSource":"`+strings.Repeat("0", 64)+`"`, 1), "acceptance"},
		{"malformed JSON", valid + `{}`, "input"},
		{"missing operation", strings.Replace(valid, `"operationId":"`+strings.Repeat("a", 32)+`"`, `"operationId":null`, 1), "input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.input == valid {
				t.Fatal("invalid fixture did not change input")
			}
			runtime := newRuntime(t, requestFixture(), "prepared", "st--")
			s, err := Bind(context.Background(), []byte(tc.input), inputapp.New(inputnative.JSONDecoder{}), runtime)
			requireFailure(t, err, tc.code, "refused", false, false)
			if s != nil || len(runtime.trace) != 0 {
				t.Fatal("refused native input reached recovery runtime")
			}
		})
	}
}

func recoveryWireInput(t *testing.T) []byte {
	t.Helper()
	r := requestFixture()
	build := func(b port.HelperBuild) map[string]any {
		return map[string]any{"digest": b.Digest, "version": b.Version, "buildId": b.BuildID}
	}
	input, err := json.Marshal(map[string]any{
		"schema": r.Schema, "action": r.Action, "home": r.Home, "operationId": r.OperationID,
		"source": build(r.Source), "target": build(r.Target),
		"drain": map[string]any{"status": r.Drain.Status, "acceptedSource": r.Drain.AcceptedSource, "acceptedTarget": r.Drain.AcceptedTarget},
		"pid":   r.PID, "processStart": r.ProcessStart, "waitSeconds": r.WaitSeconds, "relaunch": r.Relaunch,
		"installLocation": *r.InstallLocation,
	})
	if err != nil {
		t.Fatal(err)
	}
	return input
}
