package process

import (
	"slices"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// QualifiedGitRead is an opt-in strict, read-only selection, not a native
// certificate. It retains protected-object qualification and uses only roots
// already approved by BOTH owners. It does not reinterpret approved-roots-v1.
const QualifiedGitRead GitPolicy = "qualified-read"

// GitReadSelection is trusted root input, never discovery/admission from argv or
// a .git pointer. Root measures these identities in its separately scheduled
// lane. Compilation and preflight cannot certify effective object confinement.
type GitReadSelection struct {
	Executable, Worktree, GitDirectory, CommonDirectory             string
	WorktreeIdentity, GitDirectoryIdentity, CommonDirectoryIdentity authority.RootIdentity
}

type GitReadView string

const (
	GitReadStatus     GitReadView = "status"
	GitReadDiff       GitReadView = "diff"
	GitReadStagedDiff GitReadView = "staged-diff"
)

// GitReadArguments constructs one closed view for the existing Prepare contract.
// Normal config, hooks and configured tools remain subject to the same scope;
// pager suppression bounds output transport and optional index locks stay off.
func GitReadArguments(s GitReadSelection, view GitReadView) ([]string, error) {
	if !validGitReadSelection(s) {
		return nil, &processsvc.NativeFailure{}
	}
	args := []string{"--no-pager", "--git-dir=" + s.GitDirectory, "--work-tree=" + s.Worktree}
	switch view {
	case GitReadStatus:
		return append(args, "status", "--porcelain=v1", "-z"), nil
	case GitReadDiff:
		return append(args, "diff", "--no-color", "--"), nil
	case GitReadStagedDiff:
		return append(args, "diff", "--cached", "--no-color", "--"), nil
	default:
		return nil, &processsvc.NativeFailure{}
	}
}

func validGitReadSelection(s GitReadSelection) bool {
	for _, path := range []string{s.Executable, s.Worktree, s.GitDirectory, s.CommonDirectory} {
		if !absolutePolicyPath(path) {
			return false
		}
	}
	for _, identity := range []authority.RootIdentity{s.WorktreeIdentity, s.GitDirectoryIdentity, s.CommonDirectoryIdentity} {
		if identity.Device == "" || identity.Inode == "" {
			return false
		}
	}
	return s.GitDirectory != s.Worktree && s.CommonDirectory != s.Worktree &&
		(s.GitDirectory != s.CommonDirectory || s.GitDirectoryIdentity == s.CommonDirectoryIdentity)
}

// The seal holds the exact directory identities as well as the approved ancestor
// used for descriptor-relative preflight. No path adds a read/exec/write rule.
type gitReadDirectory struct {
	ApprovedRoot, Path string
	Identity           authority.RootIdentity
}

func gitReadBindings(s SeatbeltSelection, command Command, roots []rootScopeBinding) ([]gitReadDirectory, error) {
	refuse := func() ([]gitReadDirectory, error) { return nil, &processsvc.NativeFailure{} }
	g := s.GitRead
	if g == nil || !validGitReadSelection(*g) || command.Write || len(command.Input) != 0 ||
		command.Executable != g.Executable || command.Cwd != g.Worktree {
		return refuse()
	}
	w, found := authority.FindApproved(*s.Snapshot.Approval, s.WorkspaceID)
	scope, scoped := authority.FindScope(s.Snapshot.Participant.Grant, s.WorkspaceID)
	if !found || !scoped || !w.GitHistoryApproved || w.GitMetadata == nil || scope.Root != g.Worktree ||
		w.GitMetadata.GitDirectory != g.GitDirectory || w.GitMetadata.CommonDirectory != g.CommonDirectory {
		return refuse()
	}
	// Empty unbound input is the existing trusted preparer template only. Native
	// selectedLaunch still requires an invocation binding and a sealed command.
	if command.Binding == nil {
		if len(command.Args) != 0 {
			return refuse()
		}
	} else {
		matched := false
		for _, view := range []GitReadView{GitReadStatus, GitReadDiff, GitReadStagedDiff} {
			args, _ := GitReadArguments(*g, view)
			matched = matched || slices.Equal(command.Args, args)
		}
		if !matched {
			return refuse()
		}
	}
	var out []gitReadDirectory
	seen := map[string]bool{}
	for _, directory := range []struct {
		path     string
		identity authority.RootIdentity
	}{
		{g.Worktree, g.WorktreeIdentity}, {g.GitDirectory, g.GitDirectoryIdentity}, {g.CommonDirectory, g.CommonDirectoryIdentity},
	} {
		var ancestor string
		for _, root := range roots {
			if protectedScope(root.ScopeRoot, s.Home) {
				return refuse()
			}
			if insidePolicy(root.ScopeRoot, directory.path) && len(root.ApprovedRoot) > len(ancestor) {
				ancestor = root.ApprovedRoot
			}
		}
		if ancestor == "" || protectedPath(directory.path, s.Home) {
			return refuse()
		}
		if !seen[directory.path] {
			out = append(out, gitReadDirectory{ancestor, directory.path, directory.identity})
			seen[directory.path] = true
		}
	}
	return out, nil
}
