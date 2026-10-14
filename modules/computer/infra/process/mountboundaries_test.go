package process

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func mountedPlatformFixture(t *testing.T) platformFixture {
	f := platformFixtureCPU(t)
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	root := f.policy.Snapshot.Participant.Grant.Workspaces[0].Root
	v := f.facts.directories[root]
	v.nested = true
	v.mounts = root + "/volume"
	f.facts.directories[root] = v
	parent := f.facts.directories[f.original.Root]
	parent.nested, parent.mounts = true, v.mounts
	f.facts.directories[f.original.Root] = parent
	return f
}

func TestMountBoundaryCompilerDeniesOnlyMeasuredSubtrees(t *testing.T) {
	f := mountedPlatformFixture(t)
	strategy := f.strategy(t)
	policy, err := strategy.selectMountBoundaries(context.Background(), f.policy, f.original)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(policy, f.original)
	if err != nil {
		t.Fatal(err)
	}
	path := f.policy.Snapshot.Participant.Grant.Workspaces[0].Root + "/volume"
	for _, alias := range mountDenialAliases(path) {
		if !hasParameterRule(plan, "deny file-read* file-write* process-exec", "subpath", alias) {
			t.Fatal("mount alias not denied", alias)
		}
	}
	if !hasParameterRule(plan, "allow file-read*", "subpath", f.policy.Snapshot.Participant.Grant.Workspaces[0].Root) || !slices.Equal(policy.MountDenials, []string{path}) || len(f.policy.MountDenials) != 0 {
		t.Fatal("local root or caller policy changed")
	}
	// Binding has to be regenerated after the restrictive policy is selected.
	command := copyCommand(f.original)
	command.Confinement = nil
	command, err = (&Seatbelt{selection: policy}).bind(command)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := strategy.Select(context.Background(), policy, command, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	deadline := f.clock.Now().Add(time.Second)
	q, err := selected.BindInvocation(context.Background(), command, selected.WrappedCommand(), deadline)
	if err != nil || q.Qualify(context.Background(), selected.WrappedCommand()) != nil {
		t.Fatal("frozen topology refused", err)
	}
	changed := f.facts.directories[f.original.Root]
	changed.mounts += "\n" + f.original.Root + "/volume-new"
	f.facts.directories[f.original.Root] = changed
	if q.Qualify(context.Background(), selected.WrappedCommand()) == nil {
		t.Fatal("new mount accepted after sealing")
	}
}
func TestMountBoundaryMalformedAndOverlappingSelectionsRefuse(t *testing.T) {
	for _, mode := range []string{"cwd", "scratch", "image", "outside", "duplicate", "unsorted", "newline", "legacy", "missing-facts"} {
		t.Run(mode, func(t *testing.T) {
			f := mountedPlatformFixture(t)
			s := f.policy
			s.RootVolumeOnly = true
			s.MountDenials = []string{f.policy.Snapshot.Participant.Grant.Workspaces[0].Root + "/volume"}
			c := f.original
			switch mode {
			case "cwd":
				c.Cwd = s.MountDenials[0]
			case "scratch":
				s.Scratch = s.MountDenials[0] + "/scratch"
			case "image":
				s.ProtectedImages[0].Path = s.MountDenials[0] + "/backend"
			case "outside":
				s.MountDenials = []string{"/not-approved/volume"}
			case "duplicate":
				s.MountDenials = append(s.MountDenials, s.MountDenials[0])
			case "unsorted":
				s.MountDenials = []string{f.original.Root + "/z", f.original.Root + "/a"}
			case "newline":
				s.MountDenials = []string{f.original.Root + "/volume\nother"}
			case "legacy":
				s.FilePolicy = ""
			case "missing-facts":
				root := f.policy.Snapshot.Participant.Grant.Workspaces[0].Root
				v := f.facts.directories[root]
				v.mounts = ""
				f.facts.directories[root] = v
			}
			if mode == "missing-facts" {
				if _, err := f.strategy(t).selectMountBoundaries(context.Background(), f.policy, c); err == nil {
					t.Fatal("unmeasured boundary accepted")
				}
				return
			}
			if _, err := compileSeatbelt(s, c); err == nil {
				t.Fatal("malformed/overlapping denial accepted")
			}
		})
	}
}
func TestMountBoundaryLegacyClassStillRefusesMountedRoot(t *testing.T) {
	f := mountedPlatformFixture(t)
	f.descriptor.FilesystemClass = rootScopedPlatformClass
	if selected, err := f.strategy(t).Select(context.Background(), f.policy, f.original, f.watchdog); err == nil || selected != nil {
		t.Fatal("legacy class gained mounted-root support")
	}
}
func TestMountBoundaryPolicyIsFrozenAndDoesNotAcceptCallerDenials(t *testing.T) {
	f := mountedPlatformFixture(t)
	s := f.policy
	s.RootVolumeOnly = true
	s.MountDenials = []string{f.policy.Snapshot.Participant.Grant.Workspaces[0].Root + "/volume"}
	if _, err := f.strategy(t).selectMountBoundaries(context.Background(), s, f.original); err == nil {
		t.Fatal("caller supplied native topology")
	}
	policy, err := NewSeatbelt(s, platformPendingQualification{})
	if err != nil {
		t.Fatal(err)
	}
	s.MountDenials[0] = "/changed"
	if strings.Contains(policy.selection.MountDenials[0], "changed") {
		t.Fatal("mutable policy input retained")
	}
}
func TestNativeFailureFilesystemReasonDoesNotEraseUnknown(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		f := &processsvc.NativeFailure{Unknown: unknown, FilesystemUnsupported: true}
		if f.Error() != "PROCESS_NATIVE_UNAVAILABLE" {
			t.Fatal("native details leaked")
		}
	}
}

