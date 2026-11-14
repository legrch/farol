package process

import (
	"context"
	"errors"
	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// These tests inspect policy values, sealed launch construction and a labelled
// native-evidence double. They NEVER invoke nativeBoundary, file measurements,
// os/exec, sandbox-exec, a signal, endpoint, real CLI or provider. A generated
// profile and a nil-returning double are not effective native qualification.
type confinementEvidenceDouble struct {
	calls   int
	command Command
	err     error
}

func (d *confinementEvidenceDouble) Qualify(_ context.Context, command Command) error {
	d.calls++
	d.command = copyCommand(command)
	return d.err
}

func confinementFixture(t *testing.T) (*Seatbelt, SeatbeltSelection, Command, *confinementEvidenceDouble) {
	t.Helper()
	p, _, _, _ := fixture(t)
	command := copyCommand(p.command)
	command.Root, command.Cwd = "/approved/work", "/approved/work/project"
	command.WorkspaceID = "work"
	command.Executable = "/selected/command"
	command.Binding = &InvocationBinding{RuntimeID: "cli", SessionID: "session", ModelID: "model", AdmissionID: "authority"}
	participant := authority.Participant{ParticipantID: "participant", Role: authority.Agent, MutationOwnership: authority.TaskOwnership,
		Grant: authority.Grant{Identity: authority.Identity{OwnerID: "owner"}, ComputerID: "computer", ComputerGeneration: 17, AuthorityID: "authority",
			Policy: authority.Policy{Workspaces: []authority.Scope{{WorkspaceID: "work", Root: "/approved/work/project", Mode: authority.Subtree, Access: authority.WriteAccess}}, Capabilities: []authority.Capability{authority.Shell}, Commands: authority.WorkspaceCommands}}}
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 17, Commands: authority.WorkspaceCommands, Capabilities: []authority.Capability{authority.Shell},
		Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: command.Root, RootIdentity: command.RootIdentity, Access: authority.WriteAccess, ShellVerified: true}}}
	selection := SeatbeltSelection{Snapshot: port.AccessSnapshot{Participant: &participant, Approval: &approval}, RuntimeID: "cli", WorkspaceID: "work", Home: "/owner/home", Scratch: "/private/tmp/farol-fixture-operation",
		ScratchIdentity: authority.RootIdentity{Device: "1", Inode: "9"}, MechanismSHA256: strings.Repeat("b", 64), Executables: []ExecutablePin{{command.Executable, command.ExecutableSHA256}}, Network: authority.NoNetwork, Git: DenyGit}
	evidence := &confinementEvidenceDouble{}
	selected, err := NewSeatbelt(selection, evidence)
	if err != nil {
		t.Fatal(err)
	}
	command.Environment = selected.Environment(command.Write)
	return selected, selection, command, evidence
}

// Independently read the emitted profile's parameter/rule association. This is
// limited source conformance; native SBPL parsing/enforcement is a separate gate.
func hasParameterRule(plan *seatbeltPlan, operation, selector, path string) bool {
	for i := 0; i+1 < len(plan.arguments) && plan.arguments[i] == "-D"; i += 2 {
		key, value, _ := strings.Cut(plan.arguments[i+1], "=")
		if value != path {
			continue
		}
		expression := regexp.MustCompile(`(?m)\(` + regexp.QuoteMeta(operation) + ` [^\n]*\(` + regexp.QuoteMeta(selector) + ` \(param "` + regexp.QuoteMeta(key) + `"\)\)`)
		if expression.MatchString(plan.source) {
			return true
		}
	}
	return false
}

func TestSeatbeltProducesRestrictiveSelectedPolicy(t *testing.T) {
	selected, selection, command, evidence := confinementFixture(t)
	selection.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project/private"}}
	selection.Snapshot.Participant.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project/internal"}}
	selected, err := NewSeatbelt(selection, evidence)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(selected.selection, command)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"(deny default)", "(deny network*)", "(allow process-fork)", `(deny file-read* file-write* (regex #"/[.]git(/|$)"))`} {
		if !strings.Contains(plan.source, text) {
			t.Fatalf("missing protection %s", text)
		}
	}
	for _, text := range []string{"(allow network", "(allow process-exec)", "(allow file-read-metadata)", "/opt/homebrew/Cellar", "/private/etc"} {
		if strings.Contains(plan.source, text) {
			t.Fatalf("ambient authority %s", text)
		}
	}
	for _, expected := range []struct{ op, kind, path string }{
		{"allow file-read*", "subpath", "/approved/work/project"},
		{"allow file-write*", "subpath", selection.Scratch},
		{"allow process-exec", "literal", command.Executable},
		{"deny file-write*", "literal", command.Executable},
		{"deny file-read* file-write*", "subpath", "/approved/work/project/private"},
		{"deny file-read* file-write*", "subpath", "/approved/work/project/internal"},
		{"deny file-read* file-write*", "subpath", "/owner/home/.ssh"},
		{"deny file-read* file-write*", "subpath", "/owner/home/Library/Keychains"},
	} {
		if !hasParameterRule(plan, expected.op, expected.kind, expected.path) {
			t.Fatalf("missing exact rule %+v", expected)
		}
	}
	if hasParameterRule(plan, "allow file-read*", "subpath", command.Root) || hasParameterRule(plan, "allow file-write*", "subpath", "/approved/work/project") || evidence.calls != 0 {
		t.Fatal("parent/root write widening or construction native evidence call")
	}
	command.Write = true
	command.Environment = selected.Environment(true)
	writable, err := compileSeatbelt(selected.selection, command)
	if err != nil || !hasParameterRule(writable, "allow file-write*", "subpath", "/approved/work/project") || writable.digest == plan.digest {
		t.Fatal("write not separately bound", err)
	}
}

