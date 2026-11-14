package process

import (
	"context"
	"encoding/json"
	"errors"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
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

func TestGitReadArgumentsPreserveExactClosedView(t *testing.T) {
	s, _ := gitReadFixture(t)
	// Literal expectations keep view identity independent of the helper used by
	// both command construction and the compiler's closed-argv validation.
	for _, test := range []struct {
		view GitReadView
		want []string
	}{
		{GitReadStatus, []string{"--no-pager", "--git-dir=/approved/metadata/worktrees/writer", "--work-tree=/approved/work/project", "status", "--porcelain=v1", "-z"}},
		{GitReadDiff, []string{"--no-pager", "--git-dir=/approved/metadata/worktrees/writer", "--work-tree=/approved/work/project", "diff", "--no-color", "--"}},
		{GitReadStagedDiff, []string{"--no-pager", "--git-dir=/approved/metadata/worktrees/writer", "--work-tree=/approved/work/project", "diff", "--cached", "--no-color", "--"}},
	} {
		t.Run(string(test.view), func(t *testing.T) {
			got, err := GitReadArguments(*s.GitRead, test.view)
			if err != nil || !slices.Equal(got, test.want) {
				t.Fatalf("closed view arguments = %v, error = %v; want %v", got, err, test.want)
			}
		})
	}
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
			dispatch := &measurementDispatchDouble{before: func() { fs.assertCloses(t, 0) }}
			err := measureThenDispatch(t, selected, c, fs, func(context.Context) error { return nil }, dispatch)
			var failure *processsvc.NativeFailure
			if !errors.As(err, &failure) {
				t.Fatal("missing classified failure", err)
			}
			if mode == "valid" {
				if dispatch.calls != 1 || !failure.Unknown {
					t.Fatal("one synthetic dispatch not reached", err)
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
			} else if dispatch.calls != 0 || failure.Unknown {
				t.Fatal("changed metadata reached dispatch", mode, err)
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
	invocation := sampleInvocation()
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

func gitRuntimeFixture() *GitRuntimeResources {
	return &GitRuntimeResources{
		Git:         ExecutablePin{gitRuntimeImage, strings.Repeat("a", 64)},
		Files:       []ExecutablePin{{gitRuntimeData + "/gitconfig", strings.Repeat("b", 64)}, {gitRuntimeTemplates + "/description", strings.Repeat("c", 64)}},
		Directories: []GitRuntimeDirectory{{gitRuntimeTemplates, []string{"description"}}},
	}
}
func TestGitRuntimeOptionalPinnedSystemAttributes(t *testing.T) {
	r := gitRuntimeFixture()
	r.Files = append([]ExecutablePin{{gitRuntimeAttributes, strings.Repeat("d", 64)}}, r.Files...)
	if !validGitRuntime(r, []ExecutablePin{r.Git}) {
		t.Fatal("selected attributes refused")
	}
	for _, path := range []string{gitRuntimeAttributes + ".backup", gitRuntimeData + "/private"} {
		crossed := cloneGitRuntime(r)
		crossed.Files[0].Path = path
		if validGitRuntime(crossed, []ExecutablePin{r.Git}) {
			t.Fatal("non-selected data admitted", path)
		}
	}
	s, command := rootScopedFixture(t)
	s.Executables = append(s.Executables, r.Git)
	s.GitRuntimeResources = r
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(plan.arguments, "\n"), "="+gitRuntimeAttributes) ||
		!strings.Contains(plan.source, "(deny process-exec ") {
		t.Fatal("attributes lack literal data-only confinement")
	}
}

func TestGitRuntimeFiniteDeclarationAndClone(t *testing.T) {
	r := gitRuntimeFixture()
	if !validGitRuntime(r, []ExecutablePin{r.Git}) {
		t.Fatal("valid tree refused")
	}
	c := cloneGitRuntime(r)
	r.Directories[0].Entries[0] = "changed"
	r.Files[0].SHA256 = strings.Repeat("d", 64)
	if c.Directories[0].Entries[0] != "description" || sameGitRuntime(c, r) {
		t.Fatal("clone retained aliases")
	}
	for _, mode := range []string{"unselected-image", "foreign-file", "foreign-directory", "duplicate", "missing-config", "missing-parent-entry", "extra-entry", "traversal", "oversized", "order"} {
		t.Run(mode, func(t *testing.T) {
			r := gitRuntimeFixture()
			images := []ExecutablePin{r.Git}
			switch mode {
			case "unselected-image":
				images = nil
			case "foreign-file":
				r.Files[0].Path = "/Users/owner/private"
			case "foreign-directory":
				r.Directories[0].Path = gitRuntimeData
			case "duplicate":
				r.Files = append(r.Files, r.Files[1])
			case "missing-config":
				r.Files[0].Path = gitRuntimeTemplates + "/another"
			case "missing-parent-entry":
				r.Directories[0].Entries = nil
			case "extra-entry":
				r.Directories[0].Entries = []string{"description", "private"}
			case "traversal":
				r.Directories[0].Entries = []string{"../description"}
			case "oversized":
				r.Directories = make([]GitRuntimeDirectory, 9)
			case "order":
				slices.Reverse(r.Files)
			}
			if validGitRuntime(r, images) {
				t.Fatal("invalid resources accepted")
			}
		})
	}
}
func TestGitRuntimeCompilerIsLiteralDataOnlyAndSealed(t *testing.T) {
	s, command := rootScopedFixture(t)
	r := gitRuntimeFixture()
	s.Executables = append(s.Executables, r.Git)
	s.GitRuntimeResources = r
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.source, "(deny process-exec ") || !strings.Contains(plan.source, "mount-root-literal") {
		t.Fatal("data execution/mount denial missing")
	}
	for _, f := range r.Files {
		if !strings.Contains(strings.Join(plan.arguments, "\n"), "="+f.Path) {
			t.Fatal("missing literal path")
		}
	}
	plain := s
	plain.GitRuntimeResources = nil
	previous, err := compileSeatbelt(plain, command)
	if err != nil || previous.digest == plan.digest {
		t.Fatal("resources absent from seal")
	}
	s.GitRuntimeResources = cloneGitRuntime(r)
	s.GitRuntimeResources.Files[0].Path = "/Library/Developer/private"
	if _, err := compileSeatbelt(s, command); err == nil {
		t.Fatal("arbitrary resource compiled")
	}
}

type gitRuntimeFactsDouble struct {
	*platformFactsDouble
	data map[string]platformFileFacts
	dirs map[string]gitRuntimeDirectoryFacts
}

func (f *gitRuntimeFactsDouble) gitRuntimeFile(_ context.Context, p string) (platformFileFacts, error) {
	return f.data[p], f.err
}
func (f *gitRuntimeFactsDouble) gitRuntimeDirectory(_ context.Context, p string) (gitRuntimeDirectoryFacts, error) {
	return f.dirs[p], f.err
}
func gitRuntimePlatformFixture(t *testing.T) (platformFixture, *gitRuntimeFactsDouble) {
	f := platformFixtureCPU(t)
	r := gitRuntimeFixture()
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	f.descriptor.GitRuntimeResources = r
	f.descriptor.Executables = append(f.descriptor.Executables, r.Git)
	f.facts.files[r.Git.Path] = platformFileFacts{identity: authority.RootIdentity{Device: "1", Inode: "git"}, path: r.Git.Path, sha256: r.Git.SHA256, size: 4096, mode: 0755, uid: 0, links: 1}
	actual := &gitRuntimeFactsDouble{platformFactsDouble: f.facts, data: map[string]platformFileFacts{}, dirs: map[string]gitRuntimeDirectoryFacts{}}
	for _, pin := range r.Files {
		actual.data[pin.Path] = platformFileFacts{identity: authority.RootIdentity{Device: "1", Inode: pin.Path}, path: pin.Path, sha256: pin.SHA256, size: 64, mode: 0644, uid: 0, links: 1}
	}
	actual.dirs[gitRuntimeTemplates] = gitRuntimeDirectoryFacts{platform: platformDirectoryFacts{path: gitRuntimeTemplates, filesystem: "apfs", mount: "/", identity: authority.RootIdentity{Device: "1", Inode: "templates"}, local: true}, mode: os.ModeDir | 0755, uid: 0, entries: "description"}
	return f, actual
}
func TestGitRuntimeStrategyRechecksDataAndDirectoryContinuity(t *testing.T) {
	for _, mode := range []string{"hash", "identity", "owner", "writable", "symlink", "links", "size", "directory-owner", "directory-listing", "directory-identity", "directory-mount", "directory-time"} {
		t.Run(mode, func(t *testing.T) {
			f, actual := gitRuntimePlatformFixture(t)
			strategy, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, actual)
			if err != nil {
				t.Fatal(err)
			}
			key := gitRuntimeData + "/gitconfig"
			data := actual.data[key]
			dir := actual.dirs[gitRuntimeTemplates]
			switch mode {
			case "hash":
				data.sha256 = strings.Repeat("e", 64)
			case "identity":
				data.identity.Inode = "replacement"
			case "owner":
				data.uid = 501
			case "writable":
				data.mode = 0664
			case "symlink":
				data.mode |= os.ModeSymlink
			case "links":
				data.links = 2
			case "size":
				data.size = 256*1024 + 1
			case "directory-owner":
				dir.uid = 501
			case "directory-listing":
				dir.entries += "\nprivate"
			case "directory-identity":
				dir.platform.identity.Inode = "replacement"
			case "directory-mount":
				dir.platform.mount = "/Volumes/foreign"
			case "directory-time":
				dir.changed = "changed"
			}
			actual.data[key], actual.dirs[gitRuntimeTemplates] = data, dir
			if strategy.inspect(context.Background()) == nil {
				t.Fatal("changed resource accepted")
			}
		})
	}
}
func TestGitRuntimeEmptyDataAndFrozenInput(t *testing.T) {
	f, actual := gitRuntimePlatformFixture(t)
	key := gitRuntimeData + "/gitconfig"
	data := actual.data[key]
	data.size = 0
	actual.data[key] = data
	strategy, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, actual)
	if err != nil {
		t.Fatal(err)
	}
	f.descriptor.GitRuntimeResources.Files[0].Path = "/foreign"
	f.descriptor.GitRuntimeResources.Directories[0].Entries[0] = "foreign"
	if err := strategy.inspect(context.Background()); err != nil {
		t.Fatal("input changed frozen support", err)
	}
}

