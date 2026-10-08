package process

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// All Git witnesses here are deterministic compiler/handle doubles. No Git,
// filesystem, native process, hook, sandbox or provider is invoked.
func gitReadFixture(t *testing.T) (SeatbeltSelection, Command) {
	t.Helper()
	_, s, c, _ := confinementFixture(t)
	s.Git = QualifiedGitRead
	s.GitRead = &GitReadSelection{Executable: c.Executable, Worktree: c.Cwd,
		GitDirectory: "/approved/metadata/worktrees/writer", CommonDirectory: "/approved/metadata",
		WorktreeIdentity:        authority.RootIdentity{Device: "1", Inode: "31"},
		GitDirectoryIdentity:    authority.RootIdentity{Device: "1", Inode: "32"},
		CommonDirectoryIdentity: authority.RootIdentity{Device: "1", Inode: "33"}}
	w := &s.Snapshot.Approval.Workspaces[0]
	w.GitHistoryApproved = true
	w.GitMetadata = &authority.GitMetadata{GitDirectory: s.GitRead.GitDirectory, CommonDirectory: s.GitRead.CommonDirectory}
	addRootScope(&s, "metadata", s.GitRead.CommonDirectory, authority.WriteAccess)
	s.Snapshot.Approval.Workspaces[1].RootIdentity = s.GitRead.CommonDirectoryIdentity
	// Ordinary tool/config roots need independent coherent approval and identity.
	addRootScope(&s, "toolchain", "/approved/toolchain", authority.ReadAccess)
	c.Write = false
	c.Input = nil
	c.Args, _ = GitReadArguments(*s.GitRead, GitReadStatus)
	c.Environment = seatbeltEnvironment(s, false)
	return s, c
}

func TestGitReadClosedViewsAndStrictReadOnlyProfile(t *testing.T) {
	for _, view := range []GitReadView{GitReadStatus, GitReadDiff, GitReadStagedDiff} {
		s, c := gitReadFixture(t)
		c.Args, _ = GitReadArguments(*s.GitRead, view)
		plan, err := compileSeatbelt(s, c)
		if err != nil || len(plan.gitDirectories) != 3 {
			t.Fatal("qualified linked selection refused", err)
		}
		for _, root := range plan.roots {
			if root.Access != authority.ReadAccess || !hasParameterRule(plan, "allow file-read*", "subpath", root.ScopeRoot) ||
				hasParameterRule(plan, "allow file-write*", "subpath", root.ScopeRoot) ||
				!hasParameterRule(plan, "allow process-exec", "subpath", root.ScopeRoot) ||
				!hasParameterRule(plan, "deny file-read* file-write*", "subpath", root.ScopeRoot+"/.env") {
				t.Fatal("scope/write/toolchain/protected-path rule lost", root)
			}
		}
		if !strings.Contains(plan.source, credentialRegex()) || !strings.Contains(plan.source, "(deny network*)") ||
			!hasParameterRule(plan, "deny file-read* file-write*", "subpath", s.Home+"/.npmrc") {
			t.Fatal("strict protected-path/network policy lost")
		}
		for _, entry := range c.Environment {
			if strings.HasPrefix(entry, "GIT_CONFIG_") || strings.Contains(entry, "core.hooksPath") {
				t.Fatal("ordinary config/hooks secretly disabled", entry)
			}
		}
		if !slices.Contains(c.Environment, "GIT_COMMON_DIR="+s.GitRead.CommonDirectory) ||
			!slices.Contains(c.Environment, "HOME="+s.Home) || !slices.Contains(c.Environment, "GIT_OPTIONAL_LOCKS=0") {
			t.Fatal("metadata/env selection lost")
		}
	}
	if _, err := GitReadArguments(GitReadSelection{}, GitReadStatus); err == nil {
		t.Fatal("unbound metadata accepted")
	}
	s, _ := gitReadFixture(t)
	if _, err := GitReadArguments(*s.GitRead, "commit"); err == nil {
		t.Fatal("Git effect view accepted")
	}
}