func TestSeatbeltRefusesUnqualifiedPolicyBeforeNativeEvidence(t *testing.T) {
	cases := map[string]func(*SeatbeltSelection, *Command){
		"network-allow":   func(s *SeatbeltSelection, _ *Command) { s.Network = authority.ApprovedNetwork },
		"unknown-network": func(s *SeatbeltSelection, _ *Command) { s.Network = "unknown" },
		"unknown-git":     func(s *SeatbeltSelection, _ *Command) { s.Git = "unknown" },
		"external-git": func(s *SeatbeltSelection, _ *Command) {
			s.Git = WorkspaceGit
			w := &s.Snapshot.Approval.Workspaces[0]
			w.GitHistoryApproved = true
			w.GitMetadata = &authority.GitMetadata{GitDirectory: "/other/git", CommonDirectory: "/other/common"}
		},
		"git-not-approved": func(s *SeatbeltSelection, _ *Command) { s.Git = WorkspaceGit },
		"git-layout-missing": func(s *SeatbeltSelection, _ *Command) {
			s.Git = WorkspaceGit
			s.Snapshot.Approval.Workspaces[0].GitHistoryApproved = true
		},
		"runtime-rebind":       func(_ *SeatbeltSelection, c *Command) { c.Binding.RuntimeID = "other" },
		"executable-rebind":    func(_ *SeatbeltSelection, c *Command) { c.Executable = "/selected/other" },
		"executable-hash":      func(_ *SeatbeltSelection, c *Command) { c.ExecutableSHA256 = strings.Repeat("c", 64) },
		"generation":           func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Generation++ },
		"shell-verification":   func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Workspaces[0].ShellVerified = false },
		"commands":             func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Participant.Grant.Commands = authority.NoCommands },
		"capability":           func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Capabilities = nil },
		"invalid-scope-access": func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Participant.Grant.Workspaces[0].Access = "unknown" },
		"exact-scope": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Participant.Grant.Workspaces[0].Mode = authority.Exact
		},
		"outside-scope": func(_ *SeatbeltSelection, c *Command) { c.Cwd = "/approved/work/sibling" },
		"write-denied": func(s *SeatbeltSelection, c *Command) {
			c.Write = true
			s.Snapshot.Participant.Grant.Workspaces[0].Access = authority.ReadAccess
		},
		"ownership": func(s *SeatbeltSelection, c *Command) {
			c.Write = true
			s.Snapshot.Participant.MutationOwnership = authority.NoOwnership
		},
		"root-identity": func(_ *SeatbeltSelection, c *Command) { c.RootIdentity.Inode = "foreign" },
		"credential-root": func(s *SeatbeltSelection, c *Command) {
			c.Root, c.Cwd = "/owner/home/.SSH", "/owner/home/.SSH"
			s.Snapshot.Approval.Workspaces[0].Root = c.Root
			s.Snapshot.Participant.Grant.Workspaces[0].Root = c.Root
		},
		"credential-alias": func(_ *SeatbeltSelection, c *Command) { c.Cwd = "/approved/work/project/.SſH" },
		"credential-env":   func(_ *SeatbeltSelection, c *Command) { c.Environment = append(c.Environment, "API_KEY=synthetic") },
		"node-injection": func(_ *SeatbeltSelection, c *Command) {
			c.Environment = append(c.Environment, "NODE_OPTIONS=synthetic")
		},
		"owner-home-env":   func(_ *SeatbeltSelection, c *Command) { c.Environment[0] = "HOME=/owner/home" },
		"git-config-env":   func(_ *SeatbeltSelection, c *Command) { c.Environment = append(c.Environment, "GIT_CONFIG_COUNT=1") },
		"unowned-scratch":  func(s *SeatbeltSelection, _ *Command) { s.Scratch = "/owner/home" },
		"scratch-identity": func(s *SeatbeltSelection, _ *Command) { s.ScratchIdentity.Inode = "" },
		"exclusion-cwd": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project"}}
		},
		"foreign-exclusion": func(s *SeatbeltSelection, _ *Command) {
			s.Snapshot.Participant.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/outside"}}
		},
		"profile-newline": func(s *SeatbeltSelection, _ *Command) { s.Home += "\n(allow default)" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			_, selection, command, evidence := confinementFixture(t)
			change(&selection, &command)
			selected, err := NewSeatbelt(selection, evidence)
			if err == nil {
				_, err = selected.bind(command)
			}
			var failure *processsvc.NativeFailure
			if !errors.As(err, &failure) || failure.Unknown || evidence.calls != 0 {
				t.Fatal("unqualified policy reached native evidence or was accepted", err)
			}
		})
	}
}

func TestSeatbeltSealsPolicyAndMapsOnlySandboxedLaunch(t *testing.T) {
	selected, selection, command, evidence := confinementFixture(t)
	_, _, clock, _ := fixture(t)
	prepared, err := New(command, selected, clock)
	if err != nil {
		t.Fatal(err)
	}
	launch, err := selectedLaunch(selected, prepared.command)
	if err != nil {
		t.Fatal(err)
	}
	if launch.command.Executable != seatbeltExecutable || launch.command.ExecutableSHA256 != selection.MechanismSHA256 ||
		!slices.Equal(launch.command.Args[len(launch.command.Args)-len(command.Args):], command.Args) ||
		launch.command.Args[len(launch.command.Args)-len(command.Args)-1] != command.Executable ||
		!reflect.DeepEqual(launch.command.Input, command.Input) || !slices.Equal(launch.command.Environment, command.Environment) || evidence.calls != 0 {
		t.Fatal("selected input remapped or early qualification")
	}
	if err := selected.Qualify(context.Background(), prepared.command); err != nil || evidence.calls != 1 || evidence.command.Executable != seatbeltExecutable {
		t.Fatal("native evidence did not receive exact confined command", err)
	}
	evidence.err = errors.New("unqualified native mechanism")
	if err := selected.Qualify(context.Background(), prepared.command); err == nil || evidence.calls != 2 {
		t.Fatal("native evidence refusal bypassed")
	}
	// Bare qualification cannot authorize the old direct executable route.
	bare := &confinementEvidenceDouble{}
	if _, err := selectedLaunch(bare, prepared.command); err == nil || bare.calls != 0 {
		t.Fatal("bare Qualify became an executor")
	}
	legacy := copyCommand(prepared.command)
	legacy.Binding = nil
	if _, err := selectedLaunch(selected, legacy); err == nil {
		t.Fatal("unbound runtime reached native launch")
	}
	modified := copyCommand(prepared.command)
	modified.Confinement.ProfileSHA256 = strings.Repeat("c", 64)
	if _, err := selectedLaunch(selected, modified); err == nil {
		t.Fatal("foreign profile seal accepted")
	}
	// A different restrictive policy cannot replace the one already reserved.
	selection.ScratchIdentity.Inode = "other"
	other, err := NewSeatbelt(selection, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := selectedLaunch(other, prepared.command); err == nil {
		t.Fatal("policy replaced after seal")
	}
	otherPrepared, err := New(command, other, clock)
	if err != nil || otherPrepared.Seal().Digest == prepared.Seal().Digest {
		t.Fatal("reservation digest did not bind policy", err)
	}
}

func TestSeatbeltCopiesOwnerPolicyAndKeepsPathsOutOfProfileLanguage(t *testing.T) {
	_, selection, command, evidence := confinementFixture(t)
	weird := `/approved/work/project/quote" (allow default)`
	selection.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: weird}}
	selected, err := NewSeatbelt(selection, evidence)
	if err != nil {
		t.Fatal(err)
	}
	selection.Executables[0].Path = "/changed"
	selection.Snapshot.Participant.Grant.Workspaces[0].Root = "/changed"
	selection.Snapshot.Approval.ExcludedPaths[0].Path = "/changed"
	plan, err := compileSeatbelt(selected.selection, command)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.source, weird) || !hasParameterRule(plan, "deny file-read* file-write*", "subpath", weird) {
		t.Fatal("path escaped -D parameter boundary")
	}
	env := selected.Environment(false)
	env[0] = "HOME=/changed"
	if selected.Environment(false)[0] != "HOME=/private/tmp/farol-fixture-operation" {
		t.Fatal("environment alias")
	}
	for _, path := range []string{"/root/.SSH/config", "/root/.SſH/config", "/root/.env.private", "/owner/home/Library/Keychains/item"} {
		if !protectedPath(path, "/owner/home") {
			t.Fatalf("credential alias missed %s", path)
		}
	}
}

func TestSeatbeltWorkspaceGitRemainsInsideSelectedSubtree(t *testing.T) {
	_, selection, command, evidence := confinementFixture(t)
	selection.Git = WorkspaceGit
	w := &selection.Snapshot.Approval.Workspaces[0]
	w.GitHistoryApproved = true
	w.GitMetadata = &authority.GitMetadata{GitDirectory: "/approved/work/project/.git", CommonDirectory: "/approved/work/project/.git"}
	selected, err := NewSeatbelt(selection, evidence)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(selected.selection, command)
	if err != nil || strings.Contains(plan.source, `regex #"/[.]git(/|$)"`) {
		t.Fatal("local approved Git unavailable", err)
	}
	if !slices.Contains(command.Environment, "GIT_CONFIG_GLOBAL=/dev/null") || !slices.Contains(command.Environment, "GIT_TERMINAL_PROMPT=0") || evidence.calls != 0 {
		t.Fatal("external Git config/credential path enabled")
	}
}

