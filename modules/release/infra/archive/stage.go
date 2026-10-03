package archive

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

type ownedPath struct {
	name string
	id   identity
}
type savedMode struct {
	name string
	mode os.FileMode
	id   identity
}
type stage struct {
	root    *os.Root
	handle  *os.File
	path    string
	before  identity
	created []ownedPath
	modes   []savedMode
}

func openStage(path string) (*stage, error) {
	named, err := os.Lstat(filepath.Clean(path))
	if err != nil || named.Mode()&os.ModeSymlink != 0 {
		return nil, refuse("ARCHIVE_STAGE_INVALID")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, refuse("ARCHIVE_STAGE_INVALID")
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, refuse("ARCHIVE_STAGE_INVALID")
	}
	current, err := os.Lstat(absolute)
	if err != nil || !current.IsDir() || identify(current).uid != uint32(os.Getuid()) || current.Mode().Perm()&0077 != 0 {
		return nil, refuse("ARCHIVE_STAGE_INVALID")
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, refuse("ARCHIVE_STAGE_INVALID")
	}
	handle, err := root.OpenFile(".", os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		root.Close()
		return nil, refuse("ARCHIVE_STAGE_INVALID")
	}
	s := &stage{root: root, handle: handle, path: absolute, before: identify(current)}
	if err := s.unchanged(); err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *stage) close()             { s.handle.Close(); s.root.Close() }
func sameObject(a, b identity) bool { return a.dev == b.dev && a.ino == b.ino }
func (s *stage) unchanged() error {
	opened, err := s.handle.Stat()
	if err != nil {
		return refuse("ARCHIVE_STAGE_CHANGED")
	}
	named, err := os.Lstat(s.path)
	if err != nil {
		return refuse("ARCHIVE_STAGE_CHANGED")
	}
	for _, info := range []os.FileInfo{opened, named} {
		id := identify(info)
		// Directory times, size, and link count change as owned children are added.
		if !info.IsDir() || !sameObject(id, s.before) || id.mode != s.before.mode || id.uid != s.before.uid || id.gid != s.before.gid || id.uid != uint32(os.Getuid()) || info.Mode().Perm()&0077 != 0 {
			return refuse("ARCHIVE_STAGE_CHANGED")
		}
	}
	return nil
}

func permissions(raw uint32) os.FileMode {
	mode := os.FileMode(raw & 0777)
	if raw&04000 != 0 {
		mode |= os.ModeSetuid
	}
	if raw&02000 != 0 {
		mode |= os.ModeSetgid
	}
	if raw&01000 != 0 {
		mode |= os.ModeSticky
	}
	return mode
}

func (s *stage) remember(name string) error {
	info, err := s.root.Lstat(name)
	if err != nil {
		return err
	}
	s.created = append(s.created, ownedPath{name, identify(info)})
	return nil
}

func (s *stage) mkdirs(parts []string) error {
	for i := 1; i <= len(parts); i++ {
		name := strings.Join(parts[:i], "/")
		info, err := s.root.Lstat(name)
		if os.IsNotExist(err) {
			if err := s.root.Mkdir(name, 0700); err != nil {
				return err
			}
			if err := s.remember(name); err != nil {
				return err
			}
			info, err = s.root.Lstat(name)
		}
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return refuse("ARCHIVE_PARENT_TYPE_INVALID")
		}
	}
	return nil
}

func (s *stage) extract(p *plan) error {
	buffer := make([]byte, chunk)
	for _, e := range p.entries {
		if err := s.unchanged(); err != nil {
			return err
		}
		if e.kind == directory {
			if err := s.mkdirs(e.parts); err != nil {
				return err
			}
			continue
		}
		if err := s.mkdirs(e.parts[:len(e.parts)-1]); err != nil {
			return err
		}
		if e.kind == symlink {
			continue
		}
		file, err := s.root.OpenFile(e.name, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
		if err != nil {
			return err
		}
		info, statErr := file.Stat()
		if statErr != nil {
			file.Close()
			return statErr
		}
		s.created = append(s.created, ownedPath{e.name, identify(info)})
		copyErr := copyEntry(e.file, file, buffer)
		if copyErr == nil {
			copyErr = file.Chmod(permissions(e.mode))
		}
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	for _, e := range p.entries {
		if e.kind != symlink {
			continue
		}
		if err := s.unchanged(); err != nil {
			return err
		}
		if err := s.root.Symlink(e.link, e.name); err != nil {
			return err
		}
		if err := s.remember(e.name); err != nil {
			return err
		}
	}
	resolver := newLinkResolver(s, nil)
	for _, e := range p.entries {
		if e.kind == symlink {
			if _, err := resolver.resolve(e.name); err != nil {
				return err
			}
		}
	}
	dirs := make([]*entry, 0)
	for _, e := range p.entries {
		if e.kind == directory {
			dirs = append(dirs, e)
		}
	}
	sort.SliceStable(dirs, func(i, j int) bool { return len(dirs[i].parts) > len(dirs[j].parts) })
	for _, e := range dirs {
		// fchmod an opened no-follow directory instead of race-prone path chmod.
		file, err := s.root.OpenFile(e.name, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		info, err := file.Stat()
		if err != nil {
			file.Close()
			return err
		}
		s.modes = append(s.modes, savedMode{e.name, info.Mode(), identify(info)})
		mode := e.mode
		if mode == 0 {
			mode = 0755
		}
		err = file.Chmod(permissions(mode))
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

// Roll back only objects created by this extraction, preserving the bootstrap
// and any pre-existing directories. A concurrently replaced inode is not ours.
func (s *stage) cleanup() {
	for i := len(s.modes) - 1; i >= 0; i-- {
		saved := s.modes[i]
		file, err := s.root.OpenFile(saved.name, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			continue
		}
		info, err := file.Stat()
		if err == nil && sameObject(identify(info), saved.id) {
			_ = file.Chmod(saved.mode)
		}
		_ = file.Close()
	}
	for i := len(s.created) - 1; i >= 0; i-- {
		owned := s.created[i]
		info, err := s.root.Lstat(owned.name)
		if err == nil && sameObject(identify(info), owned.id) {
			_ = s.root.Remove(owned.name)
		}
	}
}