func TestGitReadRefusesMissingWidenedOrCrossedAuthority(t *testing.T) {
	cases := map[string]func(*SeatbeltSelection, *Command){
		"no-selection": func(s *SeatbeltSelection, _ *Command) { s.GitRead = nil },
		"wrong-file-policy": func(s *SeatbeltSelection, _ *Command) {
			s.FilePolicy = authority.RootScopedFiles
			s.Snapshot.Participant.Grant.FilePolicy = authority.RootScopedFiles
			s.Snapshot.Approval.FilePolicy = authority.RootScopedFiles
		},
		"unapproved-history": func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Workspaces[0].GitHistoryApproved = false },
		"missing-metadata":   func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Workspaces[0].GitMetadata = nil },
		"changed-gitdir": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Approval.Workspaces[0].GitMetadata.GitDirectory += "/other"
		},
		"changed-common": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Approval.Workspaces[0].GitMetadata.CommonDirectory += "/other"
		},
		"no-metadata-owner": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Approval.Workspaces = s.Snapshot.Approval.Workspaces[:1]
		},
		"no-metadata-task": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Participant.Grant.Workspaces = s.Snapshot.Participant.Grant.Workspaces[:1]
		},
		"narrower-metadata-task": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Participant.Grant.Workspaces[1].Root += "/worktrees"
		},
		"missing-gitdir-identity": func(s *SeatbeltSelection, _ *Command) { s.GitRead.GitDirectoryIdentity.Inode = "" },
		"missing-cwd-identity":    func(s *SeatbeltSelection, _ *Command) { s.GitRead.WorktreeIdentity.Device = "" },
		"write":                   func(s *SeatbeltSelection, c *Command) { c.Write = true; c.Environment = seatbeltEnvironment(*s, true) },
		"stdin":                   func(_ *SeatbeltSelection, c *Command) { c.Input = []byte("input") },
		"alternate-executable": func(s *SeatbeltSelection, c *Command) {
			c.Executable = "/selected/other"
			s.Executables = append(s.Executables, ExecutablePin{c.Executable, c.ExecutableSHA256})
			c.Environment = seatbeltEnvironment(*s, false)
		},
		"alternate-cwd": func(_ *SeatbeltSelection, c *Command) { c.Cwd += "/nested" },
		"commit":        func(_ *SeatbeltSelection, c *Command) { c.Args = append(c.Args[:3], "commit") },
		"config-injection": func(_ *SeatbeltSelection, c *Command) {
			c.Args = append([]string{"-c", "core.fsmonitor=/outside/hook"}, c.Args...)
		},
		"extra-options": func(_ *SeatbeltSelection, c *Command) { c.Args = append(c.Args, "--untracked-files=all") },
		"common-env-injection": func(_ *SeatbeltSelection, c *Command) {
			c.Environment[len(c.Environment)-1] = "GIT_COMMON_DIR=/outside"
		},
		"exclusion": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "metadata", Path: s.GitRead.GitDirectory}}
		},
		"unverified-metadata": func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Workspaces[1].ShellVerified = false },
		"broad-home":          func(s *SeatbeltSelection, _ *Command) { addRootScope(s, "home", s.Home, authority.ReadAccess) },
		"protected-toolchain": func(s *SeatbeltSelection, _ *Command) {
			addRootScope(s, "credential", s.Home+"/.ssh", authority.ReadAccess)
		},
		"metadata-escape": func(s *SeatbeltSelection, c *Command) {
			s.GitRead.CommonDirectory = "/outside"
			s.Snapshot.Approval.Workspaces[0].GitMetadata.CommonDirectory = "/outside"
			c.Environment = seatbeltEnvironment(*s, false)
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, c := gitReadFixture(t)
			change(&s, &c)
			if _, err := compileSeatbelt(s, c); err == nil {
				t.Fatal("crossed/widened Git read selection accepted")
			}
		})
	}
}

func TestGitReadCopiesSelectionSealsIdentitiesAndChecksCurrentMetadata(t *testing.T) {
	s, c := gitReadFixture(t)
	evidence := &confinementEvidenceDouble{}
	selected, err := NewSeatbelt(s, evidence)
	if err != nil {
		t.Fatal(err)
	}
	bound, err := selected.bind(c)
	if err != nil {
		t.Fatal(err)
	}
	s.GitRead.CommonDirectoryIdentity.Inode = "mutated-caller"
	again, err := selected.bind(c)
	if err != nil || *bound.Confinement != *again.Confinement || evidence.calls != 0 {
		t.Fatal("mutable binding or native IO", err)
	}
	for _, target := range []string{"worktree", "gitdir", "common"} {
		changed := selected.selection
		g := *changed.GitRead
		changed.GitRead = &g
		switch target {
		case "worktree":
			g.WorktreeIdentity.Inode += "1"
		case "gitdir":
			g.GitDirectoryIdentity.Inode += "1"
		case "common":
			g.CommonDirectoryIdentity.Inode += "1"
		}
		plan, err := compileSeatbelt(changed, c)
		if err != nil || plan.digest == bound.Confinement.ProfileSHA256 {
			t.Fatal("identity not sealed", target, err)
		}
	}
	current := selected.selection.Snapshot
	p, a := current.Participant.Clone(), current.Approval.Clone()
	current.Participant, current.Approval = &p, &a
	a.Workspaces[0].GitMetadata.CommonDirectory += "/replacement"
	if selected.matchesPolicy(c, current) {
		t.Fatal("current metadata drift not refused")
	}
	if _, err := selectedLaunch(selected, c); err == nil {
		t.Fatal("unsealed command reached launch")
	}
}

