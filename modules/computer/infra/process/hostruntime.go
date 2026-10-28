package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const InstalledHostRuntimeAssurance = "installed-host-runtime-v1"
const hostRuntimeScriptType uint32 = 0xffffffff

var errHostRuntime = errors.New("HOST_RUNTIME_UNQUALIFIED")
var errHostRuntimeSharedWritable = errors.New("HOST_RUNTIME_SHARED_WRITABLE")

const hostRuntimeMaxNodes = 8192
const hostRuntimeMaxBytes int64 = 384 << 20

// This plan is created only by the native owner, never from a renderer, MCP
// request or ambient PATH. A mutable installed environment has a distinct
// assurance from the release-qualified base; it promises neither protected
// ancestry nor atomic execution against another process of the same account.
type HostRuntimePlan struct{ frozen *hostRuntimeSnapshot }
type hostRuntimeSnapshot struct {
	Assurance                                                          string
	Installations                                                      []hostRuntimeInstallation
	Nodes                                                              []hostRuntimeNode
	ExecFiles, ReadFiles, ReadTrees, DeniedTrees, Path, MutableParents []string
	GitExecPath, GitTemplateDirectory                                  string
	Unavailable                                                        []hostRuntimeUnavailable
}
type hostRuntimeUnavailable struct{ Kind, Code string }

type hostRuntimeInstallation struct{ Kind, Root, Image string }
type hostRuntimeNode struct {
	Path, Kind, Device, Inode, Modified, Changed, SHA256, LinkTarget string
	UID, GID                                                         uint32
	Mode                                                             os.FileMode
	Size                                                             int64
	Links                                                            uint64
	Listed                                                           bool
	Entries                                                          []string
}
type hostRuntimeFilesystem interface {
	resolve(context.Context, string) (string, error)
	node(context.Context, string) (hostRuntimeNode, error)
	entries(context.Context, string) ([]string, error)
	imports(context.Context, string) (hostMachOImports, bool, error)
	uid() uint32
}
type hostRuntimeLayout struct {
	kind, alias, root string
	trees             []string
}
type hostRuntimeBuilder struct {
	context        context.Context
	fs             hostRuntimeFilesystem
	snapshot       hostRuntimeSnapshot
	nodes          map[string]hostRuntimeNode
	visited        map[string]bool
	bytes          int64
	mainExecutable string
}

