package boot

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

// ProfileBinding is supplied by the trusted launcher for ONE already selected
// existing physical profile. It is not request data, discovery or approval.
// Device/Inode identify that exact root across backend incarnations.
type ProfileBinding struct {
	ProfileID string
	Root      string
	Device    uint64
	Inode     uint64
}

// NativeRoot describes a fixed existing state child, not a workspace or positive
// authority. Lead maps Computer.Path to accessrepo's current string API, Chat
// to chatrepo.Root, and Task to its existing journal root, retaining this
// qualification and checking the module opens.
// No owner, participant, approval, journal state or publication fence is inferred.
type NativeRoot struct {
	Path, ProfileID string
	Device, Inode   uint64
	OwnerUID, Mode  uint32
}

type ProfileCode string

func (c ProfileCode) Error() string { return string(c) }

const (
	ProfileInvalid        ProfileCode = "PROFILE_BINDING_INVALID"
	ProfileRefused        ProfileCode = "PROFILE_ROOT_REFUSED"
	ProfileUnavailable    ProfileCode = "PROFILE_ROOT_UNAVAILABLE"
	ProfileUnsupported    ProfileCode = "PROFILE_NATIVE_UNSUPPORTED"
	ProfileCleanupUnknown ProfileCode = "PROFILE_CLEANUP_UNKNOWN"
)

// ProfileFailure contains no path or raw OS diagnostic. CleanupUnknown concerns
// only owned descriptors, never module publication/unknown markers. Every result
// is nonretryable; changing roots, recovering state or reopening is not licensed.
type ProfileFailure struct{ Code ProfileCode }

func (f *ProfileFailure) Error() string { return string(f.Code) }
func (f *ProfileFailure) Unwrap() error { return f.Code }
func (f *ProfileFailure) Retry() string { return "never" }
func (f *ProfileFailure) OutcomeUnknown() bool {
	return f.Code == ProfileCleanupUnknown
}
func profileFailure(code ProfileCode) error { return &ProfileFailure{Code: code} }
func classifiedProfileFailure(err error) error {
	var failure *ProfileFailure
	if errors.As(err, &failure) && failure != nil {
		switch failure.Code {
		case ProfileInvalid, ProfileRefused, ProfileUnavailable, ProfileUnsupported, ProfileCleanupUnknown:
			return profileFailure(failure.Code)
		}
	}
	return profileFailure(ProfileUnavailable)
}

// QualifiedProfile copies share one descriptor owner. Roots and Close serialize
// access to that owner; returned metadata copies do not extend its lifetime.
// Lead retains it until the native consumers close, and owns activation/proof.
type QualifiedProfile struct{ owner *profileOwner }

type profileMetadata struct {
	device, inode uint64
	uid, mode     uint32
}

const profileDirectoryType uint32 = 0040000

// The injected boundary is private and CPU-test-only. Production selects Darwin
// directly; neither callers nor wire values can select a weaker OS implementation.
type profileOS interface {
	uid() uint32
	openRoot() (int, error)
	openDirectory(int, string) (int, error)
	stat(int) (profileMetadata, error)
	statRoot() (profileMetadata, error)
	statEntry(int, string) (profileMetadata, error)
	physicalPath(int) (string, error)
	close(int) error
}

type profileDirectory struct {
	fd, parent int // parent is an index into the retained descriptor chain
	name, path string
	meta       profileMetadata
	private    bool
}
type profileOwner struct {
	mu                   sync.Mutex
	os                   profileOS
	binding              ProfileBinding
	uid                  uint32
	directories          []profileDirectory
	computer, chat, task int
	closed               bool
	failure              error
	closeErr             error
}

// QualifyProfile never derives HOME. This seam needs only the explicit profile
// binding; any selected HOME for other startup routes is a separate trusted input.
// It opens no state files and creates, chmods, repairs or restores nothing.
func QualifyProfile(binding ProfileBinding) (*QualifiedProfile, error) {
	if !validProfileBinding(binding) {
		return nil, profileFailure(ProfileInvalid)
	}
	return qualifyNativeProfile(binding)
}

