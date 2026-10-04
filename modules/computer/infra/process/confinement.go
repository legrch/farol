package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

const seatbeltExecutable = "/usr/bin/sandbox-exec"

// ConfinementBinding participates in the original command's reservation digest.
// It is a mechanism binding, never admission, renewal or native evidence.
type ConfinementBinding struct{ ProfileSHA256, MechanismSHA256 string }
type ExecutablePin struct{ Path, SHA256 string }
type GitPolicy string

const (
	DenyGit      GitPolicy = "deny"
	WorkspaceGit GitPolicy = "workspace"
)

// SeatbeltSelection is trusted composition input from the SAME selected lease's
// coherent snapshot. It is not a tool/request DTO. One selected subtree is
// supported; external Git metadata/config and network allow remain unqualified.
// Scratch is a root-owned, operation-private directory, not another workspace.
type SeatbeltSelection struct {
	Snapshot                                               port.AccessSnapshot
	RuntimeID, WorkspaceID, Home, Scratch, MechanismSHA256 string
	ScratchIdentity                                        authority.RootIdentity
	Executables                                            []ExecutablePin
	Network                                                authority.Network
	Git                                                    GitPolicy
}

// Seatbelt builds the actual restrictive launch. The injected existing native
// Qualification must independently qualify the wrapped invocation, including
// kernel policy inheritance, aliases/links and executable continuity. There is
// no default producer of that evidence and no positive native claim from this
// compiler. Qualification never issues or extends a TaskGrant/execution lease.
type Seatbelt struct {
	selection     SeatbeltSelection
	qualification Qualification
}
type confinedLaunch struct {
	command         Command
	pins            []ExecutablePin
	scratch         string
	scratchIdentity authority.RootIdentity
	qualification   Qualification
}

func NewSeatbelt(selection SeatbeltSelection, qualification Qualification) (*Seatbelt, error) {
	if qualification == nil || !validSelection(selection) {
		return nil, &processsvc.NativeFailure{}
	}
	if _, nested := qualification.(*Seatbelt); nested {
		return nil, &processsvc.NativeFailure{}
	}
	p := *selection.Snapshot.Participant
	p.Grant = p.Grant.Clone()
	a := *selection.Snapshot.Approval
	a.Workspaces = append([]authority.ApprovedWorkspace(nil), a.Workspaces...)
	for i := range a.Workspaces {
		if a.Workspaces[i].GitMetadata != nil {
			git := *a.Workspaces[i].GitMetadata
			a.Workspaces[i].GitMetadata = &git
		}
	}
	a.ExcludedPaths = append([]authority.Exclusion(nil), a.ExcludedPaths...)
	a.Capabilities = append([]authority.Capability(nil), a.Capabilities...)
	selection.Snapshot = port.AccessSnapshot{Participant: &p, Approval: &a}
	selection.Executables = append([]ExecutablePin(nil), selection.Executables...)
	return &Seatbelt{selection: selection, qualification: qualification}, nil
}

func (s *Seatbelt) bind(command Command) (Command, error) {
	plan, err := compileSeatbelt(s.selection, command)
	if err != nil {
		return Command{}, err
	}
	wrapped := copyCommand(command)
	wrapped.Executable, wrapped.ExecutableSHA256 = seatbeltExecutable, s.selection.MechanismSHA256
	wrapped.Args = append(append(append([]string(nil), plan.arguments...), command.Executable), command.Args...)
	if !validCommand(wrapped) {
		return Command{}, &processsvc.NativeFailure{}
	}
	binding := ConfinementBinding{ProfileSHA256: plan.digest, MechanismSHA256: s.selection.MechanismSHA256}
	if command.Confinement != nil && *command.Confinement != binding {
		return Command{}, &processsvc.NativeFailure{}
	}
	command = copyCommand(command)
	command.Confinement = &binding
	return command, nil
}

func selectedLaunch(qualification Qualification, command Command) (*confinedLaunch, error) {
	selected, ok := qualification.(*Seatbelt)
	if !ok || selected == nil || selected.qualification == nil {
		// A nil-returning Qualify callback alone cannot reach plain os/exec.
		return nil, &processsvc.NativeFailure{}
	}
	bound, err := selected.bind(command)
	if err != nil || command.Binding == nil || command.Confinement == nil || *command.Confinement != *bound.Confinement {
		return nil, &processsvc.NativeFailure{}
	}
	plan, err := compileSeatbelt(selected.selection, command)
	if err != nil {
		return nil, err
	}
	wrapped := copyCommand(command)
	wrapped.Executable = seatbeltExecutable
	wrapped.ExecutableSHA256 = selected.selection.MechanismSHA256
	wrapped.Args = append(append([]string(nil), plan.arguments...), command.Executable)
	wrapped.Args = append(wrapped.Args, command.Args...)
	if !validCommand(wrapped) {
		return nil, &processsvc.NativeFailure{}
	}
	return &confinedLaunch{command: wrapped, pins: append([]ExecutablePin{{seatbeltExecutable, selected.selection.MechanismSHA256}}, selected.selection.Executables...),
		scratch: selected.selection.Scratch, scratchIdentity: selected.selection.ScratchIdentity, qualification: selected.qualification}, nil
}