func (p *HostRuntimePlan) MarshalJSON() ([]byte, error) {
	if p == nil || p.frozen == nil {
		return nil, errHostRuntime
	}
	return json.Marshal(p.frozen)
}
func cloneHostRuntime(p *HostRuntimePlan) *HostRuntimePlan {
	if p == nil {
		return nil
	}
	if p.frozen == nil {
		return &HostRuntimePlan{}
	}
	bytes, err := json.Marshal(p.frozen)
	if err != nil {
		return &HostRuntimePlan{}
	}
	var snapshot hostRuntimeSnapshot
	if json.Unmarshal(bytes, &snapshot) != nil {
		return &HostRuntimePlan{}
	}
	return &HostRuntimePlan{&snapshot}
}
func sameHostRuntime(a, b *HostRuntimePlan) bool {
	if a == nil || b == nil {
		return a == b
	}
	aa, e := a.MarshalJSON()
	bb, f := b.MarshalJSON()
	return e == nil && f == nil && string(aa) == string(bb)
}
func (p *HostRuntimePlan) valid() bool {
	if p == nil || p.frozen == nil || p.frozen.Assurance != InstalledHostRuntimeAssurance || len(p.frozen.Nodes) > hostRuntimeMaxNodes {
		return false
	}
	nodes := map[string]hostRuntimeNode{}
	last := ""
	for _, n := range p.frozen.Nodes {
		if !absolutePolicyPath(n.Path) || n.Path <= last || n.Device == "" || n.Inode == "" {
			return false
		}
		nodes[n.Path], last = n, n.Path
	}
	for _, paths := range [][]string{p.frozen.ReadFiles, p.frozen.ExecFiles, p.frozen.ReadTrees, p.frozen.DeniedTrees, p.frozen.Path, p.frozen.MutableParents} {
		if len(paths) > hostRuntimeMaxNodes {
			return false
		}
		seen := map[string]bool{}
		for _, path := range paths {
			if !absolutePolicyPath(path) || seen[path] {
				return false
			}
			seen[path] = true
		}
	}
	for _, path := range p.frozen.ReadFiles {
		if n, ok := nodes[path]; !ok || n.Kind != "file" || !digestValue(n.SHA256) {
			return false
		}
	}
	for _, path := range p.frozen.ExecFiles {
		if n, ok := nodes[path]; !ok || n.Kind != "file" || n.Mode.Perm()&0111 == 0 || !slices.Contains(p.frozen.ReadFiles, path) {
			return false
		}
	}
	for _, path := range p.frozen.ReadTrees {
		if n, ok := nodes[path]; !ok || n.Kind != "directory" || !n.Listed {
			return false
		}
	}
	for _, path := range p.frozen.Path {
		if n, ok := nodes[path]; !ok || n.Kind != "directory" {
			return false
		}
	}
	for _, installation := range p.frozen.Installations {
		if (installation.Kind != "git" && installation.Kind != "python") || !absolutePolicyPath(installation.Root) || !insidePolicy(installation.Root, installation.Image) || !slices.Contains(p.frozen.ExecFiles, installation.Image) {
			return false
		}
	}
	for _, path := range []string{p.frozen.GitExecPath, p.frozen.GitTemplateDirectory} {
		if path != "" {
			if n, ok := nodes[path]; !ok || n.Kind != "directory" || !n.Listed {
				return false
			}
		}
	}
	return true
}
func (p *HostRuntimePlan) recheck(ctx context.Context, fs hostRuntimeFilesystem) error {
	if !p.valid() || ctx == nil || ctx.Err() != nil || fs == nil {
		return errHostRuntime
	}
	for _, before := range p.frozen.Nodes {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		after, err := fs.node(ctx, before.Path)
		if err != nil {
			return errHostRuntime
		}
		if before.Listed {
			entries, err := fs.entries(ctx, before.Path)
			if err != nil {
				return errHostRuntime
			}
			slices.Sort(entries)
			after.Listed = true
			after.Entries = entries
		}
		aa, err := json.Marshal(before)
		bb, other := json.Marshal(after)
		if err != nil || other != nil || string(aa) != string(bb) {
			return errHostRuntime
		}
	}
	return ctx.Err()
}
func newHostRuntimeBuilder(ctx context.Context, fs hostRuntimeFilesystem) *hostRuntimeBuilder {
	return &hostRuntimeBuilder{context: ctx, fs: fs, snapshot: hostRuntimeSnapshot{Assurance: InstalledHostRuntimeAssurance}, nodes: map[string]hostRuntimeNode{}, visited: map[string]bool{}}
}
func (b *hostRuntimeBuilder) check() error {
	if b.context == nil || b.context.Err() != nil || b.fs == nil || len(b.nodes) > hostRuntimeMaxNodes || len(b.visited) > hostRuntimeMaxNodes*2 || b.bytes > hostRuntimeMaxBytes {
		return errHostRuntime
	}
	return nil
}
func (b *hostRuntimeBuilder) observe(p string) (hostRuntimeNode, error) {
	if b.check() != nil || !absolutePolicyPath(p) {
		return hostRuntimeNode{}, errHostRuntime
	}
	if previous, ok := b.nodes[p]; ok {
		return previous, nil
	}
	n, err := b.fs.node(b.context, p)
	if err != nil {
		return n, err
	}
	if n.Path != p || n.Device == "" || n.Inode == "" || (n.UID != 0 && n.UID != b.fs.uid()) || (n.Kind != "alias" && n.Mode.Perm()&0002 != 0) {
		return n, errHostRuntime
	}
	switch n.Kind {
	case "file":
		if !n.Mode.IsRegular() || n.Mode.Perm()&0022 != 0 || n.Mode&(os.ModeSetuid|os.ModeSetgid) != 0 || n.Size < 0 || n.Size > 128<<20 || !digestValue(n.SHA256) || n.Links < 1 {
			return n, errHostRuntime
		}
		b.bytes += n.Size
	case "directory":
		// A different account in the directory's group could replace a selected
		// executable after recheck and before the shell opens it. The accepted
		// mutable-runtime contract covers the owner's own account, not other
		// accounts with access through a shared group.
		if !n.Mode.IsDir() {
			return n, errHostRuntime
		}
		if n.Mode.Perm()&0020 != 0 {
			return n, errHostRuntimeSharedWritable
		}
	case "alias":
		if n.Mode&os.ModeSymlink == 0 || n.Links != 1 || n.LinkTarget == "" || strings.ContainsRune(n.LinkTarget, 0) {
			return n, errHostRuntime
		}
	default:
		return n, errHostRuntime
	}
	b.nodes[p] = n
	if b.check() != nil {
		return n, errHostRuntime
	}
	return n, nil
}
func (b *hostRuntimeBuilder) physical(p string, boundaries []string) (string, error) {
	if b.check() != nil || !absolutePolicyPath(p) {
		return "", errHostRuntime
	}
	allowed := func(value string) bool {
		return slices.ContainsFunc(boundaries, func(root string) bool { return value == root || insidePolicy(root, value) })
	}
	logical := allowed(p)
	for _, prefix := range []string{"/opt/homebrew", "/usr/local"} {
		if slices.Contains(boundaries, prefix+"/Cellar") && insidePolicy(prefix, p) {
			logical = true
		}
	}
	if !logical {
		return "", errHostRuntime
	}
	remaining := strings.Split(strings.TrimPrefix(p, "/"), "/")
	current := "/"
	hops := 0
	for len(remaining) > 0 {
		if b.check() != nil {
			return "", errHostRuntime
		}
		next := filepath.Join(current, remaining[0])
		remaining = remaining[1:]
		n, err := b.observe(next)
		if err != nil {
			return "", err
		}
		if n.Kind == "alias" {
			hops++
			if hops > 32 {
				return "", errHostRuntime
			}
			target := n.LinkTarget
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(next), target)
			}
			target = filepath.Clean(target)
			full := filepath.Join(append([]string{target}, remaining...)...)
			if !allowed(full) {
				return "", errHostRuntime
			}
			remaining = strings.Split(strings.TrimPrefix(full, "/"), "/")
			current = "/"
			continue
		}
		if len(remaining) > 0 && n.Kind != "directory" {
			return "", errHostRuntime
		}
		current = next
	}
	if !allowed(current) {
		return "", errHostRuntime
	}
	actual, err := b.fs.resolve(b.context, p)
	if err != nil || actual != current {
		return "", errHostRuntime
	}
	return current, nil
}