func validProfileBinding(b ProfileBinding) bool {
	return validProfileID(b.ProfileID) && validProfilePath(b.Root) && b.Device != 0 && b.Inode != 0
}
func validProfileID(id string) bool {
	// Canonical wire alphabet, intersected with both current state owners' 120
	// byte bound. IDs are opaque and compared literally; no alias normalization.
	if len(id) < 1 || len(id) > 120 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		alphanumeric := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
		if !alphanumeric && (i == 0 || !strings.ContainsRune("._:/-", rune(c))) {
			return false
		}
	}
	return true
}
func validProfilePath(path string) bool {
	if len(path) <= 1 || len(path) > 4096 || !utf8.ValidString(path) || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return false
	}
	for _, component := range strings.Split(path[1:], "/") {
		if len(component) == 0 || len(component) > 255 {
			return false
		}
		for _, c := range component {
			if c < 32 || c == 127 {
				return false
			}
		}
	}
	return true
}
func profileDirectoryValid(m profileMetadata, uid uint32, private bool) bool {
	if m.device == 0 || m.inode == 0 || m.mode&0170000 != profileDirectoryType {
		return false
	}
	if private {
		return m.uid == uid && m.mode&07777 == 0700
	}
	// Ancestors can belong to root or the effective user, but another user or a
	// writable shared ancestor cannot replace entries in the selected chain.
	return (m.uid == 0 || m.uid == uid) && m.mode&0022 == 0 && m.mode&07000 == 0
}
func profileSame(a, b profileMetadata) bool {
	return a.device == b.device && a.inode == b.inode
}

func qualifyProfile(binding ProfileBinding, native profileOS) (*QualifiedProfile, error) {
	if !validProfileBinding(binding) || native == nil {
		return nil, profileFailure(ProfileInvalid)
	}
	owner := &profileOwner{os: native, binding: binding, uid: native.uid(), computer: -1, chat: -1, task: -1}
	qualified := &QualifiedProfile{owner: owner}
	fail := func(err error) (*QualifiedProfile, error) {
		if closed := qualified.Close(); closed != nil {
			return nil, closed
		}
		return nil, classifiedProfileFailure(err)
	}
	fd, err := native.openRoot()
	if err != nil {
		return fail(err)
	}
	if fd < 0 {
		return fail(profileFailure(ProfileRefused))
	}
	owner.directories = append(owner.directories, profileDirectory{fd: fd, parent: -1, path: "/"})
	meta, err := native.stat(fd)
	if err != nil {
		return fail(err)
	}
	if !profileDirectoryValid(meta, owner.uid, false) {
		return fail(profileFailure(ProfileRefused))
	}
	owner.directories[0].meta = meta
	components := strings.Split(binding.Root[1:], "/")
	for i, name := range components {
		if err := owner.appendDirectory(len(owner.directories)-1, name, i == len(components)-1); err != nil {
			return fail(err)
		}
	}
	profile := len(owner.directories) - 1
	meta = owner.directories[profile].meta
	if meta.device != binding.Device || meta.inode != binding.Inode {
		return fail(profileFailure(ProfileRefused))
	}
	for _, name := range []string{"computer", "chat", "task"} {
		if err := owner.appendDirectory(profile, name, true); err != nil {
			return fail(err)
		}
		index := len(owner.directories) - 1
		child := owner.directories[index].meta
		if child.device != meta.device || profileSame(child, meta) {
			return fail(profileFailure(ProfileRefused))
		}
		if name == "computer" {
			owner.computer = index
		} else if name == "chat" {
			owner.chat = index
		} else {
			owner.task = index
		}
	}
	if profileSame(owner.directories[owner.computer].meta, owner.directories[owner.chat].meta) ||
		profileSame(owner.directories[owner.task].meta, owner.directories[owner.computer].meta) ||
		profileSame(owner.directories[owner.task].meta, owner.directories[owner.chat].meta) {
		return fail(profileFailure(ProfileRefused))
	}
	if err := owner.check(); err != nil {
		return fail(err)
	}
	return qualified, nil
}

