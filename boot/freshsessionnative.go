//go:build darwin || linux

package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"
)

// Fresh sessions never reopen an old Chat journal. The current Computer owner
// is already held by NewNativeRuntime; these additional permanent claims also
// exclude standalone old Chat writers. No old bytes, claim or marker is reset.
type freshSession struct {
	mu         sync.RWMutex
	root       NativeRoot
	held       []*os.File
	names      []string
	identities []unix.Stat_t
	closed     bool
	closeErr   error
}

func (s *freshSession) verify() error {
	if s == nil {
		return errors.New("FRESH_SESSION_CLAIM_UNCONFIRMED")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.verifyHeld()
}
func (s *freshSession) verifyHeld() error {
	if s.closed {
		return errors.New("FRESH_SESSION_CLAIM_UNCONFIRMED")
	}
	for n, f := range s.held {
		canonical, err := filepath.EvalSymlinks(s.names[n])
		if err != nil || canonical != s.names[n] {
			return errors.New("FRESH_SESSION_CLAIM_UNCONFIRMED")
		}
		var fd, named unix.Stat_t
		if unix.Fstat(int(f.Fd()), &fd) != nil || unix.Lstat(s.names[n], &named) != nil || fd.Dev != s.identities[n].Dev || fd.Ino != s.identities[n].Ino || named.Dev != fd.Dev || named.Ino != fd.Ino || fd.Uid != uint32(os.Geteuid()) || fd.Mode != s.identities[n].Mode || (uint32(fd.Mode)&unix.S_IFMT == unix.S_IFREG && fd.Nlink != 1) {
			return errors.New("FRESH_SESSION_CLAIM_UNCONFIRMED")
		}
	}
	return nil
}
func (s *freshSession) close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.closeErr
	}
	var failures []error
	failures = append(failures, s.verifyHeld())
	for n := len(s.held) - 1; n >= 0; n-- {
		failures = append(failures, s.held[n].Close())
	}
	s.held = nil
	s.closed = true
	s.closeErr = errors.Join(failures...)
	return s.closeErr
}

func acquireFreshSession(ctx context.Context, original NativeRoot, generation string) (*freshSession, error) {
	if ctx == nil || ctx.Err() != nil || !validIngressID(generation) {
		return nil, errors.New("FRESH_SESSION_INPUT_INVALID")
	}
	s := &freshSession{}
	fail := func() (*freshSession, error) {
		return nil, errors.Join(errors.New("FRESH_SESSION_CLAIM_UNCONFIRMED"), s.close())
	}
	hold := func(name string, create bool, directory bool) error {
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
		if create {
			flags = unix.O_RDWR | unix.O_CREAT | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
		}
		if directory {
			flags |= unix.O_DIRECTORY
		}
		fd, e := unix.Open(name, flags, 0600)
		if e != nil {
			return e
		}
		f := os.NewFile(uintptr(fd), "fresh-session-claim")
		var st unix.Stat_t
		mode := uint32(unix.S_IFREG | 0600)
		if directory {
			mode = unix.S_IFDIR | 0700
		}
		if unix.Fstat(fd, &st) != nil || uint32(st.Mode) != mode || st.Uid != original.OwnerUID || (!directory && st.Nlink != 1) {
			_ = f.Close()
			return errors.New("unsafe claim")
		}
		if !directory && unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB) != nil {
			_ = f.Close()
			return errors.New("busy claim")
		}
		s.held = append(s.held, f)
		s.names = append(s.names, name)
		s.identities = append(s.identities, st)
		return nil
	}
	if filepath.Clean(original.Path) != original.Path {
		return fail()
	}
	canonical, e := filepath.EvalSymlinks(original.Path)
	if e != nil || canonical != original.Path {
		return fail()
	}
	if hold(original.Path, false, true) != nil {
		return fail()
	}
	root := s.identities[0]
	if uint64(root.Dev) != original.Device || uint64(root.Ino) != original.Inode {
		return fail()
	}
	if hold(filepath.Join(original.Path, "fresh-session.claim"), true, false) != nil {
		return fail()
	}
	if s.held[len(s.held)-1].Sync() != nil {
		return fail()
	}
	claims := []string{"chat-handoff.claim", "chat-lifecycle.claim", filepath.Join("chat-results", "chat-results.claim")}
	present := 0
	for _, name := range claims {
		p := filepath.Join(original.Path, name)
		if _, e := os.Lstat(p); e != nil {
			if errors.Is(e, os.ErrNotExist) {
				continue
			}
			return fail()
		}
		if name == filepath.Join("chat-results", "chat-results.claim") && hold(filepath.Dir(p), false, true) != nil {
			return fail()
		}
		if hold(p, false, false) != nil {
			return fail()
		}
		present++
	}
	// A partial legacy owner cannot be interpreted as an unused resource.
	if present != 0 && present != len(claims) {
		return fail()
	}
	entries, e := os.ReadDir(original.Path)
	if e != nil || len(entries) > 1024 {
		return fail()
	}
	if present == 0 {
		for _, entry := range entries {
			name := entry.Name()
			if name != "fresh-session.claim" && !(len(name) == 70 && name[:6] == "fresh-") {
				return fail()
			}
		}
	}
	if ctx.Err() != nil || s.verify() != nil {
		return fail()
	}
	id := sha256.Sum256([]byte(generation))
	parent := filepath.Join(original.Path, "fresh-"+hex.EncodeToString(id[:]))
	// Exclusive append-only names: failed initialization is retained, never reused.
	if os.Mkdir(parent, 0700) != nil {
		return fail()
	}
	chat := filepath.Join(parent, "chat")
	if os.Mkdir(chat, 0700) != nil {
		return fail()
	}
	for _, p := range []string{chat, parent, original.Path} {
		if hold(p, false, true) != nil {
			return fail()
		}
		if s.held[len(s.held)-1].Sync() != nil {
			return fail()
		}
	}
	st := s.identities[len(s.identities)-3]
	s.root = NativeRoot{Path: chat, ProfileID: original.ProfileID, Device: uint64(st.Dev), Inode: uint64(st.Ino), OwnerUID: st.Uid, Mode: uint32(st.Mode)}
	if ctx.Err() != nil || s.verify() != nil {
		return fail()
	}
	return s, nil
}
