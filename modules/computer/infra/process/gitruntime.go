package process

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

const gitRuntimeImage = "/Library/Developer/CommandLineTools/usr/bin/git"
const gitRuntimeData = "/Library/Developer/CommandLineTools/usr/share/git-core"
const gitRuntimeAttributes = gitRuntimeData + "/gitattributes"
const gitRuntimeTemplates = gitRuntimeData + "/templates"

// GitRuntimeResources is trusted build input, not a command or workspace grant.
// Only the selected CLT Git's ordinary config/attribute/template data is supported here.
type GitRuntimeResources struct {
	Git         ExecutablePin
	Files       []ExecutablePin
	Directories []GitRuntimeDirectory
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
	return a.Git == b.Git && slices.Equal(a.Files, b.Files) &&
		slices.EqualFunc(a.Directories, b.Directories, func(x, y GitRuntimeDirectory) bool {
			return x.Path == y.Path && slices.Equal(x.Entries, y.Entries)
		})
}
func validGitRuntime(r *GitRuntimeResources, executables []ExecutablePin) bool {
	if r == nil {
		return true
	}
	if r.Git.Path != gitRuntimeImage || !digestValue(r.Git.SHA256) || r.Git.SHA256 == strings.Repeat("0", 64) || !slices.Contains(executables, r.Git) ||
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
}

func sameGitRuntimeObservation(a, b *gitRuntimeObservation) bool {
	if a == nil || b == nil {
		return a == b
	}
	return slices.Equal(a.files, b.files) && slices.Equal(a.directories, b.directories)
}
func (s *RootScopedPlatformStrategy) observeGitRuntime(ctx context.Context) (*gitRuntimeObservation, error) {
	refuse := func() (*gitRuntimeObservation, error) { return nil, &processsvc.NativeFailure{} }
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
	for _, file := range r.Files {
		f, err := reader.gitRuntimeFile(ctx, file.Path)
		if err != nil || f.path != file.Path || f.sha256 != file.SHA256 || f.uid != 0 ||
			!f.mode.IsRegular() || f.mode.Perm()&0022 != 0 || f.links != 1 ||
			f.size < 0 || f.size > 256*1024 || f.identity.Device == "" || f.identity.Inode == "" {
			return refuse()
		}
		out.files = append(out.files, f)
	}
	for _, dir := range r.Directories {
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
	if ctx.Err() != nil {
		return refuse()
	}
	return out, nil
}