func TestMountBoundaryKernelConditionCannotBeOmittedOrClaimAnotherVolume(t *testing.T) {
	for _, mode := range []string{"omitted-kernel", "other-volume", "remote", "missing-mount-list"} {
		t.Run(mode, func(t *testing.T) {
			f := mountedPlatformFixture(t)
			strategy := f.strategy(t)
			policy, err := strategy.selectMountBoundaries(context.Background(), f.policy, f.original)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "omitted-kernel":
				policy.RootVolumeOnly = false
			case "other-volume", "remote", "missing-mount-list":
				path := f.policy.Snapshot.Participant.Grant.Workspaces[0].Root
				fact := f.facts.directories[path]
				if mode == "other-volume" {
					fact.mount = "/Volumes/AnotherAPFS"
				}
				if mode == "remote" {
					fact.local = false
				}
				if mode == "missing-mount-list" {
					fact.mounts = ""
				}
				f.facts.directories[path] = fact
			}
			if strategy.mountBoundariesCurrent(context.Background(), policy, f.original) {
				t.Fatal("unqualified kernel/topology accepted")
			}
		})
	}
	f := platformFixtureCPU(t)
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	policy, err := f.strategy(t).selectMountBoundaries(context.Background(), f.policy, f.original)
	if err != nil || !policy.RootVolumeOnly || len(policy.MountDenials) != 0 {
		t.Fatal("unmounted root omitted continuous enforcement", err)
	}
	plan, err := compileSeatbelt(policy, f.original)
	if err != nil || !strings.Contains(plan.source, `(mount-root-literal "/")`) || !strings.Contains(plan.source, `(filesystem-name "apfs")`) {
		t.Fatal("kernel predicate missing", err)
	}
}

// Regression for the package Go/MCP fixture: an unverified sibling is a
// current authorization problem, not an observed unsupported filesystem.
func TestMountBoundaryPreservesUnverifiedWorkspaceRefusal(t *testing.T) {
	f := platformFixtureCPU(t)
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	addRootScope(&f.policy, "unchecked-sibling", "/approved/unchecked", authority.WriteAccess)
	f.policy.Snapshot.Approval.Workspaces[len(f.policy.Snapshot.Approval.Workspaces)-1].ShellVerified = false
	paths, err := f.strategy(t).mountBoundaryPaths(context.Background(), f.policy, f.original)
	var failure *processsvc.Failure
	if paths != nil || !errors.As(err, &failure) || failure.Code != "PROCESS_PREPARATION_WORKSPACE_STALE" {
		t.Fatalf("unverified scope lost its refusal classification: %T", err)
	}
	if f.policy.Snapshot.Approval.Workspaces[len(f.policy.Snapshot.Approval.Workspaces)-1].ShellVerified {
		t.Fatal("inspection manufactured verification")
	}
}
func TestMountBoundaryStillRefusesNonAPFSFacts(t *testing.T) {
	f := platformFixtureCPU(t)
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	root := f.policy.Snapshot.Participant.Grant.Workspaces[0].Root
	facts := f.facts.directories[root]
	facts.filesystem = "hfs"
	f.facts.directories[root] = facts
	paths, err := f.strategy(t).mountBoundaryPaths(context.Background(), f.policy, f.original)
	var failure *processsvc.NativeFailure
	if paths != nil || !errors.As(err, &failure) || !failure.FilesystemUnsupported {
		t.Fatalf("unsupported filesystem was not refused: %T", err)
	}
}
