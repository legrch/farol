package process

import (
	"context"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"os"
	"path/filepath"
	"slices"
	"strings"
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
		return nil, &processsvc.NativeFailure{Reason: processsvc.RefusalConfinementPolicy}
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
		return nil, &processsvc.NativeFailure{Reason: processsvc.RefusalConfinementPolicy}
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
	refuse := func() ([]gitReadDirectory, error) {
		return nil, &processsvc.NativeFailure{Reason: processsvc.RefusalConfinementPolicy}
	}
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

const gitRuntimeImage = "/Library/Developer/CommandLineTools/usr/bin/git"
const gitRuntimeData = "/Library/Developer/CommandLineTools/usr/share/git-core"
const gitRuntimeAttributes = gitRuntimeData + "/gitattributes"
const gitRuntimeTemplates = gitRuntimeData + "/templates"

// GitRuntimeResources is trusted build input, not a command or workspace grant.
// Selected CLT Git data and optional finite CLT Python dependencies only.
type GitRuntimeResources struct {
	Git         ExecutablePin
	Files       []ExecutablePin
	Directories []GitRuntimeDirectory
	Python      *PythonRuntimeResources `json:",omitempty"`
}
type GitRuntimeDirectory struct {
	Path    string
	Entries []string
}

func cloneGitRuntime(r *GitRuntimeResources) *GitRuntimeResources {
	if r == nil {
		return nil
	}
	c := *r
	c.Python = clonePythonRuntime(r.Python)
	c.Files = slices.Clone(r.Files)
	c.Directories = slices.Clone(r.Directories)
	for i := range c.Directories {
		c.Directories[i].Entries = slices.Clone(c.Directories[i].Entries)
	}
	return &c
}
func sameGitRuntime(a, b *GitRuntimeResources) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Git == b.Git && samePythonRuntime(a.Python, b.Python) && slices.Equal(a.Files, b.Files) &&
		slices.EqualFunc(a.Directories, b.Directories, func(x, y GitRuntimeDirectory) bool {
			return x.Path == y.Path && slices.Equal(x.Entries, y.Entries)
		})
}
func validGitRuntime(r *GitRuntimeResources, executables []ExecutablePin) bool {
	if r == nil {
		return true
	}
	if !validPythonRuntime(r.Python, executables) || r.Git.Path != gitRuntimeImage || !digestValue(r.Git.SHA256) || r.Git.SHA256 == strings.Repeat("0", 64) || !slices.Contains(executables, r.Git) ||
		len(r.Files) < 2 || len(r.Files) > 32 || len(r.Directories) < 1 || len(r.Directories) > 8 {
		return false
	}
	paths := map[string]bool{}
	last := ""
	for _, file := range r.Files {
		if !absolutePolicyPath(file.Path) || !digestValue(file.SHA256) ||
			file.SHA256 == strings.Repeat("0", 64) || file.Path <= last ||
			(file.Path != gitRuntimeData+"/gitconfig" && file.Path != gitRuntimeAttributes && !insidePolicy(gitRuntimeTemplates, file.Path)) {
			return false
		}
		paths[file.Path], last = true, file.Path
	}
	if !paths[gitRuntimeData+"/gitconfig"] {
		return false
	}
	last = ""
	for _, dir := range r.Directories {
		if !absolutePolicyPath(dir.Path) || !insidePolicy(gitRuntimeTemplates, dir.Path) ||
			dir.Path <= last || paths[dir.Path] || len(dir.Entries) > 32 {
			return false
		}
		last = dir.Path
		paths[dir.Path] = true
	}
	if !paths[gitRuntimeTemplates] {
		return false
	}
	// The declaration is a complete finite tree, not an extensible directory grant.
	for _, dir := range r.Directories {
		last = ""
		for _, name := range dir.Entries {
			if name == "" || name == "." || name == ".." || len(name) > 128 || name <= last ||
				!absolutePolicyPath(filepath.Join(dir.Path, name)) || filepath.Base(name) != name ||
				!paths[filepath.Join(dir.Path, name)] {
				return false
			}
			for _, c := range name {
				if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
					return false
				}
			}
			if name[0] == '.' || name[0] == '_' || name[0] == '-' {
				return false
			}
			last = name
		}
	}
	for path := range paths {
		if path == gitRuntimeData+"/gitconfig" || path == gitRuntimeAttributes || path == gitRuntimeTemplates {
			continue
		}
		parent := filepath.Dir(path)
		found := false
		for _, dir := range r.Directories {
			if dir.Path == parent && slices.Contains(dir.Entries, filepath.Base(path)) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

type gitRuntimeDirectoryFacts struct {
	platform          platformDirectoryFacts
	mode              os.FileMode
	uid               uint32
	entries           string
	modified, changed string
}
type gitRuntimeFactPort interface {
	gitRuntimeFile(context.Context, string) (platformFileFacts, error)
	gitRuntimeDirectory(context.Context, string) (gitRuntimeDirectoryFacts, error)
}
type gitRuntimeObservation struct {
	files       []platformFileFacts
	directories []gitRuntimeDirectoryFacts
	alias       *pythonAliasFacts
}

func sameGitRuntimeObservation(a, b *gitRuntimeObservation) bool {
	if a == nil || b == nil {
		return a == b
	}
	return slices.Equal(a.files, b.files) && slices.Equal(a.directories, b.directories) && samePythonAlias(a.alias, b.alias)
}
func (s *RootScopedPlatformStrategy) observeGitRuntime(ctx context.Context) (*gitRuntimeObservation, error) {
	refuse := func() (*gitRuntimeObservation, error) {
		return nil, &processsvc.NativeFailure{Reason: processsvc.RefusalRuntimeIntegrity}
	}
	if s == nil || s.frozen == nil || ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	r := s.frozen.descriptor.GitRuntimeResources
	if r == nil {
		return nil, nil
	}
	reader, ok := s.frozen.facts.(gitRuntimeFactPort)
	if !ok || ctx == nil || ctx.Err() != nil {
		return refuse()
	}
	out := &gitRuntimeObservation{}
	for _, file := range r.resourceFiles() {
		f, err := reader.gitRuntimeFile(ctx, file.Path)
		if err != nil || f.path != file.Path || f.sha256 != file.SHA256 || f.uid != 0 ||
			!f.mode.IsRegular() || f.mode.Perm()&0022 != 0 || f.links != 1 ||
			f.size < 0 || f.size > gitResourceMaximum(file.Path) || f.identity.Device == "" || f.identity.Inode == "" {
			return refuse()
		}
		out.files = append(out.files, f)
	}
	for _, dir := range r.resourceDirectories() {
		f, err := reader.gitRuntimeDirectory(ctx, dir.Path)
		p := f.platform
		if err != nil || p.path != dir.Path || p.filesystem != "apfs" || !p.local || p.nested ||
			(p.mount != "/" && p.mount != dataVolumePath) || !f.mode.IsDir() || f.mode.Perm()&0022 != 0 ||
			f.uid != 0 || p.identity.Device == "" || p.identity.Inode == "" ||
			f.entries != strings.Join(dir.Entries, "\n") {
			return refuse()
		}
		out.directories = append(out.directories, f)
	}
	if r.Python != nil {
		reader, ok := s.frozen.facts.(interface {
			pythonAlias(context.Context) (pythonAliasFacts, error)
		})
		if !ok {
			return refuse()
		}
		alias, err := reader.pythonAlias(ctx)
		if err != nil {
			return refuse()
		}
		out.alias = &alias
	}
	if ctx.Err() != nil {
		return refuse()
	}
	return out, nil
}
