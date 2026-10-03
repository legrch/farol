package process

import (
	"context"
	"errors"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
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
