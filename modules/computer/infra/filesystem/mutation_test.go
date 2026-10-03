package filesystem

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// In-memory inode/descriptor/syscall model. No native filesystem, host process,
// OS clock, Darwin syscall or adversarial confinement proof is exercised here.
type fakeNode struct {
	v        fileVersion
	data     []byte
	children map[string]*fakeNode
}
type fakeMutationFS struct {
	rootNode, work                *fakeNode
	handles                       map[int]*fakeNode
	nextFD                        int
	nextInode                     uint64
	swaps, links, mkdirs, unlinks int
	afterSwap                     func(int)
	beforeSwap                    func(int)
	afterLink                     func()
	onSync                        func(*fakeNode) error
	onMkdir                       func(string) error
	onUnlink                      func(int, string, bool) error
	openFault                     func(int, string, int) error
	readHook                      func(*fakeNode)
	swapFault                     func(int) error
}

func newFakeMutationFS() *fakeMutationFS {
	f := &fakeMutationFS{handles: map[int]*fakeNode{}, nextFD: 10, nextInode: 1}
	f.rootNode = f.directory(0755)
	f.work = f.directory(0700)
	f.rootNode.children["work"] = f.work
	return f
}
func (f *fakeMutationFS) node(mode uint32) *fakeNode {
	n := &fakeNode{v: fileVersion{dev: 7, ino: f.nextInode, mode: mode, uid: 42, links: 1, mtime: 1, ctime: 1}}
	f.nextInode++
	return n
}
func (f *fakeMutationFS) directory(mode uint32) *fakeNode {
	n := f.node(unix.S_IFDIR | mode)
	n.children = map[string]*fakeNode{}
	return n
}
func (f *fakeMutationFS) file(data string) *fakeNode {
	n := f.node(unix.S_IFREG | 0644)
	n.data = []byte(data)
	n.v.size = int64(len(data))
	return n
}
func (f *fakeMutationFS) handle(n *fakeNode) int {
	fd := f.nextFD
	f.nextFD++
	f.handles[fd] = n
	return fd
}
func (f *fakeMutationFS) root() (int, error)    { return f.handle(f.rootNode), nil }
func (f *fakeMutationFS) uid() uint32           { return 42 }
func (f *fakeMutationFS) name() (string, error) { return ".farol-mutation-0123456789abcdef", nil }
func (f *fakeMutationFS) close(fd int)          { delete(f.handles, fd) }
func (f *fakeMutationFS) stat(fd int) (fileVersion, error) {
	if n := f.handles[fd]; n != nil {
		return n.v, nil
	}
	return fileVersion{}, unix.EBADF
}
func (f *fakeMutationFS) lstat(parent int, name string) (fileVersion, error) {
	p := f.handles[parent]
	if p == nil {
		return fileVersion{}, unix.EBADF
	}
	if n := p.children[name]; n != nil {
		return n.v, nil
	}
	return fileVersion{}, unix.ENOENT
}
func (f *fakeMutationFS) open(parent int, name string, flags int, mode uint32) (int, error) {
	if f.openFault != nil {
		if err := f.openFault(parent, name, flags); err != nil {
			return -1, err
		}
	}
	p := f.handles[parent]
	if p == nil || p.children == nil {
		return -1, unix.ENOTDIR
	}
	n := p.children[name]
	if flags&unix.O_CREAT != 0 {
		if n != nil && flags&unix.O_EXCL != 0 {
			return -1, unix.EEXIST
		}
		if n == nil {
			n = f.node(unix.S_IFREG | mode)
			p.children[name] = n
		}
	}
	if n == nil {
		return -1, unix.ENOENT
	}
	if n.v.mode&unix.S_IFMT == unix.S_IFLNK {
		return -1, unix.ELOOP
	}
	if flags&unix.O_DIRECTORY != 0 && n.children == nil {
		return -1, unix.ENOTDIR
	}
	return f.handle(n), nil
}
func (f *fakeMutationFS) read(fd int, limit int) ([]byte, error) {
	n := f.handles[fd]
	if n == nil {
		return nil, unix.EBADF
	}
	if f.readHook != nil {
		f.readHook(n)
	}
	if len(n.data) > limit {
		return nil, errors.New("limit")
	}
	return append([]byte{}, n.data...), nil
}
func (f *fakeMutationFS) write(fd int, data []byte) error {
	n := f.handles[fd]
	n.data = append([]byte{}, data...)
	n.v.size = int64(len(data))
	n.v.mtime++
	n.v.ctime++
	return nil
}
func (f *fakeMutationFS) chmod(fd int, mode uint32) error {
	n := f.handles[fd]
	n.v.mode = n.v.mode&unix.S_IFMT | mode
	n.v.ctime++
	return nil
}
func (f *fakeMutationFS) sync(fd int) error {
	if f.onSync != nil {
		return f.onSync(f.handles[fd])
	}
	return nil
}
func (f *fakeMutationFS) mkdir(parent int, name string, mode uint32) error {
	f.mkdirs++
	if f.onMkdir != nil {
		if err := f.onMkdir(name); err != nil {
			return err
		}
	}
	p := f.handles[parent]
	if p.children[name] != nil {
		return unix.EEXIST
	}
	p.children[name] = f.directory(mode)
	return nil
}
func (f *fakeMutationFS) link(from int, name string, to int, target string) error {
	f.links++
	source, dest := f.handles[from], f.handles[to]
	if dest.children[target] != nil {
		return unix.EEXIST
	}
	n := source.children[name]
	if n == nil {
		return unix.ENOENT
	}
	dest.children[target] = n
	n.v.links++
	n.v.ctime++
	if f.afterLink != nil {
		f.afterLink()
	}
	return nil
}
func (f *fakeMutationFS) swap(from int, name string, to int, target string) error {
	f.swaps++
	if f.beforeSwap != nil {
		f.beforeSwap(f.swaps)
	}
	if f.swapFault != nil {
		if err := f.swapFault(f.swaps); err != nil {
			return err
		}
	}
	source, dest := f.handles[from], f.handles[to]
	a, b := source.children[name], dest.children[target]
	if a == nil || b == nil {
		return unix.ENOENT
	}
	source.children[name], dest.children[target] = b, a
	a.v.ctime++
	b.v.ctime++
	if f.afterSwap != nil {
		f.afterSwap(f.swaps)
	}
	return nil
}
func (f *fakeMutationFS) unlink(parent int, name string, dir bool) error {
	f.unlinks++
	if f.onUnlink != nil {
		if err := f.onUnlink(parent, name, dir); err != nil {
			return err
		}
	}
	p := f.handles[parent]
	n := p.children[name]
	if n == nil {
		return unix.ENOENT
	}
	if dir && len(n.children) > 0 {
		return unix.ENOTEMPTY
	}
	if dir && n.children == nil {
		return unix.ENOTDIR
	}
	delete(p.children, name)
	n.v.links--
	n.v.ctime++
	return nil
}
func fakeRequest(op mutation.Operation) port.MutationRequest {
	return port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work", Root: "/work", ApprovedRoot: port.Root{Path: "/work", Device: "7", Inode: "2"}}, Operation: op, BeforePublish: func(context.Context) error { return nil }}
}
func fakeMutable() (*Mutable, *fakeMutationFS) {
	f := newFakeMutationFS()
	return &Mutable{home: "/home/owner", fs: f}, f
}
func nativeCode(t *testing.T, err error, want string) {
	t.Helper()
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != want {
		t.Fatalf("got %v; want %s", err, want)
	}
}
func stageOf(f *fakeMutationFS) *fakeNode { return f.work.children[".farol-mutation-0123456789abcdef"] }
func TestMutationInjectedCreateReplaceAndEdit(t *testing.T) {
	m, f := fakeMutable()
	ctx := context.Background()
	out, err := m.Mutate(ctx, fakeRequest(mutation.Write{RelativePath: "note.md", Content: "old"}))
	if err != nil || out.Bytes != 3 || out.BeforeSHA256 != nil || f.links != 1 || f.swaps != 0 || string(f.work.children["note.md"].data) != "old" || stageOf(f) != nil {
		t.Fatalf("create %#v %v", out, err)
	}
	hash := payloadHash([]byte("old"))
	f.work.children["note.md"].v.mode = unix.S_IFREG | 0600
	out, err = m.Mutate(ctx, fakeRequest(mutation.Edit{RelativePath: "note.md", ExpectedSHA256: hash, Edits: []mutation.TextEdit{{OldText: "old", NewText: "new"}}}))
	if err != nil || out.Replacements != 1 || out.BeforeSHA256 == nil || *out.BeforeSHA256 != hash || f.swaps != 1 || f.work.children["note.md"].v.mode&0777 != 0600 || stageOf(f) != nil {
		t.Fatalf("edit %#v %v", out, err)
	}
	if len(f.handles) != 0 {
		t.Fatal("leaked injected descriptors")
	}
}
func TestMutationInjectedCreateOnlyHashAbsentAndSpecialFiles(t *testing.T) {
	cases := []struct {
		name, code string
		file       *fakeNode
		op         mutation.Operation
	}{
		{name: "create existing", code: "WORKSPACE_MUTATION_CONFLICT", op: mutation.Write{RelativePath: "note.md", Content: "new"}},
		{name: "wrong hash", code: "WORKSPACE_MUTATION_CONFLICT", op: mutation.Write{RelativePath: "note.md", Content: "new", ExpectedSHA256: ptrHash(strings.Repeat("a", 64))}},
		{name: "edit absent", code: "WORKSPACE_NOT_FOUND", op: mutation.Edit{RelativePath: "note.md", ExpectedSHA256: strings.Repeat("a", 64), Edits: []mutation.TextEdit{{OldText: "old", NewText: "new"}}}},
		{name: "symlink", code: "WORKSPACE_PATH_REFUSED", op: mutation.Write{RelativePath: "note.md", Content: "new"}},
		{name: "hardlink", code: "WORKSPACE_PATH_REFUSED", op: mutation.Write{RelativePath: "note.md", Content: "new"}},
		{name: "FIFO", code: "WORKSPACE_NOT_A_FILE", op: mutation.Write{RelativePath: "note.md", Content: "new"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, f := fakeMutable()
			if c.name != "edit absent" {
				n := f.file("old")
				switch c.name {
				case "symlink":
					n.v.mode = unix.S_IFLNK | 0777
				case "hardlink":
					n.v.links = 2
				case "FIFO":
					n.v.mode = unix.S_IFIFO | 0600
				}
				f.work.children["note.md"] = n
			}
			_, err := m.Mutate(context.Background(), fakeRequest(c.op))
			nativeCode(t, err, c.code)
			if f.links != 0 || f.swaps != 0 || f.mkdirs != 0 {
				t.Fatal("invalid preimage effected")
			}
		})
	}
}
func ptrHash(s string) *string { return &s }
func TestMutationInjectedExclusionsRootParentAndGuard(t *testing.T) {
	for _, path := range []string{".ssh/key", ".git/config", "nested/.git/config", ".ENV", "blocked/note.md"} {
		m, f := fakeMutable()
		r := fakeRequest(mutation.Write{RelativePath: path, Content: "new"})
		r.Workspace.WriteDeniedPaths = []string{"blocked"}
		_, err := m.Mutate(context.Background(), r)
		nativeCode(t, err, "WORKSPACE_PATH_REFUSED")
		if f.mkdirs != 0 {
			t.Fatal("excluded mkdir")
		}
	}
	m, f := fakeMutable()
	r := fakeRequest(mutation.Write{RelativePath: "note.md", Content: "new"})
	r.Workspace.ApprovedRoot.Inode = "99"
	_, err := m.Mutate(context.Background(), r)
	nativeCode(t, err, "WORKSPACE_ROOT_CHANGED")
	if f.mkdirs != 0 {
		t.Fatal("changed root effect")
	}
	m, f = fakeMutable()
	r = fakeRequest(mutation.Write{RelativePath: "note.md", Content: "new"})
	r.BeforePublish = nil
	_, err = m.Mutate(context.Background(), r)
	nativeCode(t, err, "WORKSPACE_PATH_REFUSED")
	if f.mkdirs != 0 {
		t.Fatal("nil guard effect")
	}
	m, f = fakeMutable()
	checks := 0
	r = fakeRequest(mutation.Write{RelativePath: "note.md", Content: "new"})
	r.BeforePublish = func(context.Context) error {
		checks++
		if checks == 3 {
			return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
		}
		return nil
	}
	_, err = m.Mutate(context.Background(), r)
	nativeCode(t, err, "AUTHORITY_EXPIRED")
	if f.links != 0 || f.swaps != 0 || stageOf(f) != nil {
		t.Fatal("expired publication")
	}
	m, f = fakeMutable()
	r = fakeRequest(mutation.Write{RelativePath: "nested/note.md", Content: "new"})
	checks = 0
	r.BeforePublish = func(context.Context) error {
		checks++
		if checks == 3 {
			return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
		}
		return nil
	}
	_, err = m.Mutate(context.Background(), r)
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if f.work.children["nested"] == nil || f.links != 0 {
		t.Fatal("parent effect lost")
	}
}
func TestMutationInjectedParentSubstitutionBeforePublication(t *testing.T) {
	m, f := fakeMutable()
	r := fakeRequest(mutation.Write{RelativePath: "note.md", Content: "new"})
	checks := 0
	r.BeforePublish = func(context.Context) error {
		checks++
		if checks == 3 {
			f.rootNode.children["work"] = f.directory(0700)
		}
		return nil
	}
	_, err := m.Mutate(context.Background(), r)
	nativeCode(t, err, "WORKSPACE_ROOT_CHANGED")
	if f.links != 0 || f.swaps != 0 {
		t.Fatal("published under displaced root")
	}
}
