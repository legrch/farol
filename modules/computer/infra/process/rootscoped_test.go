package process

import (
	"slices"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Policy/compiler tests only. No command, Seatbelt, native qualification,
// permission UI, live provider or filesystem object is exercised here.
func rootScopedFixture(t *testing.T) (SeatbeltSelection, Command) {
	t.Helper()
	_, selection, command, _ := confinementFixture(t)
	selection.FilePolicy = authority.RootScopedFiles
	selection.Snapshot.Participant.Grant.FilePolicy = authority.RootScopedFiles
	selection.Snapshot.Approval.FilePolicy = authority.RootScopedFiles
	selection.Git = RootScopedGit
	command.Environment = seatbeltEnvironment(selection, command.Write)
	return selection, command
}

func addRootScope(s *SeatbeltSelection, id, root string, access authority.Access) {
	s.Snapshot.Participant.Grant.Workspaces = append(s.Snapshot.Participant.Grant.Workspaces,
		authority.Scope{WorkspaceID: id, Root: root, Mode: authority.Subtree, Access: access})
	s.Snapshot.Approval.Workspaces = append(s.Snapshot.Approval.Workspaces,
		authority.ApprovedWorkspace{WorkspaceID: id, Root: root, Access: access, ShellVerified: true,
			RootIdentity: authority.RootIdentity{Device: "1", Inode: "29"}})
}

func TestRootScopedSeatbeltHasNoImplicitCredentialOrGitNames(t *testing.T) {
	s, command := rootScopedFixture(t)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{".env", ".ssh", ".aws", "Keychains", "credential", "[.]git"} {
		if strings.Contains(plan.source, forbidden) {
			t.Fatalf("implicit name policy retained: %s", forbidden)
		}
		for _, arg := range plan.arguments {
			if strings.Contains(arg, forbidden) {
				t.Fatalf("implicit name argument retained: %s", forbidden)
			}
		}
	}
	if !hasParameterRule(plan, "allow file-read*", "subpath", "/approved/work/project") ||
		!hasParameterRule(plan, "allow process-exec", "subpath", "/approved/work/project") ||
		!strings.Contains(plan.source, "(deny network*)") || !strings.Contains(plan.source, "file-write-unlink") {
		t.Fatal("missing actual root/network/kernel-boundary policy")
	}
	if hasParameterRule(plan, "allow file-read*", "subpath", s.Home) ||
		hasParameterRule(plan, "allow file-write*", "subpath", command.Root) {
		t.Fatal("HOME environment or parent path granted ambient authority")
	}
	for _, value := range []string{"HOME=" + s.Home, "LANG=C", "LC_ALL=C"} {
		if !slices.Contains(command.Environment, value) {
			t.Fatalf("missing explicit environment %q", value)
		}
	}
	for _, value := range command.Environment {
		if strings.HasPrefix(value, "GIT_CONFIG_") || strings.HasPrefix(value, "NODE_OPTIONS=") || strings.HasPrefix(value, "DYLD_") {
			t.Fatalf("hidden Git override or ambient loader option: %q", value)
		}
	}
}

func TestRootScopedSeatbeltAllowsOnlyRuntimeSizingAndUnameSysctls(t *testing.T) {
	s, command := rootScopedFixture(t)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	const sizing = `(allow sysctl-read (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.ncpu"))`
	if !strings.Contains(plan.source, sizing) || strings.Count(plan.source, "(allow sysctl-read ") != 2 ||
		strings.Count(plan.source, "(sysctl-name ") != 7 || strings.Contains(plan.source, "sysctl-write") {
		t.Fatal("runtime sizing/uname reads missing or broader sysctl permission emitted")
	}
	for _, name := range []string{"kern.ostype", "kern.hostname", "kern.osrelease", "kern.version", "hw.machine"} {
		if strings.Count(plan.source, `(sysctl-name "`+name+`")`) != 1 {
			t.Fatal("missing exact uname read", name)
		}
	}
	_, legacy, legacyCommand, _ := confinementFixture(t)
	old, err := compileSeatbelt(legacy, legacyCommand)
	if err != nil || strings.Contains(old.source, "sysctl") {
		t.Fatal("root-scoped runtime policy changed the retained legacy profile", err)
	}
}

func TestRootScopedSeatbeltHonorsExplicitWholeHomeRatherThanFilenameHeuristics(t *testing.T) {
	for _, root := range []string{"/owner/home", "/owner/home/.ssh", "/approved/work/.env.private"} {
		t.Run(root, func(t *testing.T) {
			s, c := rootScopedFixture(t)
			s.Snapshot.Approval.Workspaces[0].Root = root
			s.Snapshot.Participant.Grant.Workspaces[0].Root = root
			c.Root, c.Cwd = root, root
			plan, err := compileSeatbelt(s, c)
			if err != nil || !hasParameterRule(plan, "allow file-read*", "subpath", root) {
				t.Fatal("approved root replaced by implicit filename classification", err)
			}
		})
	}
}

func TestRootScopedSeatbeltUsesOnlyCurrentGrantedAdditionalRoots(t *testing.T) {
	s, c := rootScopedFixture(t)
	addRootScope(&s, "git-common", "/approved/common.git", authority.WriteAccess)
	addRootScope(&s, "toolchain", "/opt/approved-toolchain", authority.ReadAccess)
	c.Write = true
	c.Environment = seatbeltEnvironment(s, true)
	plan, err := compileSeatbelt(s, c)
	if err != nil {
		t.Fatal(err)
	}
	if !hasParameterRule(plan, "allow file-write*", "subpath", "/approved/common.git") ||
		!hasParameterRule(plan, "allow process-exec", "subpath", "/opt/approved-toolchain") ||
		hasParameterRule(plan, "allow file-write*", "subpath", "/opt/approved-toolchain") {
		t.Fatal("additional roots widened, omitted, or lost access distinction")
	}
	c.Write = false
	c.Environment = seatbeltEnvironment(s, false)
	readOnly, err := compileSeatbelt(s, c)
	if err != nil || hasParameterRule(readOnly, "allow file-write*", "subpath", "/approved/common.git") {
		t.Fatal("read-only invocation retained secondary write access", err)
	}
	// A discovered .git path does not grant access; it is not read by this mode.
	s.Snapshot.Approval.Workspaces[0].GitMetadata = &authority.GitMetadata{GitDirectory: "/unapproved/git", CommonDirectory: "/unapproved/common"}
	withoutImplicitGit, err := compileSeatbelt(s, c)
	if err != nil || withoutImplicitGit.digest != readOnly.digest {
		t.Fatal("Git discovery manufactured access or changed the selected profile", err)
	}
}

func TestRootScopedSeatbeltRequiresBothNetworkApprovalsAndCapability(t *testing.T) {
	s, c := rootScopedFixture(t)
	s.Network = authority.ApprovedNetwork
	if _, err := compileSeatbelt(s, c); err == nil {
		t.Fatal("request alone granted network")
	}
	s.Snapshot.Participant.Grant.Network = authority.ApprovedNetwork
	s.Snapshot.Participant.Grant.Capabilities = append(s.Snapshot.Participant.Grant.Capabilities, authority.NetworkUse)
	if _, err := compileSeatbelt(s, c); err == nil {
		t.Fatal("task widened owner network scope")
	}
	s.Snapshot.Approval.Network = authority.ApprovedNetwork
	s.Snapshot.Approval.Capabilities = append(s.Snapshot.Approval.Capabilities, authority.NetworkUse)
	plan, err := compileSeatbelt(s, c)
	if err != nil || !strings.Contains(plan.source, "(allow network*)") || strings.Contains(plan.source, "(deny network*)") {
		t.Fatal("joint explicit network selection missing", err)
	}
	s.Snapshot.Approval.Capabilities = []authority.Capability{authority.Shell}
	if _, err := compileSeatbelt(s, c); err == nil {
		t.Fatal("network without current owner capability")
	}
}

func TestRootScopedSeatbeltRefusesOldRestrictionsAndMalformedAuthority(t *testing.T) {
	cases := map[string]func(*SeatbeltSelection, *Command){
		"unknown-file-policy":  func(s *SeatbeltSelection, _ *Command) { s.FilePolicy = "all-access" },
		"legacy-git-selection": func(s *SeatbeltSelection, _ *Command) { s.Git = WorkspaceGit },
		"owner-exclusion": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project/private"}}
		},
		"task-exclusion": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Participant.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project/private"}}
		},
		"cross-workspace-exclusion": func(s *SeatbeltSelection, _ *Command) {
			addRootScope(s, "home", "/owner/home", authority.WriteAccess)
			s.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "other", Path: "/owner/home/private"}}
		},
		"extra-unapproved-root": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Participant.Grant.Workspaces = append(s.Snapshot.Participant.Grant.Workspaces, authority.Scope{WorkspaceID: "foreign", Root: "/foreign", Mode: authority.Subtree, Access: authority.WriteAccess})
		},
		"duplicate-task-root": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Participant.Grant.Workspaces = append(s.Snapshot.Participant.Grant.Workspaces, s.Snapshot.Participant.Grant.Workspaces[0])
		},
		"duplicate-owner-root": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Approval.Workspaces = append(s.Snapshot.Approval.Workspaces, s.Snapshot.Approval.Workspaces[0])
		},
		"unverified-secondary-root": func(s *SeatbeltSelection, _ *Command) {
			addRootScope(s, "secondary", "/secondary", authority.WriteAccess)
			s.Snapshot.Approval.Workspaces[1].ShellVerified = false
		},
		"secondary-scope-escape": func(s *SeatbeltSelection, _ *Command) {
			addRootScope(s, "secondary", "/secondary", authority.WriteAccess)
			s.Snapshot.Participant.Grant.Workspaces[1].Root = "/"
		},
		"secondary-exact-files": func(s *SeatbeltSelection, _ *Command) {
			addRootScope(s, "secondary", "/secondary", authority.WriteAccess)
			s.Snapshot.Participant.Grant.Workspaces[1].Mode = authority.Exact
		},
		"secondary-missing-identity": func(s *SeatbeltSelection, _ *Command) {
			addRootScope(s, "secondary", "/secondary", authority.WriteAccess)
			s.Snapshot.Approval.Workspaces[1].RootIdentity.Inode = ""
		},
		"readonly-owner": func(s *SeatbeltSelection, c *Command) {
			c.Write = true
			c.Environment = seatbeltEnvironment(*s, true)
			s.Snapshot.Approval.Workspaces[0].Access = authority.ReadAccess
		},
		"no-command-capability": func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Participant.Grant.Capabilities = nil },
		"generation-change":     func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Generation++ },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, c := rootScopedFixture(t)
			change(&s, &c)
			if _, err := compileSeatbelt(s, c); err == nil {
				t.Fatal("invalid or widened authority accepted")
			}
		})
	}
}