// Qualify delegates the exact wrapped invocation to the existing evidence port.
// Native Start uses selectedLaunch then calls that port once after preflight.
func (s *Seatbelt) Qualify(ctx context.Context, command Command) error {
	launch, err := selectedLaunch(s, command)
	if err != nil || ctx == nil || ctx.Err() != nil {
		return &processsvc.NativeFailure{}
	}
	return launch.qualification.Qualify(ctx, copyCommand(launch.command))
}

func absolutePolicyPath(path string) bool {
	if len(path) == 0 || len(path) > 4096 || !utf8.ValidString(path) || !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return false
	}
	for _, r := range path {
		if r < 32 || r == 127 || r == 92 {
			return false
		}
	}
	return true
}
func digestValue(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && strings.ToLower(value) == value
}
func insidePolicy(root, path string) bool { return path == root || strings.HasPrefix(path, root+"/") }
func comparableOverlap(a, b string) bool {
	return authority.ComparableWithin(a, b) || authority.ComparableWithin(b, a)
}

var credentialStores = []string{".env", ".ssh", ".aws", ".gnupg", ".codex", ".claude", ".git-credentials", ".netrc", ".npmrc", ".pypirc", ".config/gh/hosts.yml", ".docker/config.json", ".kube/config", "Library/Keychains"}