func (s *profileOwner) appendDirectory(parent int, name string, private bool) error {
	p := s.directories[parent]
	named, err := s.os.statEntry(p.fd, name)
	if err != nil {
		return err
	}
	if !profileDirectoryValid(named, s.uid, private) {
		return profileFailure(ProfileRefused)
	}
	fd, err := s.os.openDirectory(p.fd, name)
	if err != nil {
		return err
	}
	if fd < 0 {
		return profileFailure(ProfileRefused)
	}
	index := len(s.directories)
	s.directories = append(s.directories, profileDirectory{fd: fd, parent: parent, name: name, path: filepath.Join(p.path, name), private: private})
	opened, err := s.os.stat(fd)
	if err != nil {
		return err
	}
	if opened != named || !profileDirectoryValid(opened, s.uid, private) {
		return profileFailure(ProfileRefused)
	}
	s.directories[index].meta = opened
	return nil
}

func (s *profileOwner) check() error {
	if s.failure != nil {
		return s.failure
	}
	if s.closed {
		return profileFailure(ProfileUnavailable)
	}
	reject := func(err error) error { s.failure = classifiedProfileFailure(err); return s.failure }
	for _, d := range s.directories {
		current, err := s.os.stat(d.fd)
		if err != nil {
			return reject(err)
		}
		if current != d.meta || !profileDirectoryValid(current, s.uid, d.private) {
			return reject(profileFailure(ProfileRefused))
		}
		physical, err := s.os.physicalPath(d.fd)
		if err != nil {
			return reject(err)
		}
		if physical != d.path {
			return reject(profileFailure(ProfileRefused))
		}
		var named profileMetadata
		if d.parent < 0 {
			named, err = s.os.statRoot()
		} else {
			parent := s.directories[d.parent]
			named, err = s.os.statEntry(parent.fd, d.name)
			if err == nil {
				up, upErr := s.os.statEntry(d.fd, "..")
				if upErr != nil {
					return reject(upErr)
				}
				if !profileSame(up, parent.meta) {
					return reject(profileFailure(ProfileRefused))
				}
			}
		}
		if err != nil {
			return reject(err)
		}
		if named != d.meta {
			return reject(profileFailure(ProfileRefused))
		}
	}
	return nil
}

// Roots rechecks exact named-entry/descriptor/parent/physical-path continuity.
// Metadata alone must not be treated as an approval or as proof of module opens.
func (q *QualifiedProfile) Roots() (computer NativeRoot, chat NativeRoot, err error) {
	if q == nil || q.owner == nil {
		return computer, chat, profileFailure(ProfileUnavailable)
	}
	s := q.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return computer, chat, err
	}
	root := func(index int) NativeRoot {
		d := s.directories[index]
		return NativeRoot{Path: d.path, ProfileID: s.binding.ProfileID, Device: d.meta.device, Inode: d.meta.inode, OwnerUID: d.meta.uid, Mode: d.meta.mode & 07777}
	}
	return root(s.computer), root(s.chat), nil
}

// TaskRoot exposes the distinct fixed Task child without changing Roots callers.
// It shares their retained descriptor owner and sticky continuity check. This
// metadata opens no journal and creates no Task admission or recovery authority.
func (q *QualifiedProfile) TaskRoot() (root NativeRoot, err error) {
	if q == nil || q.owner == nil {
		return root, profileFailure(ProfileUnavailable)
	}
	s := q.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(); err != nil {
		return root, err
	}
	d := s.directories[s.task]
	return NativeRoot{Path: d.path, ProfileID: s.binding.ProfileID, Device: d.meta.device, Inode: d.meta.inode, OwnerUID: d.meta.uid, Mode: d.meta.mode & 07777}, nil
}

// Close consumes only descriptors opened by this qualification, in reverse
// order. A close error is retained and never retried against a possibly reused fd.
func (q *QualifiedProfile) Close() error {
	if q == nil || q.owner == nil {
		return nil
	}
	s := q.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.closeErr
	}
	s.closed = true
	for i := len(s.directories) - 1; i >= 0; i-- {
		fd := s.directories[i].fd
		s.directories[i].fd = -1
		if fd >= 0 && s.os.close(fd) != nil {
			s.closeErr = profileFailure(ProfileCleanupUnknown)
		}
	}
	return s.closeErr
}