func TestRootScopedSeatbeltModeIsSealedAndDoesNotMutateExistingGrants(t *testing.T) {
	s, c := rootScopedFixture(t)
	evidence := &confinementEvidenceDouble{}
	selected, err := NewSeatbelt(s, evidence)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(selected.selection, c)
	if err != nil {
		t.Fatal(err)
	}
	s.Snapshot.Participant.Grant.Workspaces[0].Root = "/wider"
	again, err := compileSeatbelt(selected.selection, c)
	if err != nil || again.digest != plan.digest || evidence.calls != 0 {
		t.Fatal("constructor retained mutable grant or invoked native evidence", err)
	}
	legacy := selected.selection
	legacy.FilePolicy, legacy.Git = authority.LegacyProtectedFiles, DenyGit
	p := legacy.Snapshot.Participant.Clone()
	a := legacy.Snapshot.Approval.Clone()
	p.Grant.FilePolicy, a.FilePolicy = authority.LegacyProtectedFiles, authority.LegacyProtectedFiles
	legacy.Snapshot.Participant, legacy.Snapshot.Approval = &p, &a
	c.Environment = seatbeltEnvironment(legacy, false)
	legacyPlan, err := compileSeatbelt(legacy, c)
	if err != nil || legacyPlan.digest == plan.digest {
		t.Fatal("distinct policy did not change reservation seal", err)
	}
}