func TestGitRuntimeDeclaredProfileFitsNativeCommandLimit(t *testing.T) {
	raw, err := os.ReadFile("../../../../tests/fixtures/shell-platform-clt-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		GitRuntimeResources *GitRuntimeResources
		Executables         []ExecutablePin
	}
	if err := json.Unmarshal(raw, &declaration); err != nil || declaration.GitRuntimeResources == nil {
		t.Fatal("missing declared resources", err)
	}
	s, command := rootScopedFixture(t)
	s.GitRuntimeResources = declaration.GitRuntimeResources
	s.Executables = append(s.Executables, declaration.Executables...)
	command.Environment = seatbeltEnvironment(s, command.Write)
	policy, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := policy.bind(command)
	if err != nil {
		t.Fatal("declared profile exceeds or fails native command contract", err)
	}
	if _, err := selectedLaunch(policy, bound); err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	for _, ancestor := range []string{gitRuntimeData, gitRuntimeTemplates} {
		if !hasParameterRule(plan, "deny file-write-unlink (require-all", "literal", ancestor) {
			// Unlink rules wrap the literal in require-all, so inspect each exact
			// parameter independently rather than asserting a broad text match.
			found := false
			for i := 0; i+1 < len(plan.arguments) && plan.arguments[i] == "-D"; i += 2 {
				key, value, ok := strings.Cut(plan.arguments[i+1], "=")
				if ok && value == ancestor && strings.Contains(plan.source, "(deny file-write-unlink (require-all (literal (param \""+key+"\")) (vnode-type DIRECTORY)))") {
					found = true
				}
			}
			if !found {
				t.Fatal("resource ancestor can be removed", ancestor)
			}
		}
	}
}

