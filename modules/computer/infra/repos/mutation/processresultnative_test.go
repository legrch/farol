//go:build darwin

package mutation_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
	repository "github.com/legrch/farol/modules/computer/infra/repos/mutation"
)

// These tests exercise only disposable Darwin filesystem storage. The reused
// fixture supplies explicit host, authorization and execution-scope identities;
// terminal observations below are values, never observations of a real child.
// Known Close/reopen is not app, authority, execution, external-effect, recovery
// or power-loss proof. No engine, ordinary Dev, HOME or installed profile is used.
func nativeTerminalValue(scope processsvc.ConnectorReservationScope, intent processsvc.Intent, stdout, stderr []byte) processsvc.TerminalResult {
	code := 7
	return processsvc.TerminalResult{Scope: scope, Intent: intent, Observation: processsvc.Observation{
		Handle: "terminal-fixture", Root: processsvc.RootExited, Waited: true, ExitCode: &code,
		GroupCleanup: processsvc.CleanupConfirmed, DescendantCleanup: processsvc.CleanupConfirmed, OutputDrained: true,
		Stdout: stdout, Stderr: stderr, StdoutNext: uint64(len(stdout)), StderrNext: uint64(len(stderr)),
		StdoutBytes: uint64(len(stdout)), StderrBytes: uint64(len(stderr)),
	}}
}

func nativeTerminalIdentity(v processsvc.TerminalResult) domain.Identity {
	return domain.Identity{Scope: domain.ScopeConnector, OperationID: v.Intent.OperationID,
		OwnerID: v.Scope.OwnerID, ProfileID: v.Scope.Host.ProfileID, ComputerID: v.Scope.ComputerID}
}