func TestSeatbeltRequiresEvidenceAndBoundsWrappedArguments(t *testing.T) {
	selected, selection, command, evidence := confinementFixture(t)
	if _, err := NewSeatbelt(selection, nil); err == nil {
		t.Fatal("missing native evidence accepted")
	}
	if _, err := NewSeatbelt(selection, selected); err == nil {
		t.Fatal("recursive compiler claimed evidence")
	}
	bound, err := selected.bind(command)
	if err != nil {
		t.Fatal(err)
	}
	tooMany := copyCommand(bound)
	tooMany.Args = make([]string, 256)
	for i := range tooMany.Args {
		tooMany.Args[i] = "arg"
	}
	if _, err := selectedLaunch(selected, tooMany); err == nil || evidence.calls != 0 {
		t.Fatal("unbounded wrapped argv reached evidence")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := selected.Qualify(ctx, bound); err == nil || evidence.calls != 0 {
		t.Fatal("cancelled input inspected native evidence")
	}
}

func TestSeatbeltDigestSensitivityAndNoExternalSelectionAliases(t *testing.T) {
	selected, _, command, _ := confinementFixture(t)
	_, _, clock, _ := fixture(t)
	baseline, err := New(command, selected, clock)
	if err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*SeatbeltSelection){
		"mechanism":    func(s *SeatbeltSelection) { s.MechanismSHA256 = strings.Repeat("c", 64) },
		"home-denials": func(s *SeatbeltSelection) { s.Home = "/other/home" },
		"owner-exclusion": func(s *SeatbeltSelection) {
			s.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project/private"}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, selection, _, evidence := confinementFixture(t)
			change(&selection)
			next, err := NewSeatbelt(selection, evidence)
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := New(command, next, clock)
			if err != nil || prepared.Seal().Digest == baseline.Seal().Digest || evidence.calls != 0 {
				t.Fatal("policy changed outside reservation digest", err)
			}
			if _, err := selectedLaunch(next, baseline.command); err == nil {
				t.Fatal("reserved command rebound")
			}
		})
	}
	var nilSeatbelt *Seatbelt
	if _, err := New(command, nilSeatbelt, clock); err == nil {
		t.Fatal("typed-nil mechanism accepted")
	}
	copy := copyCommand(baseline.command)
	copy.Confinement.ProfileSHA256 = "changed"
	if baseline.command.Confinement.ProfileSHA256 == "changed" {
		t.Fatal("mutable confinement binding")
	}
}

func TestSeatbeltCurrentPolicyCannotUseForeignOrBroaderParticipant(t *testing.T) {
	selected, selection, command, evidence := confinementFixture(t)
	_, _, clock, _ := fixture(t)
	prepared, err := New(command, selected, clock)
	if err != nil {
		t.Fatal(err)
	}
	if !prepared.MatchesPolicy(selection.Snapshot) {
		t.Fatal("identical current policy refused")
	}
	for name, change := range map[string]func(*port.AccessSnapshot){
		"participant":     func(s *port.AccessSnapshot) { s.Participant.ParticipantID = "other" },
		"task":            func(s *port.AccessSnapshot) { s.Participant.Grant.TaskID = "other" },
		"admission":       func(s *port.AccessSnapshot) { s.Participant.Grant.AuthorityID = "other" },
		"generation":      func(s *port.AccessSnapshot) { s.Approval.Generation++ },
		"generation-both": func(s *port.AccessSnapshot) { s.Approval.Generation++; s.Participant.Grant.ComputerGeneration++ },
		"broader-grant":   func(s *port.AccessSnapshot) { s.Participant.Grant.Workspaces[0].Root = "/approved/work" },
		"new-exclusion-below-cwd": func(s *port.AccessSnapshot) {
			s.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/approved/work/project/private"}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			p, a := selection.Snapshot.Participant.Clone(), selection.Snapshot.Approval.Clone()
			snapshot := port.AccessSnapshot{Participant: &p, Approval: &a}
			change(&snapshot)
			if prepared.MatchesPolicy(snapshot) || evidence.calls != 0 {
				t.Fatal("stale/foreign broader profile accepted or native evidence under authority gate")
			}
		})
	}
	wrong := copyCommand(command)
	wrong.Binding.AdmissionID = "other"
	if _, err := selected.bind(wrong); err == nil {
		t.Fatal("foreign grant selected for native profile")
	}
}

// Pure trusted-snapshot construction only. No credential store is read and no
// native qualification, reservation, process or endpoint is invoked.
func TestSeatbeltRefusesHomeCoveringAndPrivateStoreScopesBeforeNative(t *testing.T) {
	for _, root := range []string{
		"/owner/home", "/owner", "/OWNER/HOME", "/owner/hóme",
		"/owner/home/Library", "/owner/home/Library/Keychains/child",
		"/owner/home/.config", "/owner/home/.config/gh",
		"/owner/home/.config/gh/hosts.yml", "/owner/home/.CONFIG/GH/HOSTS.YML/child",
	} {
		t.Run(root, func(t *testing.T) {
			_, selection, command, evidence := confinementFixture(t)
			selection.Snapshot.Approval.Workspaces[0].Root = root
			selection.Snapshot.Participant.Grant.Policy.Workspaces[0].Root = root
			command.Root, command.Cwd = root, root+"/project"
			selected, err := NewSeatbelt(selection, evidence)
			if err == nil {
				_, err = New(command, selected, &testClock{})
			}
			var failure *processsvc.NativeFailure
			if !errors.As(err, &failure) || failure.Unknown || evidence.calls != 0 {
				t.Fatal("private scope accepted or reached native boundary", err)
			}
		})
	}
}

func TestSeatbeltRetainsExactCodeSubtreeInsideHomeApproval(t *testing.T) {
	for _, sibling := range []bool{false, true} {
		_, selection, command, evidence := confinementFixture(t)
		home, approvalRoot := selection.Home, selection.Home
		if sibling {
			approvalRoot += "grown"
		}
		scope := approvalRoot + "/code/project"
		// The approval may be HOME while this captured grant is only code/project.
		// Rejecting the approval ancestor would erase the legitimate narrow grant.
		selection.Snapshot.Approval.Workspaces[0].Root = approvalRoot
		selection.Snapshot.Participant.Grant.Policy.Workspaces[0].Root = scope
		command.Root, command.Cwd = approvalRoot, scope
		selected, err := NewSeatbelt(selection, evidence)
		if err != nil {
			t.Fatal(err)
		}
		prepared, err := New(command, selected, &testClock{})
		if err != nil || prepared == nil || prepared.attempted || evidence.calls != 0 {
			t.Fatal("exact code subtree refused or executed", err)
		}
		plan, err := compileSeatbelt(selected.selection, command)
		if err != nil || !hasParameterRule(plan, "allow file-read*", "subpath", scope) || hasParameterRule(plan, "allow file-read*", "subpath", home) {
			t.Fatal("positive grant broadened to HOME", err)
		}
		if !hasParameterRule(plan, "deny file-read* file-write*", "subpath", home+"/.config/gh/hosts.yml") {
			t.Fatal("known private store denial omitted")
		}
	}
}

