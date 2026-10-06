// Package filesystem implements descriptor-bound Computer workspace reads.
// Native authority is rechecked here independently of application admission.
package filesystem

import (
	"context"
	"errors"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"golang.org/x/sys/unix"
)

const maxReadBytes = 256 * 1024

// Workspace owns no mutable authority or shared request state.
type Workspace struct {
	homeDirectory string
	filePolicy    authority.FilePolicy
	afterRead     func() // Package-private deterministic fault point; never configured by a caller.
}

// New requires the trusted host home; it is never selected by a tool request.
func New(homeDirectory string) *Workspace { return &Workspace{homeDirectory: homeDirectory} }

// NewWithFilePolicy is selected by trusted composition after the owner accepts
// the policy meaning. A tool request cannot choose this constructor. RootScoped
// removes built-in filename bans, not descriptor authority, explicit restrictions,
// no-follow/physical-root checks, byte limits, or compare-and-swap protection.
func NewWithFilePolicy(homeDirectory string, selected authority.FilePolicy) (*Workspace, error) {
	if !selected.Valid() {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	if _, err := components(homeDirectory, true, false); err != nil {
		return nil, err
	}
	return &Workspace{homeDirectory: homeDirectory, filePolicy: selected}, nil
}

func refusal(code string) error {
	return &authority.Failure{Code: code, Source: "native-workspace", Retry: "never"}
}

// Native request roots and approved ancestors require a named component,
// matching the TS adapter and safe_open.py. Pure authority accepts "/" for
// scope algebra; that alone does not establish native execution capability.
func components(value string, absolute, allowRoot bool) ([]string, error) {
	if allowRoot && value == "." && !absolute {
		return nil, nil
	}
	if !utf8.ValidString(value) || len(value) == 0 || len(value) > 4096 || strings.Contains(value, "\\") || strings.HasSuffix(value, "/") || strings.HasPrefix(value, "/") != absolute {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	if absolute {
		value = value[1:]
	}
	parts := strings.Split(value, "/")
	if len(parts) > 256 {
		return nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
		for _, r := range part {
			if r < 32 || r == 127 {
				return nil, refusal("WORKSPACE_INVALID_REQUEST")
			}
		}
	}
	return parts, nil
}

func under(prefix, value []string) bool {
	return authority.ComparableWithin("/"+strings.Join(prefix, "/"), "/"+strings.Join(value, "/"))
}

type policy struct {
	denied [][]string
	exact  []string
}

func (w *Workspace) parsePolicy(d port.Descriptor) (policy, error) {
	p := policy{exact: d.ExactFilePaths}
	if w == nil || !w.filePolicy.Valid() || !d.FilePolicy.Valid() || d.FilePolicy != w.filePolicy {
		return p, refusal("WORKSPACE_INVALID_REQUEST")
	}
	home, err := components(w.homeDirectory, true, false)
	if err != nil {
		return p, err
	}
	root, err := components(d.Root, true, false)
	if err != nil {
		return p, err
	}
	var prefixes []string
	if w.filePolicy == authority.LegacyProtectedFiles {
		// Agent stores (.codex/.claude) follow ordinary owner/task grants, including
		// explicit exclusions. Their directory names alone never veto an approved root.
		mandatory := []string{".env", ".ssh", ".aws", ".gnupg", ".git", ".git-credentials", ".netrc", ".pypirc", ".docker/config.json", ".kube/config", "Library/Keychains"}
		prefixes = append(prefixes, mandatory...)
		// Repository .npmrc follows owner/task scope; only HOME/.npmrc is mandatory.
		for _, store := range append(append([]string{}, mandatory...), ".npmrc") {
			if store == ".env" || store == ".git" {
				continue
			}
			absolute := append(append([]string{}, home...), strings.Split(store, "/")...)
			if under(absolute, root) {
				return p, refusal("WORKSPACE_PATH_REFUSED")
			}
			if under(root, absolute) {
				prefixes = append(prefixes, strings.Join(absolute[len(root):], "/"))
			}
		}
	}
	prefixes = append(prefixes, d.DeniedPaths...)
	unique := make([]string, 0, len(prefixes))
	seen := map[string]bool{}
	for _, path := range prefixes {
		if !seen[path] {
			unique = append(unique, path)
			seen[path] = true
		}
	}
	if len(unique) > 64 || len(d.ExactFilePaths) > 1000 {
		return p, refusal("WORKSPACE_POLICY_TOO_LARGE")
	}
	for _, path := range unique {
		parts, err := components(path, false, false)
		if err != nil {
			return p, err
		}
		p.denied = append(p.denied, parts)
	}
	for _, path := range d.ExactFilePaths {
		if _, err := components(path, false, false); err != nil {
			return p, err
		}
	}
	return p, nil
}
func (p policy) denies(parts []string) bool {
	for _, prefix := range p.denied {
		if under(prefix, parts) {
			return true
		}
	}
	return false
}
func (p policy) permitsFile(path string) bool {
	if p.exact == nil {
		return true
	}
	for _, allowed := range p.exact {
		if path == allowed {
			return true
		}
	}
	return false
}

func openError(err error) error {
	if errors.Is(err, unix.ENOENT) || errors.Is(err, unix.ENOTDIR) {
		return refusal("WORKSPACE_NOT_FOUND")
	}
	return refusal("WORKSPACE_PATH_REFUSED")
}
func directory(parent int, name string) (int, error) {
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil { // ENOTDIR also names a refused symlink, not an absent path.
		var s unix.Stat_t
		if unix.Fstatat(parent, name, &s, unix.AT_SYMLINK_NOFOLLOW) == nil && s.Mode&unix.S_IFMT == unix.S_IFLNK {
			return -1, refusal("WORKSPACE_PATH_REFUSED")
		}
		return -1, openError(err)
	}
	return fd, nil
}
func stat(fd int) (unix.Stat_t, error) { var s unix.Stat_t; err := unix.Fstat(fd, &s); return s, err }

func openRoot(d port.Descriptor) (int, error) {
	fd, _, err := openedRoot(d)
	return fd, err
}

// openedRoot observes the approved ancestor while opening the no-follow chain.
// The binding is usable only after the caller completes its final root recheck.
func openedRoot(d port.Descriptor) (int, *port.DirectoryBinding, error) {
	parts, err := components(d.Root, true, false)
	if err != nil {
		return -1, nil, err
	}
	approved, err := components(d.ApprovedRoot.Path, true, false)
	if err != nil {
		return -1, nil, err
	}
	if len(approved) > len(parts) {
		return -1, nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	for i, part := range approved {
		if parts[i] != part {
			return -1, nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
	}
	for _, raw := range []string{d.ApprovedRoot.Device, d.ApprovedRoot.Inode} {
		if len(raw) == 0 || len(raw) > 20 {
			return -1, nil, refusal("WORKSPACE_INVALID_REQUEST")
		}
		for _, r := range raw {
			if r < '0' || r > '9' {
				return -1, nil, refusal("WORKSPACE_INVALID_REQUEST")
			}
		}
	}
	dev, err := strconv.ParseUint(d.ApprovedRoot.Device, 10, 64)
	if err != nil || len(d.ApprovedRoot.Device) > 20 {
		return -1, nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	ino, err := strconv.ParseUint(d.ApprovedRoot.Inode, 10, 64)
	if err != nil || len(d.ApprovedRoot.Inode) > 20 {
		return -1, nil, refusal("WORKSPACE_INVALID_REQUEST")
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, nil, openError(err)
	}
	for i, part := range parts {
		child, err := directory(fd, part)
		unix.Close(fd)
		if err != nil {
			return -1, nil, err
		}
		fd = child
		if i == len(approved)-1 {
			s, err := stat(fd)
			if err != nil {
				unix.Close(fd)
				return -1, nil, refusal("WORKSPACE_PATH_REFUSED")
			}
			if uint64(s.Dev) != dev || uint64(s.Ino) != ino {
				unix.Close(fd)
				return -1, nil, refusal("WORKSPACE_ROOT_CHANGED")
			}
		}
	}
	s, err := stat(fd)
	if err != nil || s.Uid != uint32(os.Getuid()) || s.Mode&0022 != 0 {
		unix.Close(fd)
		return -1, nil, refusal("WORKSPACE_PATH_REFUSED")
	}
	return fd, &port.DirectoryBinding{
		Root:         "/" + strings.Join(parts, "/"),
		ApprovedRoot: port.Root{Path: "/" + strings.Join(approved, "/"), Device: d.ApprovedRoot.Device, Inode: d.ApprovedRoot.Inode},
	}, nil
}

func walk(root int, parts []string) (int, error) {
	fd, err := unix.Dup(root)
	if err != nil {
		return -1, refusal("WORKSPACE_PATH_REFUSED")
	}
	unix.CloseOnExec(fd)
	for _, part := range parts {
		child, err := directory(fd, part)
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = child
	}
	return fd, nil
}

func regular(parent int, name string) (int, unix.Stat_t, error) {
	var listed unix.Stat_t
	if err := unix.Fstatat(parent, name, &listed, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return -1, listed, openError(err)
	}
	if listed.Mode&unix.S_IFMT == unix.S_IFLNK {
		return -1, listed, refusal("WORKSPACE_PATH_REFUSED")
	}
	if listed.Mode&unix.S_IFMT != unix.S_IFREG {
		return -1, listed, refusal("WORKSPACE_NOT_A_FILE")
	}
	if listed.Nlink != 1 {
		return -1, listed, refusal("WORKSPACE_PATH_REFUSED")
	}
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, listed, openError(err)
	}
	opened, err := stat(fd)
	if err != nil || !stable(listed, opened) || opened.Nlink != 1 {
		unix.Close(fd)
		return -1, listed, refusal("WORKSPACE_RACE_DETECTED")
	}
	return fd, opened, nil
}

func cancelled(ctx context.Context) error {
	if ctx.Err() != nil {
		return refusal("WORKSPACE_REQUEST_CANCELLED")
	}
	return nil
}
func recheckRoot(d port.Descriptor, before unix.Stat_t) error {
	fd, err := openRoot(d)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	after, err := stat(fd)
	if err != nil || before.Dev != after.Dev || before.Ino != after.Ino {
		return refusal("WORKSPACE_ROOT_CHANGED")
	}
	return nil
}