func hostRuntimeForbiddenTree(p string) bool {
	for _, part := range strings.Split(p, "/") {
		if part == "site-packages" || part == ".git" {
			return true
		}
	}
	return false
}
func (b *hostRuntimeBuilder) tree(p string, boundaries []string, depth int) error {
	if depth > 24 || b.check() != nil {
		return errHostRuntime
	}
	physical, err := b.physical(p, boundaries)
	if err != nil {
		return err
	}
	n := b.nodes[physical]
	if n.Kind == "file" {
		return b.file(physical, boundaries)
	}
	if n.Kind != "directory" {
		return errHostRuntime
	}
	if b.visited[physical] {
		return nil
	}
	b.visited[physical] = true
	entries, err := b.fs.entries(b.context, physical)
	if err != nil || len(entries) > 2048 {
		return errHostRuntime
	}
	slices.Sort(entries)
	n.Listed = true
	n.Entries = slices.Clone(entries)
	b.nodes[physical] = n
	for _, name := range entries {
		if name == "" || name == "." || name == ".." || filepath.Base(name) != name || !absolutePolicyPath(filepath.Join(physical, name)) {
			return errHostRuntime
		}
		child := filepath.Join(physical, name)
		if hostRuntimeForbiddenTree(child) {
			b.snapshot.DeniedTrees = append(b.snapshot.DeniedTrees, child)
			continue
		}
		if err := b.tree(child, boundaries, depth+1); err != nil {
			return err
		}
	}
	return b.check()
}
func (b *hostRuntimeBuilder) file(p string, boundaries []string) error {
	return b.fileForExecutable(p, boundaries, b.mainExecutable)
}
func (b *hostRuntimeBuilder) fileForExecutable(p string, boundaries []string, executable string) error {
	if b.check() != nil {
		return errHostRuntime
	}
	n, ok := b.nodes[p]
	if !ok || n.Kind != "file" {
		return errHostRuntime
	}
	imports, macho, err := b.fs.imports(b.context, p)
	if err != nil {
		return err
	}
	if macho && imports.fileType == 2 {
		executable = p
	}
	key := "file:" + p + "\x00" + executable
	if b.visited[key] {
		return nil
	}
	b.visited[key] = true
	b.snapshot.ReadFiles = append(b.snapshot.ReadFiles, p)
	if n.Mode.Perm()&0111 != 0 && ((macho && imports.fileType == 2) || (!macho && imports.fileType == hostRuntimeScriptType)) {
		b.snapshot.ExecFiles = append(b.snapshot.ExecFiles, p)
	}
	for _, library := range imports.libraries {
		if filepath.IsAbs(library) && !absolutePolicyPath(library) {
			return errHostRuntime
		}
		if strings.HasPrefix(library, "/usr/lib/") || strings.HasPrefix(library, "/System/Library/") {
			continue
		}
		selected, err := b.resolveLibrary(p, library, imports.rpaths, boundaries, executable)
		if err != nil {
			return err
		}
		if err := b.fileForExecutable(selected, boundaries, executable); err != nil {
			return err
		}
	}
	return nil
}