// Pure policy compilation of synthetic paths only; these cases never inspect an
// agent store or invoke native qualification, preparation, spawn or endpoints.
func TestSeatbeltAgentScopesFollowOrdinaryAccess(t *testing.T) {
	for _, directory := range []string{".codex", ".claude", ".Codex", ".CLAUDE"} {
		for _, shape := range []string{"direct", "descendant", "enclosing", "home-approval"} {
			t.Run(directory+"/"+shape, func(t *testing.T) {
				_, selection, command, evidence := confinementFixture(t)
				root := selection.Home + "/" + directory
				approvalRoot, scope, cwd := root, root, root
				switch shape {
				case "descendant":
					approvalRoot, scope, cwd = root, root+"/worktrees/task/repo", root+"/worktrees/task/repo"
				case "enclosing":
					approvalRoot, scope, cwd = "/approved/work", "/approved/work/project", "/approved/work/project/"+directory+"/sessions"
				case "home-approval":
					approvalRoot = selection.Home
				}
				selection.Snapshot.Approval.Workspaces[0].Root = approvalRoot
				selection.Snapshot.Participant.Grant.Workspaces[0].Root = scope
				command.Root, command.Cwd = approvalRoot, cwd
				for _, access := range []authority.Access{authority.ReadAccess, authority.WriteAccess} {
					selection.Snapshot.Approval.Workspaces[0].Access = access
					selection.Snapshot.Participant.Grant.Workspaces[0].Access = access
					for _, write := range []bool{false, true} {
						command.Write = write
						command.Environment = seatbeltEnvironment(selection, write)
						plan, err := compileSeatbelt(selection, command)
						if access == authority.ReadAccess && write {
							var failure *processsvc.NativeFailure
							if !errors.As(err, &failure) || failure.Unknown || plan != nil {
								t.Fatal("read-only agent scope accepted write", err)
							}
							continue
						}
						if err != nil {
							t.Fatal("approved agent scope refused", err)
						}
						if !hasParameterRule(plan, "allow file-read*", "subpath", scope) ||
							hasParameterRule(plan, "allow file-write*", "subpath", scope) != write ||
							hasParameterRule(plan, "allow file-read*", "subpath", selection.Home) ||
							hasParameterRule(plan, "allow file-write*", "subpath", selection.Home) {
							t.Fatal("agent access widened or write not separately controlled")
						}
						for _, text := range []string{"(deny default)", "(deny network*)", `(regex #"/[.]git(/|$)")`} {
							if !strings.Contains(plan.source, text) {
								t.Fatal("missing default protection", text)
							}
						}
						pattern := regexp.MustCompile(`\(deny file-read\* file-write\* \(regex #"([^"\n]+)"\)\)`).FindStringSubmatch(plan.source)
						if len(pattern) != 2 {
							t.Fatal("credential regex missing")
						}
						denied := regexp.MustCompile(pattern[1])
						for _, agent := range []string{".codex", ".claude", ".Codex", ".CLAUDE"} {
							for _, parent := range []string{selection.Home, scope} {
								path := parent + "/" + agent
								if hasParameterRule(plan, "deny file-read* file-write*", "subpath", path) || denied.MatchString(path+"/sessions") {
									t.Fatal("blanket agent-store denial", path)
								}
							}
						}
						// Unrelated protected names remain denied at HOME, at the
						// selected root and nested inside an ordinary agent directory.
						for _, store := range []string{".env", ".ssh", ".aws", ".gnupg", ".git-credentials", ".netrc", ".pypirc", ".config/gh/hosts.yml", ".docker/config.json", ".kube/config", "Library/Keychains"} {
							for _, parent := range []string{selection.Home, scope} {
								if !hasParameterRule(plan, "deny file-read* file-write*", "subpath", parent+"/"+store) {
									t.Fatal("protected store parameter missing", store)
								}
							}
							path := cwd + "/nested/" + strings.ToUpper(store) + "/child"
							if !denied.MatchString(path) || !protectedPath(path, selection.Home) {
								t.Fatal("nested protected store missed", path)
							}
						}
					}
				}
				if evidence.calls != 0 {
					t.Fatal("policy compilation invoked native evidence")
				}
			})
		}
	}
}

func TestSeatbeltAgentScopesRetainRefusalsAndExclusions(t *testing.T) {
	for _, directory := range []string{".codex", ".claude"} {
		for name, change := range map[string]func(*SeatbeltSelection, *Command){
			"shell-verification": func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Workspaces[0].ShellVerified = false },
			"grant-no-shell":     func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Participant.Grant.Capabilities = nil },
			"owner-no-shell":     func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Capabilities = nil },
			"grant-no-commands":  func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Participant.Grant.Commands = authority.NoCommands },
			"owner-no-commands":  func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.Commands = authority.NoCommands },
			"owner-read-only": func(s *SeatbeltSelection, _ *Command) {
				s.Snapshot.Approval.Workspaces[0].Access = authority.ReadAccess
			},
			"grant-read-only": func(s *SeatbeltSelection, _ *Command) {
				s.Snapshot.Participant.Grant.Workspaces[0].Access = authority.ReadAccess
			},
			"no-ownership": func(s *SeatbeltSelection, _ *Command) {
				s.Snapshot.Participant.MutationOwnership = authority.NoOwnership
			},
			"owner-mismatch":     func(s *SeatbeltSelection, _ *Command) { s.Snapshot.Approval.OwnerID = "other" },
			"physical-root":      func(_ *SeatbeltSelection, c *Command) { c.RootIdentity.Inode = "other" },
			"root-case-mismatch": func(_ *SeatbeltSelection, c *Command) { c.Root = strings.ToUpper(c.Root) },
			"unclean-cwd":        func(_ *SeatbeltSelection, c *Command) { c.Cwd += "/../sessions" },
			"broad-home": func(s *SeatbeltSelection, c *Command) {
				s.Snapshot.Approval.Workspaces[0].Root = s.Home
				s.Snapshot.Participant.Grant.Workspaces[0].Root = s.Home
				c.Root = s.Home
			},
			"owner-excluded-agent": func(s *SeatbeltSelection, c *Command) {
				s.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: strings.ToUpper(c.Root)}}
			},
			"grant-excluded-agent": func(s *SeatbeltSelection, c *Command) {
				s.Snapshot.Participant.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: c.Root}}
			},
			"home-npmrc": func(s *SeatbeltSelection, c *Command) {
				c.Root, c.Cwd = s.Home+"/.NPMRC", s.Home+"/.NPMRC"
				s.Snapshot.Approval.Workspaces[0].Root = c.Root
				s.Snapshot.Participant.Grant.Workspaces[0].Root = c.Root
			},
			"nested-ssh-scope": func(s *SeatbeltSelection, c *Command) {
				c.Cwd += "/nested/.SSH"
				s.Snapshot.Participant.Grant.Workspaces[0].Root = c.Cwd
			},
		} {
			t.Run(directory+"/"+name, func(t *testing.T) {
				_, selection, command, evidence := confinementFixture(t)
				root := selection.Home + "/" + directory
				selection.Snapshot.Approval.Workspaces[0].Root = root
				selection.Snapshot.Participant.Grant.Workspaces[0].Root = root
				command.Root, command.Cwd, command.Write = root, root, true
				command.Environment = seatbeltEnvironment(selection, true)
				change(&selection, &command)
				plan, err := compileSeatbelt(selection, command)
				var failure *processsvc.NativeFailure
				if !errors.As(err, &failure) || failure.Unknown || plan != nil || evidence.calls != 0 {
					t.Fatal("agent scope bypassed refusal or reached native evidence", err)
				}
			})
		}
		t.Run(directory+"/excluded-descendants", func(t *testing.T) {
			_, selection, command, evidence := confinementFixture(t)
			ownerExcluded := command.Cwd + "/" + directory
			grantExcluded := command.Cwd + "/nested/" + directory
			selection.Snapshot.Approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: ownerExcluded}}
			selection.Snapshot.Participant.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: grantExcluded}}
			plan, err := compileSeatbelt(selection, command)
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range []string{ownerExcluded, grantExcluded} {
				if !hasParameterRule(plan, "deny file-read* file-write*", "subpath", path) {
					t.Fatal("explicit agent exclusion omitted", path)
				}
			}
			if evidence.calls != 0 {
				t.Fatal("exclusion compilation invoked native evidence")
			}
		})
	}
}

// All facts, retained handles and watchdog IPC in this file are CPU doubles.
// Nothing launches a child or claims native filesystem/kernel qualification.
func bundleFixtureCPU(t *testing.T) platformFixture {
	t.Helper()
	f := platformFixtureCPU(t)
	bundle := ProtectedBundle{"/Users/owner/Applications/Farol.app", authority.RootIdentity{Device: "1", Inode: "42"}}
	// Match the accepted package placement while retaining explicit fake facts.
	backendFacts := f.facts.files[f.descriptor.Backend.Path]
	watchdogFacts := f.facts.files[f.descriptor.Watchdog.Path]
	f.descriptor.Backend.Path = bundle.Path + "/Contents/Resources/app/farol-backend"
	f.descriptor.Watchdog.Path = bundle.Path + "/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron"
	backendFacts.path, watchdogFacts.path = f.descriptor.Backend.Path, f.descriptor.Watchdog.Path
	f.facts.files[backendFacts.path], f.facts.files[watchdogFacts.path] = backendFacts, watchdogFacts
	f.facts.backendPath = backendFacts.path
	f.watchdog.Executable = f.descriptor.Watchdog
	f.policy.ProtectedImages = []ExecutablePin{f.descriptor.Backend, f.descriptor.Watchdog}
	f.descriptor.ProtectedBundle = cloneProtectedBundle(&bundle)
	f.policy.ProtectedBundle = cloneProtectedBundle(&bundle)
	f.facts.directories[bundle.Path] = platformDirectoryFacts{bundle.Path, "apfs", dataVolumePath, bundle.Identity, true, false, ""}
	f.original.Confinement = nil
	bound, err := (&Seatbelt{selection: f.policy}).bind(f.original)
	if err != nil {
		t.Fatal(err)
	}
	f.original = bound
	return f
}