func TestRootScopedSeatbeltRequiresCapturedOwnerFilePolicy(t *testing.T) {
	for _, mismatch := range []string{"owner", "task", "selection"} {
		s, c := rootScopedFixture(t)
		switch mismatch {
		case "owner":
			s.Snapshot.Approval.FilePolicy = authority.LegacyProtectedFiles
		case "task":
			s.Snapshot.Participant.Grant.FilePolicy = authority.LegacyProtectedFiles
		case "selection":
			s.FilePolicy, s.Git = authority.LegacyProtectedFiles, DenyGit
			c.Environment = seatbeltEnvironment(s, c.Write)
		}
		if _, err := compileSeatbelt(s, c); err == nil {
			t.Fatal("compiler reinterpreted captured authority", mismatch)
		}
	}
}

func TestRootScopedGitSystemConfigChecksGrantNoContents(t *testing.T) {
	s, command := rootScopedFixture(t)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	const metadata = `(allow file-read-metadata file-test-existence (literal "/etc") (literal "/private/etc") (literal "/etc/gitconfig") (literal "/private/etc/gitconfig"))`
	if !strings.Contains(plan.source, metadata) {
		t.Fatal("optional system config cannot be inspected for absence")
	}
	for _, line := range strings.Split(plan.source, "\n") {
		if strings.Contains(line, "/etc") && line != metadata {
			t.Fatal("system config received another filesystem grant", line)
		}
	}
	// The compatibility profile continues to suppress global/system config; it
	// cannot silently acquire even the new metadata/existence exception.
	_, legacy, legacyCommand, _ := confinementFixture(t)
	old, err := compileSeatbelt(legacy, legacyCommand)
	if err != nil || strings.Contains(old.source, "gitconfig") {
		t.Fatal("legacy policy changed", err)
	}
}
