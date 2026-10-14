package process

import (
	"context"
	"path/filepath"
	"slices"
	"strings"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

const pythonRuntimeRoot = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9"
const pythonRuntimeLibrary = pythonRuntimeRoot + "/lib/python3.9"
const pythonRuntimeImage = pythonRuntimeRoot + "/bin/python3.9"
const pythonRuntimeLauncher = pythonRuntimeRoot + "/Resources/Python.app/Contents/MacOS/Python"
const pythonRuntimeAlias = pythonRuntimeRoot + "/bin/python3"

// A finite release-qualified CLT standard-library subset. Listings permit import
// discovery only; unlisted file data and external interpreters remain denied.
// Executable images are selected independently in the existing executable pins.
type PythonRuntimeResources struct {
	Files       []ExecutablePin
	Directories []GitRuntimeDirectory
}

func clonePythonRuntime(p *PythonRuntimeResources) *PythonRuntimeResources {
	if p == nil {
		return nil
	}
	c := *p
	c.Files = slices.Clone(p.Files)
	c.Directories = slices.Clone(p.Directories)
	for i := range c.Directories {
		c.Directories[i].Entries = slices.Clone(c.Directories[i].Entries)
	}
	return &c
}
func samePythonRuntime(a, b *PythonRuntimeResources) bool {
	if a == nil || b == nil {
		return a == b
	}
	return slices.Equal(a.Files, b.Files) && slices.EqualFunc(a.Directories, b.Directories, func(a, b GitRuntimeDirectory) bool { return a.Path == b.Path && slices.Equal(a.Entries, b.Entries) })
}
func validPythonRuntime(p *PythonRuntimeResources, images []ExecutablePin) bool {
	if p == nil {
		return true
	}
	if len(p.Files) < 5 || len(p.Files) > 128 || len(p.Directories) < 2 || len(p.Directories) > 16 {
		return false
	}
	for _, required := range []string{pythonRuntimeImage, pythonRuntimeLauncher} {
		if !slices.ContainsFunc(images, func(pin ExecutablePin) bool { return pin.Path == required }) {
			return false
		}
	}
	files := map[string]bool{}
	last := ""
	for _, f := range p.Files {
		if !absolutePolicyPath(f.Path) || f.Path <= last || !digestValue(f.SHA256) || f.SHA256 == strings.Repeat("0", 64) ||
			(f.Path != pythonRuntimeRoot+"/Python3" && (!insidePolicy(pythonRuntimeLibrary, f.Path) || insidePolicy(pythonRuntimeLibrary+"/site-packages", f.Path) || insidePolicy(pythonRuntimeLibrary+"/__pycache__", f.Path) || (!strings.HasSuffix(f.Path, ".py") && !strings.HasSuffix(f.Path, ".so")))) {
			return false
		}
		last = f.Path
		files[f.Path] = true
	}
	for _, required := range []string{pythonRuntimeRoot + "/Python3", pythonRuntimeLibrary + "/encodings/__init__.py", pythonRuntimeLibrary + "/encodings/utf_8.py", pythonRuntimeLibrary + "/codecs.py", pythonRuntimeLibrary + "/os.py"} {
		if !files[required] {
			return false
		}
	}
	dirs := map[string]bool{}
	last = ""
	for _, d := range p.Directories {
		if !absolutePolicyPath(d.Path) || d.Path <= last || len(d.Entries) > 512 ||
			(d.Path != pythonRuntimeRoot+"/bin" && !insidePolicy(pythonRuntimeLibrary, d.Path)) || insidePolicy(pythonRuntimeLibrary+"/site-packages", d.Path) {
			return false
		}
		last = d.Path
		dirs[d.Path] = true
		previous := ""
		for _, name := range d.Entries {
			if name == "" || name == "." || name == ".." || len(name) > 128 || name <= previous || filepath.Base(name) != name {
				return false
			}
			for _, c := range name {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
					return false
				}
			}
			previous = name
		}
	}
	if !dirs[pythonRuntimeRoot+"/bin"] || !dirs[pythonRuntimeLibrary] {
		return false
	}
	for f := range files {
		if f != pythonRuntimeRoot+"/Python3" && !dirs[filepath.Dir(f)] {
			return false
		}
	}
	return true
}
func (r *GitRuntimeResources) resourceFiles() []ExecutablePin {
	if r.Python == nil {
		return r.Files
	}
	return slices.Concat(r.Files, r.Python.Files)
}
func (r *GitRuntimeResources) resourceDirectories() []GitRuntimeDirectory {
	if r.Python == nil {
		return r.Directories
	}
	return slices.Concat(r.Directories, r.Python.Directories)
}
func gitResourceMaximum(path string) int64 {
	if path == pythonRuntimeRoot+"/Python3" {
		return 32 * 1024 * 1024
	}
	return 256 * 1024
}

type pythonAliasFacts struct {
	identity                  authority.RootIdentity
	target, changed, modified string
	uid                       uint32
}

func samePythonAlias(a, b *pythonAliasFacts) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

type pythonAliasMeasurement struct {
	original pythonAliasFacts
	closed   bool
}

func (m *pythonAliasMeasurement) Close() error { m.closed = true; return nil }
func (m *pythonAliasMeasurement) recheck(ctx context.Context) error {
	return recheckPythonAlias(ctx, m)
}