func TestProtectedBundleCompilerProtectsResourcesAndAllAncestorsWithoutGrants(t *testing.T) {
	for _, outside := range []bool{false, true} {
		s, c := rootScopedFixture(t)
		root := "/Users/owner"
		s.Home = root
		s.Snapshot.Participant.Grant.Workspaces[0].Root = root
		s.Snapshot.Approval.Workspaces[0].Root = root
		c.Root, c.Cwd, c.Write = root, root, true
		bundlePath := root + "/Applications/Farol.app"
		if outside {
			bundlePath = dataVolumePath + bundlePath
		}
		environment := seatbeltEnvironment(s, true)
		s.ProtectedBundle = &ProtectedBundle{bundlePath, authority.RootIdentity{Device: "1", Inode: "42"}}
		c.Environment = seatbeltEnvironment(s, true)
		plan, err := compileSeatbelt(s, c)
		if err != nil {
			t.Fatal(err)
		}
		if !hasParameterRule(plan, "deny file-write*", "literal", bundlePath) ||
			!hasParameterRule(plan, "deny file-write*", "subpath", bundlePath) ||
			!hasParameterRule(plan, "allow file-write*", "subpath", root) {
			t.Fatal("missing bundle resource/root protection or ordinary HOME writes")
		}
		// Every ancestor is protected even across textual APFS workspace aliases.
		for ancestor := bundlePath[:strings.LastIndex(bundlePath, "/")]; ancestor != ""; ancestor = ancestor[:strings.LastIndex(ancestor, "/")] {
			if !hasParameterRule(plan, "deny file-write-unlink", "literal", ancestor) {
				t.Fatal("unprotected ancestor", ancestor)
			}
			if hasParameterRule(plan, "deny file-write*", "subpath", ancestor) {
				t.Fatal("ancestor denial consumes sibling writes", ancestor)
			}
		}
		for _, operation := range []string{"allow file-read*", "allow process-exec"} {
			for _, selector := range []string{"literal", "subpath"} {
				if hasParameterRule(plan, operation, selector, bundlePath) {
					t.Fatal("protection added access", operation)
				}
			}
		}
		if !slices.Equal(environment, seatbeltEnvironment(s, true)) {
			t.Fatal("protection changed PATH/environment")
		}
	}
}

func TestProtectedBundleRejectsInvalidSelectionsAndSupport(t *testing.T) {
	changes := map[string]func(*ProtectedBundle){
		"root":                  func(b *ProtectedBundle) { b.Path = "/" },
		"relative":              func(b *ProtectedBundle) { b.Path = "Farol.app" },
		"unclean":               func(b *ProtectedBundle) { b.Path += "/../Farol.app" },
		"control":               func(b *ProtectedBundle) { b.Path += "\n" },
		"empty-device":          func(b *ProtectedBundle) { b.Identity.Device = "" },
		"invalid-device":        func(b *ProtectedBundle) { b.Identity.Device = "+1" },
		"overflow":              func(b *ProtectedBundle) { b.Identity.Inode = "18446744073709551616" },
		"zero-inode":            func(b *ProtectedBundle) { b.Identity.Inode = "0" },
		"noncanonical-identity": func(b *ProtectedBundle) { b.Identity.Inode = "042" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := bundleFixtureCPU(t)
			change(f.policy.ProtectedBundle)
			if _, err := NewSeatbelt(f.policy, &confinementEvidenceDouble{}); err == nil {
				t.Fatal("invalid selection accepted")
			}
			change(f.descriptor.ProtectedBundle)
			if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
				t.Fatal("invalid support accepted")
			}
			if f.facts.reads != 0 {
				t.Fatal("invalid support reached native facts")
			}
		})
	}
	for _, path := range []string{"/private/tmp", "/private/tmp/farol-fixture-operation", "/private/tmp/farol-fixture-operation/app", "/PRIVATE/tmp/Farol-fixture-operation/app"} {
		s, _ := rootScopedFixture(t)
		s.ProtectedBundle = &ProtectedBundle{path, authority.RootIdentity{Device: "1", Inode: "42"}}
		if validSelection(s) {
			t.Fatal("scratch overlap accepted", path)
		}
	}
	f := bundleFixtureCPU(t)
	f.policy.FilePolicy = authority.LegacyProtectedFiles
	f.policy.Snapshot.Participant.Grant.FilePolicy = authority.LegacyProtectedFiles
	f.policy.Snapshot.Approval.FilePolicy = authority.LegacyProtectedFiles
	f.policy.Git = DenyGit
	f.policy.ProtectedImages = nil
	if validSelection(f.policy) {
		t.Fatal("legacy bundle selection accepted")
	}
	for _, which := range []string{"backend", "watchdog"} {
		f := bundleFixtureCPU(t)
		if which == "backend" {
			f.descriptor.Backend.Path = f.descriptor.ProtectedBundle.Path + "-sibling/backend"
		} else {
			f.descriptor.Watchdog.Path = f.descriptor.ProtectedBundle.Path
		}
		if validPlatformSupport(f.descriptor) {
			t.Fatal("component outside bundle accepted", which)
		}
	}
}

