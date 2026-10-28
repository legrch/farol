//go:build darwin

package process

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Read-only parser witness. No process, runtime approval, confinement or user
// program is dispatched; missing installations are explicitly not covered.
func TestNativeHostRuntimeKnownImages(t *testing.T) {
	for _, alias := range []string{"/Library/Developer/CommandLineTools/usr/bin/git", "/opt/homebrew/bin/git", "/opt/homebrew/bin/python3"} {
		t.Run(alias, func(t *testing.T) {
			p, err := filepath.EvalSymlinks(alias)
			if os.IsNotExist(err) {
				t.Skip("optional installed image absent")
			}
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			fs := nativeHostRuntimeFilesystem{}
			node, err := fs.node(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			imports, macho, err := fs.imports(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			if !macho || imports.fileType != 2 || node.SHA256 == "" {
				t.Fatal("not a measured ARM64 executable")
			}
			t.Logf("bounded parser only: libraries=%q rpaths=%q", imports.libraries, imports.rpaths)
		})
	}
}

func TestNativeHostRuntimeDiscoveryReadOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	plan, err := DiscoverInstalledHostRuntime(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, selected := range plan.frozen.Installations {
		t.Logf("read-only selected %s layout %s", selected.Kind, selected.Root)
	}
	for _, missing := range plan.frozen.Unavailable {
		t.Logf("not qualified: %s %s", missing.Kind, missing.Code)
	}
	t.Logf("read-only inventory: nodes=%d exec=%d mutable-parents=%d; no dispatch authority", len(plan.frozen.Nodes), len(plan.frozen.ExecFiles), len(plan.frozen.MutableParents))
}

type observedNativeHostRuntimeFS struct {
	nativeHostRuntimeFilesystem
	last string
}

func (f *observedNativeHostRuntimeFS) node(ctx context.Context, p string) (hostRuntimeNode, error) {
	f.last = p
	return f.nativeHostRuntimeFilesystem.node(ctx, p)
}
func TestNativeHostRuntimeLayoutBoundaries(t *testing.T) {
	for _, kind := range []string{"git", "python"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			f := &observedNativeHostRuntimeFS{}
			for _, alias := range hostRuntimeCandidates(kind) {
				physical, err := f.resolve(ctx, alias)
				if os.IsNotExist(err) {
					continue
				}
				if err != nil {
					t.Fatal(err)
				}
				layout, boundaries, err := hostRuntimeLayoutFor(kind, alias, physical)
				if err != nil {
					t.Fatal(err)
				}
				b := newHostRuntimeBuilder(ctx, f)
				b.mainExecutable = physical
				image, err := b.physical(alias, boundaries)
				if err != nil {
					t.Fatalf("image selection: %v last=%s", err, f.last)
				}
				if err := b.file(image, boundaries); err != nil {
					t.Fatalf("image closure: %v last=%s", err, f.last)
				}
				for _, tree := range layout.trees {
					if err := b.tree(tree, boundaries, 0); err != nil {
						t.Fatalf("tree: %v last=%s", err, f.last)
					}
				}
				if _, err := b.finish(); err != nil {
					t.Fatalf("final snapshot: %v last=%s", err, f.last)
				}
				return
			}
			t.Skip("optional installation absent")
		})
	}
}

// Native metadata plus CPU compilation only, not an execution attestation.
func TestNativeHostRuntimeProfileFitsOriginalCommandBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, err := DiscoverInstalledHostRuntime(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s, command := rootScopedFixture(t)
	s.HostRuntime = p
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	command.Executable, command.ExecutableSHA256 = seatbeltExecutable, s.MechanismSHA256
	command.Args = append(plan.arguments, "/bin/bash", "--noprofile", "--norc", "-c", "builtin printf fixture")
	if !validCommand(command) {
		t.Fatalf("native installed closure exceeds original command limit: source=%d arguments=%d", len(plan.source), len(command.Args))
	}
	t.Logf("bounded installed closure: nodes=%d executable-files=%d profile-bytes=%d", len(p.frozen.Nodes), len(p.frozen.ExecFiles), len(plan.source))
}