func gitReadMeasurementFixture(t *testing.T) (*Seatbelt, Command, *confinedLaunch, *measurementFilesystemDouble) {
	t.Helper()
	s, c := gitReadFixture(t)
	selected, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	c, err = selected.bind(c)
	if err != nil {
		t.Fatal(err)
	}
	launch, err := selectedLaunch(selected, c)
	if err != nil {
		t.Fatal(err)
	}
	fs := &measurementFilesystemDouble{directories: map[string]directoryFacts{}}
	put := func(path string, identity authority.RootIdentity) {
		fs.directories[path] = directoryFacts{identity, os.ModeDir | 0700, 501}
	}
	put(c.Root, c.RootIdentity)
	put(launch.scratch, launch.scratchIdentity)
	for _, root := range launch.roots {
		put(root.ApprovedRoot, root.RootIdentity)
		put(root.ScopeRoot, root.RootIdentity)
	}
	for _, directory := range launch.gitDirectories {
		put(directory.Path, directory.Identity)
	}
	return selected, c, launch, fs
}

func TestGitReadMeasurementsRetainExactMetadataAndRefuseReplacement(t *testing.T) {
	for _, mode := range []string{"valid", "gitdir-inode", "common-inode", "worktree-inode", "gitdir-symlink", "common-alias", "partial-open", "late-replacement"} {
		t.Run(mode, func(t *testing.T) {
			selected, c, launch, fs := gitReadMeasurementFixture(t)
			g := selected.selection.GitRead
			change := func(path string) {
				facts := fs.directories[path]
				facts.identity.Inode += "changed"
				fs.directories[path] = facts
			}
			switch mode {
			case "gitdir-inode":
				change(g.GitDirectory)
			case "common-inode":
				change(g.CommonDirectory)
			case "worktree-inode":
				change(g.Worktree)
			case "gitdir-symlink":
				facts := fs.directories[g.GitDirectory]
				facts.mode |= os.ModeSymlink
				fs.directories[g.GitDirectory] = facts
			case "common-alias":
				fs.alias = g.CommonDirectory
			case "partial-open":
				fs.directoryError = g.GitDirectory
			case "late-replacement":
				fs.afterOpen = func(path string) {
					if path == g.CommonDirectory && len(fs.anchored) >= len(launch.roots)+3 {
						change(g.GitDirectory)
					}
				}
			}
			boot := &measurementBootstrapDouble{before: func() { fs.assertCloses(t, 0) }}
			err := measureWithParentDouble(t, selected, c, fs, func(context.Context) error { return nil }, boot)
			var failure *processsvc.NativeFailure
			if !errors.As(err, &failure) {
				t.Fatal("missing classified failure", err)
			}
			if mode == "valid" {
				if boot.calls != 1 || !failure.Unknown {
					t.Fatal("one synthetic bootstrap not reached", err)
				}
				for _, directory := range launch.gitDirectories {
					found := false
					for _, pair := range fs.anchored {
						found = found || pair[0] == directory.ApprovedRoot && insidePolicy(pair[0], directory.Path) && pair[0]+"/"+pair[1] == directory.Path
					}
					// The common root uses the descriptor-relative '.' spelling.
					if !found && directory.Path != directory.ApprovedRoot {
						t.Fatal("metadata not anchored", directory)
					}
				}
			} else if boot.calls != 0 || failure.Unknown {
				t.Fatal("changed metadata reached bootstrap", mode, err)
			}
			fs.assertCloses(t, 1)
		})
	}
}

func TestGitReadUsesExistingPreparerWithoutNativeQualification(t *testing.T) {
	s, c := gitReadFixture(t)
	evidence := &confinementEvidenceDouble{}
	policy, err := NewSeatbelt(s, evidence)
	if err != nil {
		t.Fatal(err)
	}
	c.Args, c.Binding = nil, nil
	p, err := NewPreparer(s.RuntimeID, c, policy, &testClock{time.UnixMilli(1900000000000)})
	if err != nil {
		t.Fatal(err)
	}
	if !p.MatchesPolicy(s.Snapshot) {
		t.Fatal("empty trusted template cannot pass current guard")
	}
	args, _ := GitReadArguments(*s.GitRead, GitReadDiff)
	prepared, err := p.Prepare(context.Background(), processsvc.Invocation{RuntimeID: s.RuntimeID, SessionID: "session", ModelID: "model", AdmissionID: "authority", Arguments: args})
	if err != nil || prepared.Seal().Write || evidence.calls != 0 {
		t.Fatal("preparation dispatched or widened scope", err)
	}
	if _, err := NewSeatbelt(s, nil); err == nil {
		t.Fatal("missing qualification accepted")
	}
}

