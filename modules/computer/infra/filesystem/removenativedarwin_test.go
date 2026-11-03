//go:build darwin

package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

// Disposable physical filesystem only: no live profile, journal or MCP.
func TestNativeRemoveOneFilePreservesNeighbor(t *testing.T) {
	d := fixture(t)
	put(t, d, "owned.md", []byte("owned"))
	put(t, d, "neighbor.md", []byte("keep"))
	op := mutation.Remove{RelativePath: "owned.md", ExpectedSHA256: payloadHash([]byte("owned"))}
	request := port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: d.WorkspaceID, Root: d.Root, ApprovedRoot: d.ApprovedRoot}, Operation: op, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
	out, err := NewMutable(d.Root+"-home").Mutate(context.Background(), request)
	if err != nil || out == nil || out.BeforeSHA256 == nil || *out.BeforeSHA256 != op.ExpectedSHA256 || out.AfterSHA256 != "" {
		t.Fatalf("bad removal: %+v %v", out, err)
	}
	if _, err := os.Lstat(filepath.Join(d.Root, "owned.md")); !os.IsNotExist(err) {
		t.Fatalf("target remains: %v", err)
	}
	neighbor, err := os.ReadFile(filepath.Join(d.Root, "neighbor.md"))
	if err != nil || string(neighbor) != "keep" {
		t.Fatal("neighbor changed")
	}
	entries, err := os.ReadDir(d.Root)
	if err != nil || len(entries) != 1 || entries[0].Name() != "neighbor.md" {
		t.Fatalf("successful removal retained a stage: %v %v", entries, err)
	}
}

type nativeMoveRace struct {
	mutationFS
	before func() error
}

func (f nativeMoveRace) moveExclusive(from int, name string, to int, target string) error {
	if err := f.before(); err != nil {
		return err
	}
	return f.mutationFS.moveExclusive(from, name, to, target)
}

// The external replacement is injected immediately before the real Darwin
// rename. This is a disposable race witness, not adversarial same-UID isolation.
func TestNativeRemoveRetainsReplacementAtMoveBoundary(t *testing.T) {
	d := fixture(t)
	put(t, d, "owned.md", []byte("owned"))
	put(t, d, "replacement.tmp", []byte("replacement"))
	op := mutation.Remove{RelativePath: "owned.md", ExpectedSHA256: payloadHash([]byte("owned"))}
	request := port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: d.WorkspaceID, Root: d.Root, ApprovedRoot: d.ApprovedRoot}, Operation: op, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
	m := NewMutable(d.Root + "-home")
	m.fs = nativeMoveRace{mutationFS: m.fs, before: func() error {
		return os.Rename(filepath.Join(d.Root, "replacement.tmp"), filepath.Join(d.Root, "owned.md"))
	}}
	out, err := m.Mutate(context.Background(), request)
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if out != nil {
		t.Fatal("replacement must not produce a success receipt")
	}
	entries, err := os.ReadDir(d.Root)
	if err != nil || len(entries) != 1 || !strings.HasPrefix(entries[0].Name(), ".farol-mutation-") {
		t.Fatalf("expected retained stage: %v %v", entries, err)
	}
	data, err := os.ReadFile(filepath.Join(d.Root, entries[0].Name(), "candidate"))
	if err != nil || string(data) != "replacement" {
		t.Fatalf("replacement was not retained: %q %v", data, err)
	}
}