func protectedPath(path, home string) bool {
	for _, store := range credentialStores {
		if authority.ComparableWithin(filepath.Join(home, store), path) {
			return true
		}
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i := range parts {
		for _, store := range credentialStores {
			if authority.ComparableWithin("/"+store, "/"+strings.Join(parts[i:], "/")) {
				return true
			}
		}
		if strings.HasPrefix(strings.ToLower(parts[i]), ".env.") {
			return true
		}
	}
	return false
}

// A finite deny list cannot qualify broad owner HOME access. Refuse a scope
// covering HOME, or overlapping an exact known private store, before sealing.
// ComparableWithin is denial-only; ordinary HOME/code/project grants stay exact.
func protectedScope(root, home string) bool {
	if authority.ComparableWithin(root, home) || protectedPath(root, home) {
		return true
	}
	for _, store := range credentialStores {
		if comparableOverlap(root, filepath.Join(home, store)) {
			return true
		}
	}
	return false
}

func validSelection(s SeatbeltSelection) bool {
	if s.Snapshot.Participant == nil || s.Snapshot.Approval == nil || !bindingID(s.RuntimeID) || !bindingID(s.WorkspaceID) || !absolutePolicyPath(s.Home) || !absolutePolicyPath(s.Scratch) ||
		!digestValue(s.MechanismSHA256) || s.ScratchIdentity.Device == "" || s.ScratchIdentity.Inode == "" || len(s.Executables) == 0 || len(s.Executables) > 16 ||
		filepath.Dir(s.Scratch) != "/private/tmp" || !strings.HasPrefix(filepath.Base(s.Scratch), "farol-") || s.Network != authority.NoNetwork || (s.Git != DenyGit && s.Git != WorkspaceGit) || protectedPath(s.Scratch, s.Home) {
		return false
	}
	seen := map[string]bool{}
	for _, pin := range s.Executables {
		if !absolutePolicyPath(pin.Path) || !digestValue(pin.SHA256) || seen[pin.Path] || strings.Contains(pin.Path, ":") || pin.Path == seatbeltExecutable || protectedPath(pin.Path, s.Home) {
			return false
		}
		seen[pin.Path] = true
	}
	return true
}

type seatbeltPlan struct {
	source    string
	arguments []string
	digest    string
}

func compileSeatbelt(s SeatbeltSelection, command Command) (*seatbeltPlan, error) {
	refuse := func() (*seatbeltPlan, error) { return nil, &processsvc.NativeFailure{} }
	if !validSelection(s) || !validCommand(command) || command.WorkspaceID != s.WorkspaceID || (command.Binding != nil && (command.Binding.RuntimeID != s.RuntimeID || command.Binding.AdmissionID != s.Snapshot.Participant.Grant.AuthorityID)) {
		return refuse()
	}
	p, a := s.Snapshot.Participant, s.Snapshot.Approval
	workspace, found := authority.FindApproved(*a, s.WorkspaceID)
	scope, scoped := authority.FindScope(p.Grant, s.WorkspaceID)
	if !found || !scoped || !absolutePolicyPath(workspace.Root) || !workspace.ShellVerified || (scope.Access != authority.ReadAccess && scope.Access != authority.WriteAccess) || (workspace.Access != authority.ReadAccess && workspace.Access != authority.WriteAccess) || scope.Mode != authority.Subtree || len(scope.Paths) != 0 || !absolutePolicyPath(scope.Root) ||
		workspace.Root != command.Root || workspace.RootIdentity != command.RootIdentity || !insidePolicy(workspace.Root, scope.Root) || !insidePolicy(scope.Root, command.Cwd) ||
		protectedScope(scope.Root, s.Home) || comparableOverlap(scope.Root, s.Scratch) ||
		p.Grant.ComputerID != a.ComputerID || p.Grant.ComputerGeneration != a.Generation || p.Grant.OwnerID != a.OwnerID ||
		p.Grant.Commands != authority.WorkspaceCommands || a.Commands != authority.WorkspaceCommands || !slices.Contains(p.Grant.Capabilities, authority.Shell) || !slices.Contains(a.Capabilities, authority.Shell) ||
		(command.Write && (scope.Access != authority.WriteAccess || workspace.Access != authority.WriteAccess || p.MutationOwnership != authority.TaskOwnership)) {
		return refuse()
	}
	matched := false
	for _, pin := range s.Executables {
		if pin.Path == command.Executable && pin.SHA256 == command.ExecutableSHA256 {
			matched = true
		}
		if comparableOverlap(pin.Path, s.Scratch) {
			return refuse()
		}
	}
	if !matched || protectedPath(command.Cwd, s.Home) {
		return refuse()
	}
	if s.Git == WorkspaceGit {
		if !workspace.GitHistoryApproved {
			return refuse()
		}
		if workspace.GitMetadata == nil || (workspace.GitMetadata.GitDirectory != filepath.Join(scope.Root, ".git") || workspace.GitMetadata.CommonDirectory != filepath.Join(scope.Root, ".git")) {
			return refuse() // No inferred linked-worktree/common-dir/config grant.
		}
	}

	var parameters, reads, writes, execs, denies, parents, executableWrites []string
	add := func(kind, path string, rules *[]string) {
		key := fmt.Sprintf("FAROL_%d", len(parameters)/2)
		parameters = append(parameters, "-D", key+"="+path)
		*rules = append(*rules, fmt.Sprintf("(%s (param %q))", kind, key))
	}
	add("subpath", scope.Root, &reads)
	if command.Write {
		add("subpath", scope.Root, &writes)
	}
	add("subpath", s.Scratch, &reads)
	add("subpath", s.Scratch, &writes)
	for _, pin := range s.Executables {
		add("literal", pin.Path, &execs)
		add("literal", pin.Path, &reads)
		add("literal", pin.Path, &executableWrites) // Executable bytes cannot be written.
	}
	for _, exclusion := range append(append([]authority.Exclusion(nil), a.ExcludedPaths...), p.Grant.ExcludedPaths...) {
		if exclusion.WorkspaceID != s.WorkspaceID {
			continue
		}
		if !absolutePolicyPath(exclusion.Path) || !authority.ComparableWithin(workspace.Root, exclusion.Path) ||
			authority.ComparableWithin(exclusion.Path, command.Cwd) || authority.ComparableWithin(exclusion.Path, s.Scratch) {
			return refuse()
		}
		for _, pin := range s.Executables {
			if authority.ComparableWithin(exclusion.Path, pin.Path) {
				return refuse()
			}
		}
		add("subpath", exclusion.Path, &denies)
	}
	// Deny credential stores regardless of a selected workspace enclosing HOME.
	var secrets []string
	for _, store := range credentialStores {
		add("subpath", filepath.Join(s.Home, store), &secrets)
		add("subpath", filepath.Join(scope.Root, store), &secrets)
	}
	if s.Git == DenyGit {
		add("subpath", filepath.Join(scope.Root, ".git"), &secrets)
	}
	for ancestor := filepath.Dir(scope.Root); ancestor != "/"; ancestor = filepath.Dir(ancestor) {
		add("literal", ancestor, &parents)
	}
	if !slices.Equal(command.Environment, seatbeltEnvironment(s, command.Write)) {
		return refuse()
	}
	source := `(version 1)
(import "dyld-support.sb")
(deny default)
(allow process-fork)
(allow signal (target self))
(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (literal "/dev/null") (literal "/dev/urandom") ` + strings.Join(reads, " ") + `)
(allow process-exec ` + strings.Join(execs, " ") + `)
(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$") ` + strings.Join(writes, " ") + `)
(deny file-write* ` + strings.Join(executableWrites, " ") + `)
(deny file-read* file-write* ` + strings.Join(secrets, " ") + `)
(deny file-read* file-write* (regex #"` + credentialRegex() + `"))
(deny network*)`
	if len(denies) > 0 {
		source += "\n(deny file-read* file-write* " + strings.Join(denies, " ") + ")"
	}
	if len(parents) > 0 {
		source += "\n(allow file-read-metadata " + strings.Join(parents, " ") + ")"
	}
	if s.Git == DenyGit {
		source += `
(deny file-read* file-write* (regex #"/[.]git(/|$)"))`
	}
	// Keep policy input out of the profile language: paths are only -D values.
	arguments := append(parameters, "-p", source, "--")
	encoded, err := json.Marshal(struct {
		Source          string
		Arguments       []string
		ScratchIdentity authority.RootIdentity
		Pins            []ExecutablePin
	}{source, arguments, s.ScratchIdentity, s.Executables})
	if err != nil {
		return refuse()
	}
	digest := sha256.Sum256(encoded)
	return &seatbeltPlan{source: source, arguments: arguments, digest: hex.EncodeToString(digest[:])}, nil
}

// Environment is constructed from trusted policy, then matched exactly. It
// disables external Git config/prompts and never carries tokens, owner HOME,
// inherited NODE_OPTIONS/DYLD_*, GIT_CONFIG_COUNT or credential helpers.
func (s *Seatbelt) Environment(write bool) []string { return seatbeltEnvironment(s.selection, write) }
func seatbeltEnvironment(s SeatbeltSelection, write bool) []string {
	var dirs []string
	for _, pin := range s.Executables {
		if dir := filepath.Dir(pin.Path); !slices.Contains(dirs, dir) {
			dirs = append(dirs, dir)
		}
	}
	slices.Sort(dirs)
	locks := "0"
	if write {
		locks = "1"
	}
	return []string{"HOME=" + s.Scratch, "TMPDIR=" + s.Scratch, "XDG_CONFIG_HOME=" + filepath.Join(s.Scratch, ".config"), "PATH=" + strings.Join(dirs, ":"),
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=" + locks, "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
}

var _ Qualification = (*Seatbelt)(nil)

func credentialRegex() string {
	var patterns []string
	for _, store := range credentialStores {
		var pattern strings.Builder
		for _, r := range store {
			switch {
			case r == '.':
				pattern.WriteString("[.]")
			case r >= 'a' && r <= 'z':
				fmt.Fprintf(&pattern, "[%c%c]", r, r-'a'+'A')
			case r >= 'A' && r <= 'Z':
				fmt.Fprintf(&pattern, "[%c%c]", r-'A'+'a', r)
			default:
				pattern.WriteRune(r)
			}
		}
		if store == ".env" {
			pattern.WriteString("([.][^/]*)?")
		}
		patterns = append(patterns, pattern.String())
	}
	return "/(" + strings.Join(patterns, "|") + ")(/|$)"
}

// This comparison is only policy correlation. Current permission/lifetime remain
// in the existing lease/domain authorizer, including every revocation/generation
// check. Expiration timestamps are not profile rules and are never extended here.
func (s *Seatbelt) matchesPolicy(command Command, snapshot port.AccessSnapshot) bool {
	if s == nil || snapshot.Participant == nil || snapshot.Approval == nil {
		return false
	}
	original := s.selection.Snapshot.Participant
	current := snapshot.Participant
	if current.ParticipantID != original.ParticipantID || current.Grant.Identity != original.Grant.Identity || current.Grant.AuthorityID != original.Grant.AuthorityID || current.Grant.ComputerID != original.Grant.ComputerID || current.Grant.ComputerGeneration != original.Grant.ComputerGeneration || snapshot.Approval.Generation != s.selection.Snapshot.Approval.Generation || snapshot.Approval.ComputerID != s.selection.Snapshot.Approval.ComputerID {
		return false
	}
	before, err := compileSeatbelt(s.selection, command)
	if err != nil {
		return false
	}
	selection := s.selection
	selection.Snapshot = snapshot
	after, err := compileSeatbelt(selection, command)
	return err == nil && before.digest == after.digest
}

func (p *Preparer) MatchesPolicy(snapshot port.AccessSnapshot) bool {
	selected, ok := p.qualification.(*Seatbelt)
	return ok && selected.matchesPolicy(p.template, snapshot)
}
func (p *Prepared) MatchesPolicy(snapshot port.AccessSnapshot) bool {
	if parent, ok := p.boundary.(*parentBoundary); ok {
		return parent.policy.matchesPolicy(p.command, snapshot)
	}
	native, ok := p.boundary.(nativeBoundary)
	if !ok {
		return false
	}
	selected, ok := native.qualification.(*Seatbelt)
	return ok && selected.matchesPolicy(p.command, snapshot)
}

var _ processsvc.PolicyBound = (*Preparer)(nil)
var _ processsvc.PolicyBound = (*Prepared)(nil)
