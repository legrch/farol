package mutation

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// All result/codec evidence uses values and memory only, never native witnesses.
func terminalValue(stdout, stderr []byte) processsvc.TerminalResult {
	_, _, scope, intent := processFixture()
	code := 7
	return processsvc.TerminalResult{Scope: scope, Intent: intent, Observation: processsvc.Observation{
		Handle: "handle", Root: processsvc.RootExited, Waited: true, ExitCode: &code,
		GroupCleanup: processsvc.CleanupConfirmed, DescendantCleanup: processsvc.CleanupConfirmed, OutputDrained: true,
		Stdout: stdout, Stderr: stderr, StdoutNext: uint64(len(stdout)), StderrNext: uint64(len(stderr)),
		StdoutBytes: uint64(len(stdout)), StderrBytes: uint64(len(stderr)),
	}}
}
func terminalInvalidChanges() map[string]func(*processsvc.TerminalResult) {
	return map[string]func(*processsvc.TerminalResult){
		"running":             func(v *processsvc.TerminalResult) { v.Observation.Root = processsvc.RootRunning },
		"root-unknown":        func(v *processsvc.TerminalResult) { v.Observation.Root = "unknown" },
		"not-waited":          func(v *processsvc.TerminalResult) { v.Observation.Waited = false },
		"missing-exit":        func(v *processsvc.TerminalResult) { v.Observation.ExitCode = nil },
		"negative-exit":       func(v *processsvc.TerminalResult) { *v.Observation.ExitCode = -1 },
		"large-exit":          func(v *processsvc.TerminalResult) { *v.Observation.ExitCode = 256 },
		"exit-and-signal":     func(v *processsvc.TerminalResult) { v.Observation.ExitSignal = 9 },
		"negative-signal":     func(v *processsvc.TerminalResult) { v.Observation.ExitCode = nil; v.Observation.ExitSignal = -1 },
		"large-signal":        func(v *processsvc.TerminalResult) { v.Observation.ExitCode = nil; v.Observation.ExitSignal = 129 },
		"group-pending":       func(v *processsvc.TerminalResult) { v.Observation.GroupCleanup = processsvc.CleanupPending },
		"descendants-unknown": func(v *processsvc.TerminalResult) { v.Observation.DescendantCleanup = processsvc.CleanupUnverified },
		"undrained":           func(v *processsvc.TerminalResult) { v.Observation.OutputDrained = false },
		"empty-handle":        func(v *processsvc.TerminalResult) { v.Observation.Handle = "" },
		"invalid-handle":      func(v *processsvc.TerminalResult) { v.Observation.Handle = "handle/other" },
		"long-handle":         func(v *processsvc.TerminalResult) { v.Observation.Handle = strings.Repeat("h", 161) },
		"stdout-offset":       func(v *processsvc.TerminalResult) { v.Observation.StdoutOffset = 1 },
		"stderr-offset":       func(v *processsvc.TerminalResult) { v.Observation.StderrOffset = 1 },
		"stdout-next":         func(v *processsvc.TerminalResult) { v.Observation.StdoutNext++ },
		"stderr-next":         func(v *processsvc.TerminalResult) { v.Observation.StderrNext++ },
		"stdout-bytes":        func(v *processsvc.TerminalResult) { v.Observation.StdoutBytes++ },
		"stderr-bytes":        func(v *processsvc.TerminalResult) { v.Observation.StderrBytes++ },
		"overflow":            func(v *processsvc.TerminalResult) { v.Observation.StdoutBytes = ^uint64(0) },
		"window-only":         func(v *processsvc.TerminalResult) { v.Observation.Stdout = v.Observation.Stdout[:1] },
		"combined-oversize": func(v *processsvc.TerminalResult) {
			v.Observation.Stdout = make([]byte, processsvc.MaximumOutput)
			v.Observation.StdoutBytes, v.Observation.StdoutNext = processsvc.MaximumOutput, processsvc.MaximumOutput
		},
		"bad-scope":        func(v *processsvc.TerminalResult) { v.Scope.Host.LaunchDigest = "bad" },
		"scope-owner":      func(v *processsvc.TerminalResult) { v.Scope.OwnerID = "other" },
		"scope-host":       func(v *processsvc.TerminalResult) { v.Scope.Host.ConnectorGeneration = 0 },
		"scope-call":       func(v *processsvc.TerminalResult) { v.Scope.CallID = strings.Repeat("c", 121) },
		"scope-runtime":    func(v *processsvc.TerminalResult) { v.Scope.Host.RuntimeID = strings.Repeat("r", 121) },
		"intent-operation": func(v *processsvc.TerminalResult) { v.Intent.OperationID = "" },
		"intent-session":   func(v *processsvc.TerminalResult) { v.Intent.Binding.SessionID = strings.Repeat("s", 121) },
		"intent-seal":      func(v *processsvc.TerminalResult) { v.Intent.Seal.Digest = "bad" },
		"intent-workspace": func(v *processsvc.TerminalResult) { v.Intent.Seal.WorkspaceID = "" },
		"intent-root":      func(v *processsvc.TerminalResult) { v.Intent.Seal.Root = "/" },
		"intent-cwd":       func(v *processsvc.TerminalResult) { v.Intent.Seal.Cwd = "/other" },
		"intent-path":      func(v *processsvc.TerminalResult) { v.Intent.Seal.Cwd += "/.." },
		"intent-control":   func(v *processsvc.TerminalResult) { v.Intent.Seal.Cwd += "/\n" },
		"intent-device":    func(v *processsvc.TerminalResult) { v.Intent.Seal.RootIdentity.Device = "01" },
		"intent-inode":     func(v *processsvc.TerminalResult) { v.Intent.Seal.RootIdentity.Inode = "-1" },
		"intent-deadline":  func(v *processsvc.TerminalResult) { v.Intent.Deadline = time.Time{} },
	}
}
func TestProcessTerminalValueValidationAndClone(t *testing.T) {
	v := terminalValue([]byte{0, 255, 128}, []byte("err"))
	if !processsvc.ValidTerminalResult(v) {
		t.Fatal("valid value refused")
	}
	copy := v.Clone()
	copy.Observation.Stdout[0], copy.Observation.Stderr[0], *copy.Observation.ExitCode = 1, 1, 2
	if v.Observation.Stdout[0] != 0 || v.Observation.Stderr[0] != 'e' || *v.Observation.ExitCode != 7 {
		t.Fatal("clone aliases mutable fields")
	}
	v.Observation.ExitCode, v.Observation.ExitSignal = nil, 9
	if !processsvc.ValidTerminalResult(v) || v.Clone().Observation.ExitCode != nil {
		t.Fatal("signal result refused")
	}
	for name, change := range terminalInvalidChanges() {
		t.Run(name, func(t *testing.T) {
			bad := terminalValue([]byte("out"), []byte("err"))
			change(&bad)
			if processsvc.ValidTerminalResult(bad) {
				t.Fatal("invalid terminal value accepted")
			}
			_, _, err := encodeProcessTerminal(bad)
			code(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
		})
	}
}
func TestProcessTerminalCodecCanonicalBoundsAndNamespaces(t *testing.T) {
	v := terminalValue(bytes.Repeat([]byte{0, 255, 128}, 24000), []byte("error"))
	v.Scope.Generation, v.Scope.ComputerGeneration, v.Scope.Host.ConnectorGeneration, v.Intent.Binding.TaskEpoch = ^uint64(0), ^uint64(0), ^uint64(0), ^uint64(0)
	v.Observation.OutputLimitReached, v.Observation.CancelRequested, v.Observation.TimedOut, v.Observation.AuthorityLost = true, true, true, true
	raw, chunks, err := encodeProcessTerminal(v)
	if err != nil {
		t.Fatal(err)
	}
	raw2, chunks2, err := encodeProcessTerminal(v.Clone())
	if err != nil || !bytes.Equal(raw, raw2) || len(chunks) != len(chunks2) {
		t.Fatal("nondeterministic encoding")
	}
	got, e, err := decodeProcessTerminal(raw)
	if err != nil || got.Scope != v.Scope || got.Intent.Binding != v.Intent.Binding || got.Intent.Seal != v.Intent.Seal || !got.Intent.Deadline.Equal(v.Intent.Deadline) {
		t.Fatal("lost original binding", err)
	}
	parent, _ := recordKey(processIdentity(v.Scope, v.Intent.OperationID))
	seen := map[string]bool{parent: true}
	index := 0
	for _, stream := range []struct {
		name string
		data []byte
		list []processOutputDigest
	}{{"stdout", v.Observation.Stdout, e.Record.Stdout}, {"stderr", v.Observation.Stderr, e.Record.Stderr}} {
		for _, d := range stream.list {
			c := chunks[index]
			if seen[c.key] || len(c.raw) > maxRecordBytes || c.key != processOutputKey(parent, stream.name, d) || !bytes.Equal(c.raw, chunks2[index].raw) {
				t.Fatal("namespace, bound or determinism failure")
			}
			seen[c.key] = true
			data, err := decodeProcessOutput(c.raw, parent, stream.name, d)
			if err != nil || !bytes.Equal(data, stream.data[d.Offset:d.Offset+uint64(d.Bytes)]) {
				t.Fatal("chunk decode", err)
			}
			data[0] ^= 1
			if bytes.Equal(data, stream.data[d.Offset:d.Offset+uint64(d.Bytes)]) {
				t.Fatal("returned data alias")
			}
			index++
		}
	}
	_, _, err = decodeProcess(raw)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	_, err = decode(raw)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
}
func TestProcessTerminalManifestStrictCorruption(t *testing.T) {
	v := terminalValue(bytes.Repeat([]byte("a"), 70000), []byte("err"))
	raw, chunks, _ := encodeProcessTerminal(v)
	_, base, _ := decodeProcessTerminal(raw)
	changes := map[string]func(*processTerminalEnvelope){
		"version":      func(e *processTerminalEnvelope) { e.Version = 4 },
		"kind":         func(e *processTerminalEnvelope) { e.Kind = "workspace_connector_mutation" },
		"reserved":     func(e *processTerminalEnvelope) { e.Record.Phase = "reserved" },
		"missing-list": func(e *processTerminalEnvelope) { e.Record.Stdout = nil },
		"gap":          func(e *processTerminalEnvelope) { e.Record.Stdout[1].Offset++ },
		"order": func(e *processTerminalEnvelope) {
			e.Record.Stdout[0], e.Record.Stdout[1] = e.Record.Stdout[1], e.Record.Stdout[0]
		},
		"duplicate":        func(e *processTerminalEnvelope) { e.Record.Stdout[1] = e.Record.Stdout[0] },
		"missing-chunk":    func(e *processTerminalEnvelope) { e.Record.Stdout = e.Record.Stdout[:2] },
		"extra-chunk":      func(e *processTerminalEnvelope) { e.Record.Stdout = append(e.Record.Stdout, e.Record.Stdout[0]) },
		"short-interior":   func(e *processTerminalEnvelope) { e.Record.Stdout[0].Bytes-- },
		"large-chunk":      func(e *processTerminalEnvelope) { e.Record.Stdout[0].Bytes++ },
		"zero-chunk":       func(e *processTerminalEnvelope) { e.Record.Stdout[0].Bytes = 0 },
		"invalid-hash":     func(e *processTerminalEnvelope) { e.Record.Stdout[0].SHA256 = strings.Repeat("A", 64) },
		"oversize":         func(e *processTerminalEnvelope) { e.Record.Observation.StdoutBytes = processsvc.MaximumOutput + 1 },
		"overflow":         func(e *processTerminalEnvelope) { e.Record.Observation.StdoutBytes = ^uint64(0) },
		"not-terminal":     func(e *processTerminalEnvelope) { e.Record.Observation.GroupCleanup = processsvc.CleanupUnverified },
		"wrong-next":       func(e *processTerminalEnvelope) { e.Record.Observation.StderrNext++ },
		"invalid-original": func(e *processTerminalEnvelope) { e.Record.Intent.Seal.Digest = "bad" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			_, e, _ := decodeProcessTerminal(raw)
			change(e)
			bad, _ := processCanonical(e)
			_, _, err := decodeProcessTerminal(bad)
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	variants := map[string][]byte{
		"empty":               nil,
		"chunk-as-manifest":   chunks[0].raw,
		"trailing":            append(bytes.Clone(raw), '\n'),
		"extra-field":         bytes.Replace(raw, []byte(`"waited":true`), []byte(`"waited":true,"extra":false`), 1),
		"duplicate-field":     bytes.Replace(raw, []byte(`"waited":true`), []byte(`"waited":true,"waited":true`), 1),
		"missing-false":       bytes.Replace(raw, []byte(`,"timedOut":false`), nil, 1),
		"missing-zero":        bytes.Replace(raw, []byte(`"stdoutOffset":0,`), nil, 1),
		"noncanonical-number": bytes.Replace(raw, []byte(`"exitSignal":0`), []byte(`"exitSignal":-0`), 1),
		"oversize-record":     bytes.Repeat([]byte(" "), maxRecordBytes+1),
		"invalid-utf8":        {255},
	}
	reserved, _ := encodeProcess(v.Scope, v.Intent)
	variants["v4-reserved"] = reserved
	for name, bad := range variants {
		t.Run(name, func(t *testing.T) {
			_, _, err := decodeProcessTerminal(bad)
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	if !validProcessDigests(base.Record.Stdout, uint64(len(v.Observation.Stdout))) {
		t.Fatal("original digest list lost")
	}
}
func TestProcessTerminalChunkStrictCorruption(t *testing.T) {
	v := terminalValue(bytes.Repeat([]byte("a"), processOutputChunkBytes), nil)
	raw, chunks, _ := encodeProcessTerminal(v)
	_, e, _ := decodeProcessTerminal(raw)
	d := e.Record.Stdout[0]
	parent, _ := recordKey(processIdentity(v.Scope, v.Intent.OperationID))
	changes := map[string]func(*processOutputEnvelope){
		"version": func(e *processOutputEnvelope) { e.Version = 4 },
		"kind":    func(e *processOutputEnvelope) { e.Kind = "workspace_connector_process_terminal" },
		"parent":  func(e *processOutputEnvelope) { e.Record.Parent = strings.Repeat("b", 64) + ".json" },
		"stream":  func(e *processOutputEnvelope) { e.Record.Stream = "stderr" },
		"offset":  func(e *processOutputEnvelope) { e.Record.Offset++ },
		"hash":    func(e *processOutputEnvelope) { e.Record.SHA256 = strings.Repeat("b", 64) },
		"payload": func(e *processOutputEnvelope) { e.Record.Data[0] ^= 1 },
		"short":   func(e *processOutputEnvelope) { e.Record.Data = e.Record.Data[:1] },
		"large":   func(e *processOutputEnvelope) { e.Record.Data = append(e.Record.Data, 'a') },
		"empty":   func(e *processOutputEnvelope) { e.Record.Data = nil },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			var c processOutputEnvelope
			if json.Unmarshal(chunks[0].raw, &c) != nil {
				t.Fatal("fixture")
			}
			change(&c)
			bad, _ := processCanonical(c)
			_, err := decodeProcessOutput(bad, parent, "stdout", d)
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	for name, bad := range map[string][]byte{
		"missing": nil, "manifest": raw,
		"oversize-record":     bytes.Repeat([]byte("x"), maxRecordBytes+1),
		"extra":               bytes.Replace(chunks[0].raw, []byte(`"offset":0`), []byte(`"offset":0,"extra":0`), 1),
		"missing-offset":      bytes.Replace(chunks[0].raw, []byte(`"offset":0,`), nil, 1),
		"duplicate":           bytes.Replace(chunks[0].raw, []byte(`"offset":0`), []byte(`"offset":0,"offset":0`), 1),
		"base64-noncanonical": bytes.Replace(chunks[0].raw, []byte(`"data":"`), []byte("\"data\":\"\\n"), 1),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := decodeProcessOutput(bad, parent, "stdout", d)
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	for _, key := range []string{processOutputKey(parent, "stderr", d), processOutputKey(strings.Repeat("b", 64)+".json", "stdout", d), processOutputKey(parent, "stdout", processOutputDigest{Offset: 1, SHA256: d.SHA256}), processOutputKey(parent, "stdout", processOutputDigest{SHA256: strings.Repeat("b", 64)})} {
		if key == chunks[0].key || key == parent {
			t.Fatal("output key ignores binding")
		}
	}
}