func TestGitReadOrdinaryRepositoryDeduplicatesConsistentMetadata(t *testing.T) {
	s, c := gitReadFixture(t)
	s.GitRead.GitDirectory = c.Cwd + "/.git"
	s.GitRead.CommonDirectory = s.GitRead.GitDirectory
	s.GitRead.CommonDirectoryIdentity = s.GitRead.GitDirectoryIdentity
	w := &s.Snapshot.Approval.Workspaces[0]
	w.GitMetadata = &authority.GitMetadata{GitDirectory: s.GitRead.GitDirectory, CommonDirectory: s.GitRead.CommonDirectory}
	c.Args, _ = GitReadArguments(*s.GitRead, GitReadStatus)
	c.Environment = seatbeltEnvironment(s, false)
	plan, err := compileSeatbelt(s, c)
	if err != nil || len(plan.gitDirectories) != 2 {
		t.Fatal("ordinary metadata binding refused or duplicated", err)
	}
	s.GitRead.CommonDirectoryIdentity.Inode += "crossed"
	if _, err := compileSeatbelt(s, c); err == nil {
		t.Fatal("one metadata path with conflicting identities accepted")
	}
}

func newGitReadWatchdogFixture(t *testing.T) *watchdogFixture {
	t.Helper()
	f := newWatchdogFixture(t)
	s, c := gitReadFixture(t)
	s.Snapshot.Participant.Grant.Identity = f.lease.binding.Identity
	s.Snapshot.Participant.Grant.ExpiresAt = f.lease.snapshot.Participant.Grant.ExpiresAt
	s.Snapshot.Approval.ExpiresAt = f.lease.snapshot.Approval.ExpiresAt
	policy, err := NewSeatbelt(s, f.evidence)
	if err != nil {
		t.Fatal(err)
	}
	c.Args, c.Binding = nil, nil
	f.preparer.base.template = c
	f.preparer.base.qualification = policy
	f.preparer.boundary.policy = policy
	f.lease.snapshot = s.Snapshot
	args, _ := GitReadArguments(*s.GitRead, GitReadStatus)
	invocation := parentInvocation()
	invocation.Arguments, invocation.Input = args, nil
	out, err := f.route.Prepare(context.Background(), processcontract.PrepareRequest{OperationID: "operation", Invocation: invocation})
	if err != nil || out == nil {
		t.Fatal("Git view not prepared through existing service", out, err)
	}
	f.preparer.selected.schedule = f.timers.schedule
	return f
}

func TestGitReadExistingOwnerRetainsBinaryResultWithoutReplayOrTerminalClaim(t *testing.T) {
	f := newGitReadWatchdogFixture(t)
	if f.host.calls.Load() != 0 || f.evidence.calls != 0 || f.reservation.calls != 0 {
		t.Fatal("Git preparation caused effects")
	}
	start := f.start(t)
	prepare, release := <-f.host.frames, <-f.host.frames
	env := prepare["environment"].(map[string]any)
	if release["type"] != "start" || env["GIT_COMMON_DIR"] != f.preparer.boundary.policy.selection.GitRead.CommonDirectory || env["GIT_OPTIONAL_LOCKS"] != "0" {
		t.Fatal("Git read launch drift", prepare, release)
	}
	id := prepare["id"]
	// Synthetic NUL-delimited output, not real Git status evidence.
	f.emit(t, map[string]any{"type": "stdout", "id": id, "data": "TQBwYXRoAA=="})
	f.emit(t, map[string]any{"type": "close", "id": id, "code": 0, "signal": nil})
	f.settle(t)
	for i := 0; i < 2; i++ {
		out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
		if err != nil || out.StdoutBase64 != "TQBwYXRoAA==" || out.ExitCode == nil || *out.ExitCode != 0 ||
			out.State != processcontract.Unknown || !out.RootWaited || !out.OutputDrained ||
			out.GroupCleanup != processcontract.CleanupUnverified || out.DescendantCleanup != processcontract.CleanupUnverified {
			t.Fatal("retained facts lost or promoted to qualified terminal", out, err)
		}
	}
	_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err == nil || f.preparer.RetainedHandle() != start.Handle || f.host.calls.Load() != 1 || f.host.starts.Load() != 1 || f.reservation.calls != 1 {
		t.Fatal("unknown Git read replayed or handle lost", err)
	}
}

func TestGitReadCurrentMetadataDriftRefusesBeforeReservation(t *testing.T) {
	f := newGitReadWatchdogFixture(t)
	f.lease.snapshot.Approval.Workspaces[0].GitMetadata.GitDirectory += "/other"
	_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err == nil || f.reservation.calls != 0 || f.host.calls.Load() != 0 || f.evidence.calls != 0 {
		t.Fatal("current Git metadata drift reached reservation/native boundary", err)
	}
}