type gitDataMeasurementDouble struct{ *measurementFilesystemDouble }

func (f *gitDataMeasurementDouble) pinGitRuntimeFile(ctx context.Context, pin ExecutablePin) (executableMeasurement, error) {
	return f.pinExecutable(ctx, pin)
}
func TestGitRuntimeRetainedDescriptorsConsumeOnResourceDrift(t *testing.T) {
	for _, drift := range []string{"none", "file", "directory-owner", "directory-mode", "directory-identity", "directory-alias", "partial-data", "missing-reader"} {
		t.Run(drift, func(t *testing.T) {
			_, command, launch, fs := rootMeasurementFixture(t)
			launch.gitRuntimeResources = gitRuntimeFixture()
			fs.directories[gitRuntimeTemplates] = directoryFacts{identity: authority.RootIdentity{Device: "1", Inode: "templates"}, mode: os.ModeDir | 0755, uid: 0}
			var selected launchFilesystem = &gitDataMeasurementDouble{fs}
			if drift == "partial-data" {
				fs.executableError = launch.gitRuntimeResources.Files[1].Path
			}
			if drift == "missing-reader" {
				selected = fs
			}
			m, err := retainLaunchFiles(context.Background(), command, launch, selected)
			if drift == "partial-data" || drift == "missing-reader" {
				if err == nil || m != nil {
					t.Fatal("missing/partial data reader accepted")
				}
				fs.assertCloses(t, 1)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			opens := len(fs.handles)
			if err := m.Recheck(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(fs.handles) != opens {
				t.Fatal("data descriptors reopened")
			}
			facts := fs.directories[gitRuntimeTemplates]
			switch drift {
			case "file":
				fs.images[len(launch.pins)].fail = true
			case "directory-owner":
				facts.uid = 501
			case "directory-mode":
				facts.mode = os.ModeDir | 0775
			case "directory-identity":
				facts.identity.Inode = "replacement"
			case "directory-alias":
				fs.alias = gitRuntimeTemplates
			}
			fs.directories[gitRuntimeTemplates] = facts
			err = m.Recheck(context.Background())
			if drift == "none" {
				if err != nil {
					t.Fatal(err)
				}
				m.Close()
				m.Close()
			} else {
				if err == nil {
					t.Fatal("resource drift accepted")
				}
				if m.Recheck(context.Background()) == nil {
					t.Fatal("consumed measurement revived")
				}
			}
			if len(fs.handles) != opens {
				t.Fatal("resource drift reopened handles")
			}
			fs.assertCloses(t, 1)
		})
	}
}

// Literal declaration fixtures only; packaged native preparation is separate.
func TestGitRuntimePackagedProfileReusesPathParameters(t *testing.T) {
	raw, err := os.ReadFile("../../../../tests/fixtures/shell-platform-clt-legacy.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		GitRuntimeResources *GitRuntimeResources
		Executables         []ExecutablePin
	}
	if err := json.Unmarshal(raw, &declaration); err != nil || declaration.GitRuntimeResources == nil {
		t.Fatal("missing declared resources", err)
	}
	s, command := rootScopedFixture(t)
	s.GitRuntimeResources = declaration.GitRuntimeResources
	s.Executables = append(s.Executables, declaration.Executables...)
	const bundle = "/Users/fixture/.codex/worktrees/qualified-computer/farol/_output/package/Farol.app"
	s.ProtectedBundle = &ProtectedBundle{Path: bundle, Identity: authority.RootIdentity{Device: "1", Inode: "55"}}
	s.ProtectedImages = []ExecutablePin{
		{Path: bundle + "/Contents/Resources/app/farol-backend", SHA256: strings.Repeat("d", 64)},
		{Path: bundle + "/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron", SHA256: strings.Repeat("e", 64)},
	}
	s.RootVolumeOnly = true
	command.Executable = "/bin/bash"
	for _, pin := range s.Executables {
		if pin.Path == command.Executable {
			command.ExecutableSHA256 = pin.SHA256
		}
	}
	command.Args = []string{"--noprofile", "--norc", "-c", "builtin printf fixture"}
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]bool{}
	for i := 0; i+1 < len(plan.arguments) && plan.arguments[i] == "-D"; i += 2 {
		_, value, ok := strings.Cut(plan.arguments[i+1], "=")
		if !ok || values[value] {
			t.Fatal("duplicate or malformed path parameter", value)
		}
		values[value] = true
	}
	policy, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := policy.bind(command)
	if err != nil {
		t.Fatal("packaged profile does not fit unchanged native command limit", err)
	}
	if _, err := selectedLaunch(policy, bound); err != nil {
		t.Fatal(err)
	}
	for _, file := range s.GitRuntimeResources.Files {
		for _, rule := range []string{"allow file-read*", "deny file-write*", "deny process-exec"} {
			if !hasParameterRule(plan, rule, "literal", file.Path) {
				t.Fatal("lost data rule", rule, file.Path)
			}
		}
	}
	if !hasParameterRule(plan, "deny file-write*", "subpath", bundle) ||
		!hasParameterRule(plan, "allow process-exec", "literal", command.Executable) ||
		!hasParameterRule(plan, "deny file-write*", "literal", command.Executable) {
		t.Fatal("lost bundle or executable protection")
	}
}