func (b *hostRuntimeBuilder) resolveLibrary(loader, name string, rpaths, boundaries []string, executable string) (string, error) {
	expand := func(value string) (string, error) {
		if strings.HasPrefix(value, "@loader_path/") {
			return filepath.Clean(filepath.Join(filepath.Dir(loader), strings.TrimPrefix(value, "@loader_path/"))), nil
		}
		if strings.HasPrefix(value, "@executable_path/") && absolutePolicyPath(executable) {
			return filepath.Clean(filepath.Join(filepath.Dir(executable), strings.TrimPrefix(value, "@executable_path/"))), nil
		}
		if filepath.IsAbs(value) {
			return filepath.Clean(value), nil
		}
		// @executable_path/dlopen needs a separately known loading context; never guess.
		return "", errHostRuntime
	}
	var candidates []string
	if strings.HasPrefix(name, "@rpath/") {
		if len(rpaths) > 32 {
			return "", errHostRuntime
		}
		for _, root := range rpaths {
			p, err := expand(root)
			if err != nil {
				return "", err
			}
			candidates = append(candidates, filepath.Join(p, strings.TrimPrefix(name, "@rpath/")))
		}
	} else {
		p, err := expand(name)
		if err != nil {
			return "", err
		}
		candidates = append(candidates, p)
	}
	selected := ""
	for _, candidate := range candidates {
		p, err := b.physical(candidate, boundaries)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if b.nodes[p].Kind != "file" {
			return "", errHostRuntime
		}
		if selected != "" && selected != p {
			return "", errHostRuntime
		}
		selected = p
	}
	if selected == "" {
		return "", errHostRuntime
	}
	return selected, nil
}
func (b *hostRuntimeBuilder) finish() (*HostRuntimePlan, error) {
	if b.check() != nil {
		return nil, errHostRuntime
	}
	links := map[string]uint64{}
	identities := map[string]hostRuntimeNode{}
	for _, n := range b.nodes {
		if n.Kind == "file" {
			key := n.Device + ":" + n.Inode
			if before, exists := identities[key]; exists {
				before.Path = n.Path
				aa, _ := json.Marshal(before)
				bb, _ := json.Marshal(n)
				if string(aa) != string(bb) {
					return nil, errHostRuntime
				}
			}
			identities[key] = n
			links[key]++
		}
	}
	for _, n := range b.nodes {
		if n.Kind == "file" && n.Links != links[n.Device+":"+n.Inode] {
			return nil, errHostRuntime
		}
		b.snapshot.Nodes = append(b.snapshot.Nodes, n)
	}
	slices.SortFunc(b.snapshot.Nodes, func(a, c hostRuntimeNode) int { return strings.Compare(a.Path, c.Path) })
	b.snapshot.ExecFiles = sortedUnique(b.snapshot.ExecFiles)
	b.snapshot.ReadFiles = sortedUnique(b.snapshot.ReadFiles)
	b.snapshot.ReadTrees = sortedUnique(b.snapshot.ReadTrees)
	b.snapshot.DeniedTrees = sortedUnique(b.snapshot.DeniedTrees)
	b.snapshot.MutableParents = sortedUnique(b.snapshot.MutableParents)
	p := &HostRuntimePlan{&b.snapshot}
	if p.recheck(b.context, b.fs) != nil {
		return nil, errHostRuntime
	}
	return p, nil
}
func sortedUnique(values []string) []string { slices.Sort(values); return slices.Compact(values) }
func (p *HostRuntimePlan) digest() string {
	bytes, err := p.MarshalJSON()
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(bytes)
	return hex.EncodeToString(sum[:])
}