func TestProtectedBundleFrozenAndIncludedInPolicyReservationAndSupport(t *testing.T) {
	f := bundleFixtureCPU(t)
	expected := *f.policy.ProtectedBundle
	seatbelt, err := NewSeatbelt(f.policy, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := New(f.original, seatbelt, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	strategy := f.strategy(t)
	selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	f.policy.ProtectedBundle.Path = "/caller-mutation"
	f.descriptor.ProtectedBundle.Identity.Inode = "99"
	if *seatbelt.selection.ProtectedBundle != expected || *strategy.frozen.descriptor.ProtectedBundle != expected || *selected.frozen.policy.ProtectedBundle != expected {
		t.Fatal("constructor retained caller pointer")
	}
	launch, err := selectedLaunch(seatbelt, f.original)
	if err != nil || *launch.protectedBundle != expected {
		t.Fatal("bundle absent from launch", err)
	}
	launch.protectedBundle.Path = "/launch-mutation"
	again, err := selectedLaunch(seatbelt, f.original)
	if err != nil || *again.protectedBundle != expected {
		t.Fatal("launch aliases frozen policy", err)
	}
	for _, mode := range []string{"path", "device", "inode", "nil"} {
		t.Run(mode, func(t *testing.T) {
			next := bundleFixtureCPU(t)
			switch mode {
			case "path":
				next.policy.ProtectedBundle.Path += "-next"
			case "device":
				next.policy.ProtectedBundle.Identity.Device = "2"
			case "inode":
				next.policy.ProtectedBundle.Identity.Inode = "43"
			case "nil":
				next.policy.ProtectedBundle = nil
			}
			next.original.Confinement = nil
			policy, err := NewSeatbelt(next.policy, &confinementEvidenceDouble{})
			if err != nil {
				t.Fatal(err)
			}
			changed, err := New(next.original, policy, next.clock)
			if err != nil || changed.Seal().Digest == prepared.Seal().Digest {
				t.Fatal("bundle not in reservation seal", err)
			}
			if _, err := selectedLaunch(policy, f.original); err == nil {
				t.Fatal("old confinement rebound")
			}
			before, err := platformDigest(strategy.frozen.descriptor)
			if err != nil {
				t.Fatal(err)
			}
			descriptor := strategy.frozen.descriptor
			descriptor.ProtectedBundle = cloneProtectedBundle(next.policy.ProtectedBundle)
			after, err := platformDigest(descriptor)
			if err != nil || before == after {
				t.Fatal("bundle not in support seal", err)
			}
		})
	}
	// Nil remains the existing individually pinned class and selection shape.
	legacy := platformFixtureCPU(t)
	strategyNil := legacy.strategy(t)
	if _, err := strategyNil.Select(context.Background(), legacy.policy, legacy.original, legacy.watchdog); err != nil {
		t.Fatal("nil class lost", err)
	}
}

func TestProtectedBundlePlatformRejectsCrossedBindingsAndPhysicalDrift(t *testing.T) {
	for _, mode := range []string{"missing-policy", "missing-support", "crossed-inode", "crossed-path", "pins-missing"} {
		t.Run(mode, func(t *testing.T) {
			f := bundleFixtureCPU(t)
			if mode == "missing-support" {
				f.descriptor.ProtectedBundle = nil
			}
			strategy := f.strategy(t)
			switch mode {
			case "missing-policy":
				f.policy.ProtectedBundle = nil
			case "crossed-inode":
				f.policy.ProtectedBundle.Identity.Inode = "43"
			case "crossed-path":
				f.policy.ProtectedBundle.Path += "-other"
			case "pins-missing":
				f.policy.ProtectedImages = nil
			}
			if selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog); err == nil || selected != nil {
				t.Fatal("crossed protection accepted")
			}
		})
	}
	changes := map[string]func(*platformDirectoryFacts){
		"alias":         func(d *platformDirectoryFacts) { d.path = dataVolumePath + d.path },
		"identity":      func(d *platformDirectoryFacts) { d.identity.Inode = "43" },
		"device":        func(d *platformDirectoryFacts) { d.identity.Device = "2" },
		"filesystem":    func(d *platformDirectoryFacts) { d.filesystem = "hfs" },
		"remote":        func(d *platformDirectoryFacts) { d.local = false },
		"nested-mount":  func(d *platformDirectoryFacts) { d.nested = true },
		"invalid-mount": func(d *platformDirectoryFacts) { d.mount = "relative" },
		"mount-drift":   func(d *platformDirectoryFacts) { d.mount = "/Volumes/Other" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := bundleFixtureCPU(t)
			selected, q, deadline := f.qualify(t)
			path := f.policy.ProtectedBundle.Path
			d := f.facts.directories[path]
			change(&d)
			f.facts.directories[path] = d
			if q.ValidateBound(context.Background(), f.original, selected.WrappedCommand(), deadline) == nil {
				t.Fatal("bundle drift accepted before release")
			}
			if name != "mount-drift" {
				if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
					t.Fatal("unsupported bundle facts accepted at construction")
				}
			}
		})
	}
	f := bundleFixtureCPU(t)
	value := f.facts.files[f.descriptor.Watchdog.Path]
	value.identity.Device = "2"
	f.facts.files[f.descriptor.Watchdog.Path] = value
	if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
		t.Fatal("bundle component on another device accepted")
	}
}

func TestProtectedBundleRetainedHandlesRefuseDriftAndCloseExactlyOnce(t *testing.T) {
	for _, mode := range []string{"current", "identity", "alias", "owner", "trusted-owner-drift", "mode", "safe-mode-drift", "partial", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			_, command, launch, fs := rootMeasurementFixture(t)
			bundle := ProtectedBundle{"/bundle/Farol.app", authority.RootIdentity{Device: "1", Inode: "42"}}
			launch.protectedBundle = &bundle
			fs.directories[bundle.Path] = directoryFacts{bundle.Identity, os.ModeDir | 0755, 501}
			if mode == "partial" {
				fs.directoryError = bundle.Path
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			measurement, err := retainLaunchFiles(ctx, command, launch, fs)
			if mode == "partial" {
				if err == nil || measurement != nil {
					t.Fatal("partial capture retained")
				}
				fs.assertCloses(t, 1)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			absolute, anchored := slices.Clone(fs.absolute), slices.Clone(fs.anchored)
			// Recheck must use the captured value, never a caller's replacement binding.
			launch.protectedBundle = &ProtectedBundle{"/changed", authority.RootIdentity{Device: "3", Inode: "8"}}
			d := fs.directories[bundle.Path]
			switch mode {
			case "identity":
				d.identity.Inode = "43"
			case "alias":
				fs.alias = bundle.Path
			case "owner":
				d.uid = 502
			case "trusted-owner-drift":
				d.uid = 0
			case "mode":
				d.mode = os.ModeDir | 0775
			case "safe-mode-drift":
				d.mode = os.ModeDir | 0700
			case "cancelled":
				cancel()
			}
			fs.directories[bundle.Path] = d
			err = measurement.Recheck(context.Background())
			if (err == nil) != (mode == "current") {
				t.Fatal("incorrect retained result", mode, err)
			}
			if !slices.Equal(absolute, fs.absolute) || !slices.Equal(anchored, fs.anchored) {
				t.Fatal("recheck reopened paths")
			}
			measurement.Close()
			measurement.Close()
			fs.assertCloses(t, 1)
			if measurement.Recheck(context.Background()) == nil {
				t.Fatal("consumed measurement resurrected")
			}
		})
	}
}

func TestProtectedBundleUsesExistingWatchdogReservationAndRelease(t *testing.T) {
	for _, phase := range []string{"current", "platform-before-release", "retained-before-release"} {
		t.Run(phase, func(t *testing.T) {
			f := newWatchdogFixture(t)
			pf := bundleFixtureCPU(t)
			pf.clock.value = f.clock.Now()
			pf.policy.Snapshot.Participant.Grant.Identity = f.lease.binding.Identity
			pf.policy.Snapshot.Participant.Grant.ExpiresAt = f.lease.snapshot.Participant.Grant.ExpiresAt
			pf.policy.Snapshot.Approval.ExpiresAt = f.lease.snapshot.Approval.ExpiresAt
			f.lease.snapshot = pf.policy.Snapshot
			template := copyCommand(pf.original)
			template.Binding, template.Confinement = nil, nil
			template.Args, template.Input = nil, nil
			preparer, err := NewRootScopedSupervisedPreparer("cli", template, pf.policy, pf.strategy(t), pf.watchdog, context.Background(), f.clock)
			if err != nil {
				t.Fatal(err)
			}
			preparer.boundary.host = f.host
			_, _, _, fs := rootMeasurementFixture(t)
			bundle := *pf.policy.ProtectedBundle
			fs.directories[bundle.Path] = directoryFacts{bundle.Identity, os.ModeDir | 0755, 501}
			preparer.boundary.measure = func(ctx context.Context, command Command, launch *confinedLaunch) (launchMeasurement, error) {
				f.measurements.Add(1)
				return retainLaunchFiles(ctx, command, launch, fs)
			}
			f.preparer = preparer
			service, err := processsvc.NewForInvocation("operation", f.lease, preparer, f.reservation, &sync.Mutex{}, f.clock)
			if err != nil {
				t.Fatal(err)
			}
			f.route, err = processcontract.New(service)
			if err != nil {
				t.Fatal(err)
			}
			f.prepare(t)
			if phase != "current" {
				f.host.beforePrepared = func() {
					if phase == "platform-before-release" {
						d := pf.facts.directories[bundle.Path]
						d.identity.Inode = "43"
						pf.facts.directories[d.path] = d
					} else {
						d := fs.directories[bundle.Path]
						d.identity.Inode = "43"
						fs.directories[bundle.Path] = d
					}
				}
			}
			started, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if f.reservation.calls != 1 || f.measurements.Load() != 1 || f.host.calls.Load() != 1 {
				t.Fatal("existing owners duplicated")
			}
			fs.assertCloses(t, 1)
			if phase != "current" {
				if err == nil || f.host.starts.Load() != 0 {
					t.Fatal("drift released command")
				}
				f.settle(t)
				_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
				if err == nil || f.host.calls.Load() != 1 || f.reservation.calls != 1 {
					t.Fatal("refusal replayed")
				}
				return
			}
			if err != nil || started == nil || f.host.starts.Load() != 1 {
				t.Fatal("unchanged bundle refused", err)
			}
			prepare, release := <-f.host.frames, <-f.host.frames
			if prepare["deadlineAt"] != float64(f.lease.deadline.UnixMilli()) || release["type"] != "start" {
				t.Fatal("deadline/release changed")
			}
			f.emit(t, map[string]any{"type": "close", "id": prepare["id"], "code": 0, "signal": nil})
			f.settle(t)
			again, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err != nil || again.Handle != started.Handle || f.host.starts.Load() != 1 {
				t.Fatal("retained outcome redispatched", err)
			}
		})
	}
}

