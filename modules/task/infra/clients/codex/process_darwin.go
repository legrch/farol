//go:build darwin

package codex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"

	"github.com/legrch/farol/modules/task/domain"
)

type nativeBoundary struct {
	mu         sync.Mutex
	identities map[string]string
}

// NativeBoundary implements the actual macOS filesystem/Git/proxy boundary.
// Construction is inert. Verify/Launch are opt-in host operations; hermetic
// tests never call them. It has no installed-profile/auth/discovery reads.
func NativeBoundary() Boundary { return &nativeBoundary{identities: map[string]string{}} }

func metadata(p string) (os.FileInfo, *syscall.Stat_t, error) {
	if !canonical(p) {
		return nil, nil, task.ErrIdentity
	}
	st, err := os.Lstat(p)
	if err != nil || st.Mode()&os.ModeSymlink != 0 {
		return nil, nil, task.ErrIdentity
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil || real != p {
		return nil, nil, task.ErrIdentity
	}
	native, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, nil, task.ErrIdentity
	}
	return st, native, nil
}
func (b *nativeBoundary) Verify(ctx context.Context, s Selection) error {
	if ctx.Err() != nil || !s.valid() {
		return task.ErrUnavailable
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	identities := map[string]string{}
	for _, root := range []task.Root{s.Binding.Project, s.Binding.Writer} {
		st, n, err := metadata(root.Path)
		if err != nil || !st.IsDir() || strconv.FormatUint(uint64(n.Dev), 10) != root.Device || strconv.FormatUint(n.Ino, 10) != root.Inode {
			return task.ErrIdentity
		}
		common, err := gitCommon(ctx, root)
		if err != nil || common != root.GitCommonDirectory {
			return task.ErrIdentity
		}
	}
	st, _, err := metadata(s.Binding.Project.GitCommonDirectory)
	if err != nil || !st.IsDir() {
		return task.ErrIdentity
	}
	st, n, err := metadata(s.ScratchRoot)
	if err != nil || !st.IsDir() || st.Mode().Perm() != 0700 || n.Uid != uint32(os.Getuid()) {
		return task.ErrIdentity
	}
	identities["scratch"] = identity(n)
	st, n, err = metadata(s.SocketPath)
	if err != nil || st.Mode()&os.ModeSocket == 0 || n.Uid != uint32(os.Getuid()) {
		return task.ErrIdentity
	}
	identities["socket"] = identity(n)
	st, n, err = metadata(s.ExecutablePath)
	if err != nil || !st.Mode().IsRegular() || n.Nlink != 1 || st.Mode().Perm()&0111 == 0 || st.Mode().Perm()&0022 != 0 || n.Uid != uint32(os.Getuid()) && n.Uid != 0 || st.Size() <= 0 {
		return task.ErrIdentity
	}
	identities["executable"] = identity(n)
	f, err := os.Open(s.ExecutablePath)
	if err != nil {
		return task.ErrIdentity
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(st, opened) {
		return task.ErrIdentity
	}
	h := sha256.New()
	buffer := make([]byte, 32*1024)
	var written int64
	for {
		if ctx.Err() != nil {
			return task.ErrUnavailable
		}
		n, err := f.Read(buffer)
		written += int64(n)
		if written > st.Size() {
			return task.ErrIdentity
		}
		_, _ = h.Write(buffer[:n])
		if err == io.EOF {
			break
		}
		if err != nil || n == 0 {
			return task.ErrIdentity
		}
	}
	if written != st.Size() || hex.EncodeToString(h.Sum(nil)) != s.ExecutableSHA256 {
		return task.ErrIdentity
	}
	after, _, err := metadata(s.ExecutablePath)
	if err != nil || !os.SameFile(st, after) || after.Size() != st.Size() || after.ModTime() != st.ModTime() || after.Mode() != st.Mode() {
		return task.ErrIdentity
	}
	for key, id := range identities {
		if existing, ok := b.identities[key]; ok && existing != id {
			return task.ErrIdentity
		}
	}
	if ctx.Err() != nil {
		return task.ErrUnavailable
	}
	b.identities = identities
	return nil
}
func identity(n *syscall.Stat_t) string {
	return strconv.FormatUint(uint64(n.Dev), 10) + ":" + strconv.FormatUint(n.Ino, 10)
}

type nativeProcess struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	stdout   io.ReadCloser
	stderr   io.ReadCloser
	once     sync.Once
	done     chan struct{}
	closeErr error
}

func (b *nativeBoundary) Launch(ctx context.Context, s Selection) (Process, error) {
	if err := b.Verify(ctx, s); err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, task.ErrUnavailable
	}
	cmd := exec.Command(s.ExecutablePath, "app-server", "proxy", "--sock", s.SocketPath)
	cmd.Dir = s.ScratchRoot
	cmd.Env = []string{"HOME=" + s.ScratchRoot, "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "NO_COLOR=1", "TERM=dumb"}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, task.ErrUnavailable
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, task.ErrUnavailable
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, task.ErrUnavailable
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, task.ErrUnavailable
	}
	p := &nativeProcess{cmd: cmd, stdin: stdin, stdout: stdout, stderr: stderr, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(p.done) }()
	// Discard diagnostics, with a finite lifetime/output bound. No profile,
	// auth, stdout payload or raw native stderr is returned to the caller.
	go func() {
		_, err := io.CopyN(io.Discard, stderr, 64*1024+1)
		if err == nil {
			_ = p.Close()
		}
	}()
	return p, nil
}
func (p *nativeProcess) Read(b []byte) (int, error)  { return p.stdout.Read(b) }
func (p *nativeProcess) Write(b []byte) (int, error) { return p.stdin.Write(b) }
func (p *nativeProcess) Close() error {
	p.once.Do(func() {
		_ = p.stdin.Close()
		_ = p.stdout.Close()
		_ = p.stderr.Close()
		select {
		case <-p.done:
			return
		default:
		}
		// Exact owned child only. A refusal is final; never signal another PID,
		// escalate or relaunch after refusal/unknown cleanup.
		if p.cmd.Process.Signal(syscall.SIGTERM) != nil {
			p.closeErr = task.ErrUnknown
		}
	})
	return p.closeErr
}
func (p *nativeProcess) Wait(ctx context.Context) error {
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return task.ErrUnknown
	}
}