func hostRuntimeCandidates(kind string) []string {
	if kind == "git" {
		return []string{"/opt/homebrew/bin/git", "/usr/local/bin/git", "/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git"}
	}
	return []string{"/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/Current/bin/python3", "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/Current/bin/python3"}
}
func hostRuntimeLayoutFor(kind, alias, physical string) (hostRuntimeLayout, []string, error) {
	for _, prefix := range []string{"/opt/homebrew", "/usr/local"} {
		base := prefix + "/Cellar/"
		if !strings.HasPrefix(physical, base) {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(physical, base), "/")
		if len(parts) < 4 || parts[0] == "" || parts[1] == "" || strings.HasPrefix(parts[1], ".") {
			return hostRuntimeLayout{}, nil, errHostRuntime
		}
		keg := filepath.Join(base, parts[0], parts[1])
		boundaries := []string{prefix + "/Cellar"}
		if kind == "git" && parts[0] == "git" && physical == keg+"/bin/git" {
			return hostRuntimeLayout{kind: kind, alias: alias, root: keg, trees: []string{keg + "/libexec/git-core", keg + "/share/git-core/templates"}}, boundaries, nil
		}
		if kind == "python" && strings.HasPrefix(parts[0], "python") {
			root, version, ok := hostPythonRoot(physical, "/Python.framework/Versions/")
			if ok {
				return hostRuntimeLayout{kind: kind, alias: alias, root: root, trees: []string{root + "/bin", root + "/lib/python" + version, root + "/Resources"}}, boundaries, nil
			}
		}
		return hostRuntimeLayout{}, nil, errHostRuntime
	}
	for _, root := range []string{"/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"} {
		if kind == "git" && physical == root+"/usr/bin/git" {
			return hostRuntimeLayout{kind: kind, alias: alias, root: root + "/usr", trees: []string{root + "/usr/libexec/git-core", root + "/usr/share/git-core/templates"}}, []string{root}, nil
		}
		if kind == "python" && strings.HasPrefix(physical, root+"/Library/Frameworks/Python3.framework/Versions/") {
			selected, version, ok := hostPythonRoot(physical, "/Python3.framework/Versions/")
			if ok {
				return hostRuntimeLayout{kind: kind, alias: alias, root: selected, trees: []string{selected + "/bin", selected + "/lib/python" + version, selected + "/Resources"}}, []string{root}, nil
			}
		}
	}
	return hostRuntimeLayout{}, nil, errHostRuntime
}
func hostPythonRoot(p, marker string) (string, string, bool) {
	at := strings.Index(p, marker)
	if at < 0 {
		return "", "", false
	}
	suffix := p[at+len(marker):]
	parts := strings.Split(suffix, "/")
	if len(parts) != 3 || parts[1] != "bin" || parts[2] != "python"+parts[0] {
		return "", "", false
	}
	version := parts[0]
	numbers := strings.Split(version, ".")
	if len(numbers) != 2 || numbers[0] != "3" || numbers[1] == "" {
		return "", "", false
	}
	for _, c := range numbers[1] {
		if c < '0' || c > '9' {
			return "", "", false
		}
	}
	return p[:at+len(marker)] + version, version, true
}
func discoverHostRuntime(ctx context.Context, fs hostRuntimeFilesystem) (*HostRuntimePlan, error) {
	if ctx == nil || ctx.Err() != nil || fs == nil {
		return nil, errHostRuntime
	}
	aggregate := newHostRuntimeBuilder(ctx, fs)
	for _, kind := range []string{"git", "python"} {
		found := false
		skippedSharedWritable := false
		for _, alias := range hostRuntimeCandidates(kind) {
			physical, err := fs.resolve(ctx, alias)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			found = true
			if err != nil {
				skippedSharedWritable = false
				aggregate.snapshot.Unavailable = append(aggregate.snapshot.Unavailable, hostRuntimeUnavailable{kind, "HOST_RUNTIME_DISCOVERY_UNAVAILABLE"})
				break
			}
			layout, boundaries, err := hostRuntimeLayoutFor(kind, alias, physical)
			if err != nil {
				skippedSharedWritable = false
				aggregate.snapshot.Unavailable = append(aggregate.snapshot.Unavailable, hostRuntimeUnavailable{kind, "HOST_RUNTIME_LAYOUT_UNSUPPORTED"})
				break
			}
			selected := newHostRuntimeBuilder(ctx, fs)
			selected.mainExecutable = physical
			image, err := selected.physical(alias, boundaries)
			if err == nil {
				imports, macho, e := fs.imports(ctx, image)
				if e != nil || !macho || imports.fileType != 2 || selected.nodes[image].Mode.Perm()&0111 == 0 {
					err = errHostRuntime
				}
			}
			if err == nil {
				err = selected.file(image, boundaries)
			}
			for _, tree := range layout.trees {
				if err == nil {
					err = selected.tree(tree, boundaries, 0)
					if err == nil {
						physicalTree, e := selected.physical(tree, boundaries)
						if e != nil {
							err = e
						} else {
							selected.snapshot.ReadTrees = append(selected.snapshot.ReadTrees, physicalTree)
						}
					}
				}
			}
			var plan *HostRuntimePlan
			if err == nil {
				plan, err = selected.finish()
			}
			if err != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				if errors.Is(err, errHostRuntimeSharedWritable) {
					skippedSharedWritable = true
					continue
				}
				skippedSharedWritable = false
				aggregate.snapshot.Unavailable = append(aggregate.snapshot.Unavailable, hostRuntimeUnavailable{kind, "HOST_RUNTIME_QUALIFICATION_UNAVAILABLE"})
				break
			}
			for p, n := range selected.nodes {
				if previous, ok := aggregate.nodes[p]; ok {
					a, _ := json.Marshal(previous)
					c, _ := json.Marshal(n)
					if string(a) != string(c) {
						return nil, errHostRuntime
					}
				} else {
					aggregate.nodes[p] = n
					if n.Kind == "file" {
						aggregate.bytes += n.Size
					}
				}
			}
			aggregate.snapshot.Installations = append(aggregate.snapshot.Installations, hostRuntimeInstallation{kind, layout.root, image})
			aggregate.snapshot.ReadFiles = append(aggregate.snapshot.ReadFiles, plan.frozen.ReadFiles...)
			aggregate.snapshot.ReadTrees = append(aggregate.snapshot.ReadTrees, plan.frozen.ReadTrees...)
			aggregate.snapshot.DeniedTrees = append(aggregate.snapshot.DeniedTrees, plan.frozen.DeniedTrees...)
			aggregate.snapshot.ExecFiles = append(aggregate.snapshot.ExecFiles, plan.frozen.ExecFiles...)
			aggregate.snapshot.MutableParents = append(aggregate.snapshot.MutableParents, plan.frozen.MutableParents...)
			aggregate.snapshot.Path = append(aggregate.snapshot.Path, filepath.Dir(image))
			if kind == "git" {
				aggregate.snapshot.GitExecPath = layout.root + "/libexec/git-core"
				aggregate.snapshot.GitTemplateDirectory = layout.root + "/share/git-core/templates"
			}
			skippedSharedWritable = false
			break
		}
		if !found {
			aggregate.snapshot.Unavailable = append(aggregate.snapshot.Unavailable, hostRuntimeUnavailable{kind, "HOST_RUNTIME_NOT_INSTALLED"})
		} else if skippedSharedWritable {
			aggregate.snapshot.Unavailable = append(aggregate.snapshot.Unavailable, hostRuntimeUnavailable{kind, "HOST_RUNTIME_QUALIFICATION_UNAVAILABLE"})
		}
	}
	return aggregate.finish()
}