func TestProtectedBundleSelectionDigestAndOriginalDeadline(t *testing.T) {
	f := bundleFixtureCPU(t)
	selected, q, deadline := f.qualify(t)
	next := bundleFixtureCPU(t)
	next.descriptor.ProtectedBundle.Identity.Inode = "43"
	next.policy.ProtectedBundle.Identity.Inode = "43"
	d := next.facts.directories[next.policy.ProtectedBundle.Path]
	d.identity.Inode = "43"
	next.facts.directories[d.path] = d
	next.original.Confinement = nil
	var err error
	next.original, err = (&Seatbelt{selection: next.policy}).bind(next.original)
	if err != nil {
		t.Fatal(err)
	}
	other := next.selectCommand(t)
	if other.Binding().SupportSHA256 == selected.Binding().SupportSHA256 || other.Binding().SelectionSHA256 == selected.Binding().SelectionSHA256 {
		t.Fatal("binding omitted from strategy/selection digest")
	}
	if _, err := selected.BindInvocation(context.Background(), f.original, selected.WrappedCommand(), deadline.Add(time.Second)); err == nil {
		t.Fatal("deadline extended")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if q.Qualify(cancelled, selected.WrappedCommand()) == nil {
		t.Fatal("cancelled qualification accepted")
	}
}

// The no-bundle root-scoped class includes ordinary-Git config metadata and
// the exact uname reads. Nil bundle and disabled mount-boundary fields stay omitted.
// Unapproved user Git config now selects /dev/null and scratch XDG config. This
// intentionally changes the invocation/selection digest, not the profile or
// support digests. The frozen selection below includes that narrower environment.
func TestProtectedBundleNilPreservesFrozenBaselineDigests(t *testing.T) {
	f := platformFixtureCPU(t)
	if f.policy.UserGitSettings || !slices.Contains(f.original.Environment, "GIT_CONFIG_GLOBAL=/dev/null") ||
		!slices.Contains(f.original.Environment, "XDG_CONFIG_HOME="+f.policy.Scratch) {
		t.Fatal("frozen unapproved selection omitted the explicit config restriction")
	}
	strategy := f.strategy(t)
	selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(f.policy, f.original)
	if err != nil {
		t.Fatal(err)
	}
	if plan.digest != "3aee32564e93dfe3948599bf93a5cf7ce105f9622a5111e02a238f8b15c55e9a" ||
		strategy.Binding().SupportSHA256 != "d4fedcdb8be2faef765b57e849add5738d2e6299b462634ef1d4d4ea2169e84b" ||
		selected.Binding().SelectionSHA256 != "684537ecc4ae70c14274fccb7e501c2e3ef32e2d33d9242b8744407788ed3794" {
		t.Fatalf("nil bundle altered frozen baseline digests: profile=%s support=%s selection=%s", plan.digest, strategy.Binding().SupportSHA256, selected.Binding().SelectionSHA256)
	}
}

func TestRootScopedProtectedImagesDoNotRejectWritableHomeOrGrantExecution(t *testing.T) {
	s, c := rootScopedFixture(t)
	root := "/owner/home"
	s.Home = root
	s.Snapshot.Participant.Grant.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].Root = root
	c.Root, c.Cwd, c.Write = root, root, true
	c.Environment = seatbeltEnvironment(s, true)
	image := root + "/Applications/Farol.app/Contents/MacOS/backend"
	s.ProtectedImages = []ExecutablePin{{image, strings.Repeat("e", 64)}}
	plan, err := compileSeatbelt(s, c)
	if err != nil {
		t.Fatal("approved writable HOME refused", err)
	}
	if !hasParameterRule(plan, "allow file-write*", "subpath", root) ||
		!hasParameterRule(plan, "deny file-write*", "literal", image) {
		t.Fatal("root access or protected image rule missing")
	}
	for _, path := range []string{root + "/Applications", root + "/Applications/Farol.app", root + "/Applications/Farol.app/Contents", root + "/Applications/Farol.app/Contents/MacOS"} {
		if !hasParameterRule(plan, "deny file-write-unlink", "literal", path) {
			t.Fatal("image ancestor can be renamed", path)
		}
		if hasParameterRule(plan, "deny file-write*", "subpath", path) {
			t.Fatal("ancestor protection denied ordinary sibling writes", path)
		}
	}
	for _, operation := range []string{"allow file-read*", "allow process-exec"} {
		if hasParameterRule(plan, operation, "literal", image) {
			t.Fatal("protected image added a new permission")
		}
	}
	// A protected image outside the scope likewise supplies no ambient permission.
	s.ProtectedImages[0].Path = "/separate/runtime/backend"
	outside, err := compileSeatbelt(s, c)
	if err != nil || hasParameterRule(outside, "allow process-exec", "literal", s.ProtectedImages[0].Path) ||
		hasParameterRule(outside, "allow file-read*", "literal", s.ProtectedImages[0].Path) {
		t.Fatal("outside protection broadened access", err)
	}
}

func TestRootScopedProtectedImagesAreFrozenMeasuredAndSealed(t *testing.T) {
	s, c := rootScopedFixture(t)
	image := ExecutablePin{"/owner/home/Applications/Farol/backend", strings.Repeat("e", 64)}
	s.ProtectedImages = []ExecutablePin{image}
	policy, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := policy.bind(c)
	if err != nil {
		t.Fatal(err)
	}
	s.ProtectedImages[0].Path = "/changed"
	launch, err := selectedLaunch(policy, bound)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, pin := range launch.pins {
		if pin == image {
			found = true
		}
	}
	if !found || policy.selection.ProtectedImages[0] != image {
		t.Fatal("protected image not frozen/measured")
	}
	before := *bound.Confinement
	policy.selection.ProtectedImages[0].SHA256 = strings.Repeat("f", 64)
	if _, err := selectedLaunch(policy, bound); err == nil {
		t.Fatal("changed protected image retained old seal")
	}
	c.Confinement = nil
	changed, err := policy.bind(c)
	if err != nil || *changed.Confinement == before {
		t.Fatal("protected image omitted from policy seal", err)
	}
}

func TestRootScopedProtectedImageInvalidSelectionRefuses(t *testing.T) {
	for _, mode := range []string{"duplicate", "executable-overlap", "scratch", "legacy", "bad-digest", "relative"} {
		t.Run(mode, func(t *testing.T) {
			s, c := rootScopedFixture(t)
			s.ProtectedImages = []ExecutablePin{{"/runtime/backend", strings.Repeat("e", 64)}}
			switch mode {
			case "duplicate":
				s.ProtectedImages = append(s.ProtectedImages, s.ProtectedImages[0])
			case "executable-overlap":
				s.ProtectedImages[0] = s.Executables[0]
			case "scratch":
				s.ProtectedImages[0].Path = s.Scratch + "/backend"
			case "legacy":
				s.FilePolicy = authority.LegacyProtectedFiles
			case "bad-digest":
				s.ProtectedImages[0].SHA256 = "not-a-hash"
			case "relative":
				s.ProtectedImages[0].Path = "runtime/backend"
			}
			if _, err := compileSeatbelt(s, c); err == nil {
				t.Fatal("invalid protection selected")
			}
		})
	}
}