func nativeTerminalHash(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func requireNativeTerminal(t *testing.T, r *repository.Repository, want processsvc.TerminalResult) {
	t.Helper()
	got, err := r.LoadProcessTerminal(context.Background(), nativeTerminalIdentity(want))
	if err != nil || got == nil {
		t.Fatalf("load complete terminal: %v", err)
	}
	if got.Scope != want.Scope || got.Intent.OperationID != want.Intent.OperationID ||
		got.Intent.Binding != want.Intent.Binding || got.Intent.Seal != want.Intent.Seal || !got.Intent.Deadline.Equal(want.Intent.Deadline) {
		t.Fatal("original scope or intent changed")
	}
	a, b := got.Observation, want.Observation
	if !bytes.Equal(a.Stdout, b.Stdout) || !bytes.Equal(a.Stderr, b.Stderr) {
		t.Fatal("raw binary terminal output changed")
	}
	a.Stdout, a.Stderr, b.Stdout, b.Stderr = nil, nil, nil, nil
	if !reflect.DeepEqual(a, b) {
		t.Fatal("terminal observation metadata changed")
	}
}

// Observe the whole disposable tree through ordinary filesystem APIs, including
// the retained writer lock. Access times are deliberately excluded: reads may
// update them. Bytes, modes, sizes, inode and modification times must not change.
type nativeTerminalFile struct {
	Data    []byte
	Mode    os.FileMode
	Size    int64
	Inode   uint64
	ModTime time.Time
}

func nativeTerminalSnapshot(t *testing.T, root repository.Root) map[string]nativeTerminalFile {
	t.Helper()
	files := make(map[string]nativeTerminalFile)
	err := filepath.WalkDir(root.Path, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || (!info.IsDir() && !info.Mode().IsRegular()) {
			t.Fatalf("unexpected disposable entry: %s", entry.Name())
		}
		observed := nativeTerminalFile{Mode: info.Mode(), Size: info.Size(), Inode: stat.Ino, ModTime: info.ModTime()}
		if info.Mode().IsRegular() {
			observed.Data, err = os.ReadFile(path)
			if err != nil {
				return err
			}
		}
		name, err := filepath.Rel(root.Path, path)
		if err != nil {
			return err
		}
		files[name] = observed
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func requireNativeTerminalUnchanged(t *testing.T, root repository.Root, before map[string]nativeTerminalFile) {
	t.Helper()
	if !reflect.DeepEqual(before, nativeTerminalSnapshot(t, root)) {
		t.Fatal("read, refusal or known Close/reopen changed disposable storage")
	}
}

type nativeTerminalChunkDigest struct {
	Offset uint64 `json:"offset"`
	Bytes  uint32 `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// Independently inspect published layout and keys, without importing the private
// codec or using it to manufacture expected output. Every record is accounted for.
func inspectNativeTerminalRecords(t *testing.T, root repository.Root, parent string, reserved []byte, want processsvc.TerminalResult, wantChunks int) []string {
	t.Helper()
	dir := filepath.Join(root.Path, "mutations")
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != wantChunks+1 {
		t.Fatalf("want manifest plus %d chunks, got %d: %v", wantChunks, len(entries), err)
	}
	for _, entry := range entries {
		info, err := os.Lstat(filepath.Join(dir, entry.Name()))
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 64*1024 {
			t.Fatalf("record is not a private bounded regular file: %s, %v", entry.Name(), err)
		}
	}
	var original struct {
		Record struct {
			Scope, Intent json.RawMessage
		}
	}
	var manifest struct {
		Version int    `json:"schemaVersion"`
		Kind    string `json:"kind"`
		Record  struct {
			Scope, Intent  json.RawMessage
			Phase          string
			Stdout, Stderr []nativeTerminalChunkDigest
		}
	}
	raw, err := os.ReadFile(filepath.Join(dir, parent))
	if err != nil || json.Unmarshal(raw, &manifest) != nil || json.Unmarshal(reserved, &original) != nil ||
		manifest.Version != 5 || manifest.Kind != "workspace_connector_process_terminal" || manifest.Record.Phase != "terminal" ||
		!bytes.Equal(original.Record.Scope, manifest.Record.Scope) || !bytes.Equal(original.Record.Intent, manifest.Record.Intent) {
		t.Fatal("terminal manifest did not preserve exact original reservation scope/intent", err)
	}
	identityKey, err := json.Marshal([]string{"external-connector-v3", want.Intent.OperationID, want.Scope.OwnerID, want.Scope.Host.ProfileID, want.Scope.ComputerID})
	if err != nil || parent != nativeTerminalHash(identityKey)+".json" {
		t.Fatal("terminal escaped original operation key")
	}
	seen := map[string]bool{parent: true}
	var names []string
	for _, stream := range []struct {
		name string
		data []byte
		list []nativeTerminalChunkDigest
	}{{"stdout", want.Observation.Stdout, manifest.Record.Stdout}, {"stderr", want.Observation.Stderr, manifest.Record.Stderr}} {
		if stream.list == nil || len(stream.list) != (len(stream.data)+32*1024-1)/(32*1024) {
			t.Fatal("unexpected stream chunk count")
		}
		for index, d := range stream.list {
			offset := index * 32 * 1024
			data := stream.data[offset:min(offset+32*1024, len(stream.data))]
			if d.Offset != uint64(offset) || d.Bytes != uint32(len(data)) || d.SHA256 != nativeTerminalHash(data) {
				t.Fatal("manifest chunk digest/offset/size changed")
			}
			keyBytes, err := json.Marshal([]any{"process-output-v5", parent, stream.name, d.Offset, d.SHA256})
			if err != nil {
				t.Fatal(err)
			}
			name := nativeTerminalHash(keyBytes) + ".json"
			if seen[name] {
				t.Fatal("chunk key alias")
			}
			seen[name] = true
			names = append(names, name)
			var chunk struct {
				Version int    `json:"schemaVersion"`
				Kind    string `json:"kind"`
				Record  struct {
					Parent, Stream, SHA256 string
					Offset                 uint64
					Data                   []byte
				}
			}
			raw, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil || json.Unmarshal(raw, &chunk) != nil || chunk.Version != 5 || chunk.Kind != "workspace_connector_process_output" ||
				chunk.Record.Parent != parent || chunk.Record.Stream != stream.name || chunk.Record.Offset != d.Offset ||
				chunk.Record.SHA256 != d.SHA256 || !bytes.Equal(chunk.Record.Data, data) {
				t.Fatal("chunk lost parent/stream/offset/content binding", err)
			}
		}
	}
	if len(names) != wantChunks || len(seen) != len(entries) {
		t.Fatal("unaccounted terminal records")
	}
	return names
}

func requireNativeTerminalFailure(t *testing.T, err error, code string) {
	t.Helper()
	var failure *repository.Failure
	if !errors.As(err, &failure) || failure.Code != code || failure.Retry() != "never" || failure.OutcomeUnknown() {
		t.Fatalf("want known non-retryable %s, got %v", code, err)
	}
}

func TestNativeProcessTerminalPersistsAcrossKnownClose(t *testing.T) {
	for _, test := range []struct {
		name                   string
		stdout, stderr, chunks int
	}{
		{"empty", 0, 0, 0},
		{"above-64-KiB", 70001, 39001, 5},
		{"full-four-MiB-split-129-chunks", 4*1024*1024 - 1, 1, 129},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, scope, intent := nativeProcessFixture(t)
			r := openProcessRepository(t, root)
			reserveProcess(t, r, scope, intent, processsvc.Reserved)
			reserved, parent := processRecord(t, root)
			output := make([]byte, test.stdout+test.stderr)
			for index := range output {
				output[index] = byte(index) // Includes NUL and invalid UTF-8 bytes.
			}
			want := nativeTerminalValue(scope, intent, output[:test.stdout], output[test.stdout:])
			if test.name == "above-64-KiB" {
				want.Observation.ExitCode, want.Observation.ExitSignal = nil, 9
				want.Observation.CancelRequested, want.Observation.TimedOut, want.Observation.AuthorityLost = true, true, true
			}
			want.Observation.OutputLimitReached = test.stdout+test.stderr == 4*1024*1024
			digest, err := r.PublishProcessTerminal(context.Background(), want)
			if err != nil {
				t.Fatal("publish terminal", err)
			}
			inspectNativeTerminalRecords(t, root, parent, reserved, want, test.chunks)
			before := nativeTerminalSnapshot(t, root)
			if digest != nativeTerminalHash(before[filepath.Join("mutations", parent)].Data) {
				t.Fatal("publication digest differs from exact manifest bytes")
			}
			requireNativeTerminal(t, r, want)
			if err := r.Close(); err != nil {
				t.Fatal("known Close", err)
			}
			next := openProcessRepository(t, root)
			requireNativeTerminal(t, next, want)
			requireNativeTerminalUnchanged(t, root, before)
			changed := want.Clone()
			changed.Observation.Handle = "changed-terminal-fixture"
			ack, err := next.PublishProcessTerminal(context.Background(), changed)
			requireNativeTerminalFailure(t, err, "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
			if ack != "" {
				t.Fatal("changed terminal acknowledged")
			}
			selected, err := next.ConnectorProcessReservation(scope)
			if err != nil {
				t.Fatal(err)
			}
			receipt, err := selected.Reserve(context.Background(), intent)
			requireNativeTerminalFailure(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
			if receipt != nil {
				t.Fatal("terminal duplicate supplied a reservation or runnable permit")
			}
			requireNativeTerminal(t, next, want)
			requireNativeTerminalUnchanged(t, root, before)
		})
	}
}

func TestNativeProcessTerminalMissingChunkRefusesReadWithoutRepair(t *testing.T) {
	// Independent root; damage only this test's records after a known Close.
	root, scope, intent := nativeProcessFixture(t)
	r := openProcessRepository(t, root)
	reserveProcess(t, r, scope, intent, processsvc.Reserved)
	reserved, parent := processRecord(t, root)
	want := nativeTerminalValue(scope, intent, []byte{0, 255, 128}, []byte{254, 0})
	if _, err := r.PublishProcessTerminal(context.Background(), want); err != nil {
		t.Fatal("publish terminal", err)
	}
	chunks := inspectNativeTerminalRecords(t, root, parent, reserved, want, 2)
	if err := r.Close(); err != nil {
		t.Fatal("known Close", err)
	}
	missing := filepath.Join(root.Path, "mutations", chunks[0])
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	before := nativeTerminalSnapshot(t, root)
	next := openProcessRepository(t, root)
	got, err := next.LoadProcessTerminal(context.Background(), nativeTerminalIdentity(want))
	requireNativeTerminalFailure(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
	if got != nil {
		t.Fatal("missing chunk exposed an absent, partial or complete result")
	}
	if err := next.Close(); err != nil {
		t.Fatal("reader Close", err)
	}
	requireNativeTerminalUnchanged(t, root, before)
	if _, err := os.Lstat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("missing chunk was repaired", err)
	}
}
