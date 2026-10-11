package mutation

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func TestSupervisedResultUsesVersionSixAndPreservesUnverifiedCleanup(t *testing.T) {
	r, disk, value, id, key := terminalFixture(t, bytes.Repeat([]byte{0, 255, 'x'}, 25000), []byte("diagnostic"))
	value.Observation.Supervisor = processsvc.SupervisorExited
	value.Observation.GroupCleanup, value.Observation.DescendantCleanup = processsvc.CleanupUnverified, processsvc.CleanupUnverified
	publishTerminal(t, r, value)
	got, err := r.LoadProcessTerminal(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	sameTerminal(t, &value, got)
	if processsvc.ResultState(*got) != processsvc.Exited {
		t.Fatal("known supervisor exit promoted to confirmed cleanup")
	}
	var envelope processTerminalEnvelope
	if json.Unmarshal(disk.files[key], &envelope) != nil || envelope.Version != 6 || envelope.Record.Phase != "exited" {
		t.Fatal("new semantics used old record identity")
	}
	for _, change := range []func(*processTerminalEnvelope){
		func(e *processTerminalEnvelope) { e.Version = 5 },
		func(e *processTerminalEnvelope) { e.Record.Phase = "terminal" },
		func(e *processTerminalEnvelope) { e.Record.Observation.Supervisor = "" },
		func(e *processTerminalEnvelope) { e.Record.Observation.Supervisor = processsvc.SupervisorUnknown },
		func(e *processTerminalEnvelope) { e.Record.Observation.Supervisor = processsvc.SupervisorRunning },
	} {
		bad := envelope
		change(&bad)
		raw, err := processCanonical(bad)
		if err != nil {
			t.Fatal(err)
		}
		if value, _, err := decodeProcessTerminal(raw); value != nil || err == nil {
			t.Fatal("cross-version or incomplete supervisor result accepted")
		}
	}
}

func TestLegacyTerminalEncodingDoesNotGainSupervisorMeaning(t *testing.T) {
	value := terminalValue(nil, nil)
	raw, _, err := encodeProcessTerminal(value)
	if err != nil || bytes.Contains(raw, []byte("supervisorState")) {
		t.Fatal("old representation changed", err)
	}
	got, envelope, err := decodeProcessTerminal(raw)
	if err != nil || envelope.Version != 5 || processsvc.ResultState(*got) != processsvc.Terminal {
		t.Fatal("old complete result is not compatible", err)
	}
	envelope.Version = 6
	changed, err := processCanonical(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if value, _, err := decodeProcessTerminal(changed); err == nil || value != nil {
		t.Fatal("version bump invented supervisor proof")
	}
}