func TestRootScopedProtectedImageAncestorsAcrossAPFSAliases(t *testing.T) {
	for _, physicalRoot := range []bool{true, false} {
		s, c := rootScopedFixture(t)
		logical := "/Users/owner"
		physical := "/System/Volumes/Data" + logical
		root, imageRoot := logical, physical
		if physicalRoot {
			root, imageRoot = physical, logical
		}
		s.Home = logical
		s.Snapshot.Participant.Grant.Workspaces[0].Root = root
		s.Snapshot.Approval.Workspaces[0].Root = root
		c.Root, c.Cwd, c.Write = root, root, true
		c.Environment = seatbeltEnvironment(s, true)
		s.ProtectedImages = []ExecutablePin{{imageRoot + "/Applications/Farol.app/backend", strings.Repeat("e", 64)}}
		plan, err := compileSeatbelt(s, c)
		if err != nil {
			t.Fatal(err)
		}
		for _, ancestor := range []string{imageRoot, imageRoot + "/Applications", imageRoot + "/Applications/Farol.app"} {
			if !hasParameterRule(plan, "deny file-write-unlink", "literal", ancestor) {
				t.Fatalf("missing alias-independent ancestor protection for %s", ancestor)
			}
		}
		if !hasParameterRule(plan, "allow file-write*", "subpath", root) {
			t.Fatal("ordinary approved writes lost")
		}
	}
}

// Compiler evidence only. Native Seatbelt and retained directory checks are separate.
func TestProtectedStateCompilerAndSeal(t *testing.T) {
	s, c := rootScopedFixture(t)
	root := "/Users/owner"
	s.Home = root
	s.Snapshot.Participant.Grant.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].Root = root
	c.Root, c.Cwd, c.Write = root, root, true
	c.Environment = seatbeltEnvironment(s, true)
	state := &ProtectedBundle{Path: root + "/Library/Application Support/Farol/computer", Identity: authority.RootIdentity{Device: "1", Inode: "42"}}
	s.ProtectedState = state
	plan, err := compileSeatbelt(s, c)
	if err != nil {
		t.Fatal(err)
	}
	for _, alias := range mountDenialAliases(state.Path) {
		if !hasParameterRule(plan, "deny file-read* file-write* process-exec", "subpath", alias) || !hasParameterRule(plan, "deny file-write-unlink", "literal", alias) {
			t.Fatalf("state deny missing for %s", alias)
		}
	}
	if !hasParameterRule(plan, "allow file-write*", "subpath", root) || !hasParameterRule(plan, "deny file-write-unlink", "literal", root) {
		t.Fatal("ordinary root or ancestor protection missing")
	}
	seatbelt, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	state.Identity.Inode = "43"
	changed, err := compileSeatbelt(s, c)
	if err != nil || changed.digest == plan.digest {
		t.Fatal("identity not bound to seal", err)
	}
	if seatbelt.selection.ProtectedState.Identity.Inode != "42" {
		t.Fatal("selection not frozen")
	}
	c.Cwd = state.Path
	if _, err := compileSeatbelt(s, c); err == nil {
		t.Fatal("protected cwd admitted")
	}
}

func TestProtectedStatePlatformBindsAndRefusesIdentityDrift(t *testing.T) {
	baseline := platformFixtureCPU(t)
	baseSelection := baseline.selectCommand(t)
	f := platformFixtureCPU(t)
	state := &ProtectedBundle{Path: "/Users/owner/Library/Application Support/Farol/computer", Identity: authority.RootIdentity{Device: "1", Inode: "42"}}
	f.policy.ProtectedState = state
	f.facts.directories[state.Path] = platformDirectoryFacts{state.Path, "apfs", dataVolumePath, state.Identity, true, false, ""}
	f.original.Confinement = nil
	bound, err := (&Seatbelt{selection: f.policy}).bind(f.original)
	if err != nil {
		t.Fatal(err)
	}
	f.original = bound
	selection, q, deadline := f.qualify(t)
	if selection.Binding().SupportSHA256 != baseSelection.Binding().SupportSHA256 || selection.Binding().SelectionSHA256 == baseSelection.Binding().SelectionSHA256 {
		t.Fatal("wrong support or selection binding")
	}
	if err := q.ValidateBound(context.Background(), f.original, selection.WrappedCommand(), deadline); err != nil {
		t.Fatal(err)
	}
	facts := f.facts.directories[state.Path]
	facts.identity.Inode = "43"
	f.facts.directories[state.Path] = facts
	if q.ValidateBound(context.Background(), f.original, selection.WrappedCommand(), deadline) == nil {
		t.Fatal("state identity drift accepted")
	}
}

// Pure policy/profile compilation only. No files, native qualification or
// processes are used; emitted rules are not kernel enforcement evidence.
func TestRepositoryConfigPureHomeOnlyProtection(t *testing.T) {
	const home = "/owner/home"
	for _, path := range []string{"/repo/.npmrc", "/repo/nested/.NPMRC", home + "/code/repo/.npmrc", home + "grown/.npmrc"} {
		if protectedPath(path, home) || protectedScope(path, home) || regexp.MustCompile(credentialRegex()).MatchString(path) {
			t.Fatal("ordinary repository config blanket-denied", path)
		}
	}
	for _, path := range []string{home + "/.npmrc", "/OWNER/HOME/.NPMRC", home + "/.npmrc/child", home + "/.NPMRC/ancestor/repo"} {
		if !protectedPath(path, home) || !protectedScope(path, home) {
			t.Fatal("HOME credential alias lost", path)
		}
	}
	for _, root := range []string{"/owner", home, "/OWNER/HOME"} {
		if !protectedScope(root, home) {
			t.Fatal("enclosing HOME scope accepted", root)
		}
	}
}

func TestRepositoryConfigPureSelectedProfile(t *testing.T) {
	for _, shape := range []string{"repository", "nested", "direct", "ancestor", "home-approval"} {
		t.Run(shape, func(t *testing.T) {
			_, s, c, evidence := confinementFixture(t)
			root := s.Home + "/code/repo"
			if shape == "direct" || shape == "ancestor" {
				root += "/.NPMRC"
			}
			if shape == "ancestor" {
				root += "/repo"
			}
			s.Snapshot.Approval.Workspaces[0].Root = root
			s.Snapshot.Participant.Grant.Workspaces[0].Root = root
			c.Root, c.Cwd = root, root
			if shape == "nested" {
				c.Cwd += "/nested/.npmrc"
			}
			if shape == "home-approval" {
				c.Root, s.Snapshot.Approval.Workspaces[0].Root = s.Home, s.Home
			}
			for _, write := range []bool{false, true} {
				c.Write, c.Environment = write, seatbeltEnvironment(s, write)
				plan, err := compileSeatbelt(s, c)
				if err != nil {
					t.Fatal("approved repository config scope refused", err)
				}
				if !hasParameterRule(plan, "allow file-read*", "subpath", root) || hasParameterRule(plan, "allow file-write*", "subpath", root) != write ||
					!hasParameterRule(plan, "deny file-read* file-write*", "subpath", s.Home+"/.npmrc") || hasParameterRule(plan, "deny file-read* file-write*", "subpath", root+"/.npmrc") {
					t.Fatal("HOME-only rule or separate write scope lost")
				}
				for _, text := range []string{"(deny default)", "(deny network*)", `(regex #"/[.]git(/|$)")`} {
					if !strings.Contains(plan.source, text) {
						t.Fatal("unchanged guard lost", text)
					}
				}
			}
			// Explicit exclusions from either policy remain stronger than the grant.
			for _, owner := range []bool{false, true} {
				excluded := root + "/.NPMRC"
				e := []authority.Exclusion{{WorkspaceID: "work", Path: excluded}}
				if owner {
					s.Snapshot.Approval.ExcludedPaths = e
				} else {
					s.Snapshot.Participant.Grant.ExcludedPaths = e
				}
				plan, err := compileSeatbelt(s, c)
				if err != nil || !hasParameterRule(plan, "deny file-read* file-write*", "subpath", excluded) {
					t.Fatal("explicit repository exclusion omitted", err)
				}
			}
			if evidence.calls != 0 {
				t.Fatal("pure compilation invoked native evidence")
			}
		})
	}
}
