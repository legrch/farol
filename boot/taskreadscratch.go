package boot

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
)

type TaskReadScratchCode string

func (c TaskReadScratchCode) Error() string { return string(c) }

const (
	TaskReadScratchInvalid      TaskReadScratchCode = "TASK_READ_SCRATCH_INVALID"
	TaskReadScratchRefused      TaskReadScratchCode = "TASK_READ_SCRATCH_REFUSED"
	TaskReadScratchUnavailable  TaskReadScratchCode = "TASK_READ_SCRATCH_UNAVAILABLE"
	TaskReadScratchUnsupported  TaskReadScratchCode = "TASK_READ_SCRATCH_UNSUPPORTED"
	TaskReadScratchChanged      TaskReadScratchCode = "TASK_READ_SCRATCH_CHANGED"
	TaskReadScratchNonEmpty     TaskReadScratchCode = "TASK_READ_SCRATCH_NONEMPTY"
	TaskReadScratchJoinMissing  TaskReadScratchCode = "TASK_READ_SCRATCH_JOIN_MISSING"
	TaskReadScratchClosed       TaskReadScratchCode = "TASK_READ_SCRATCH_CLOSED"
	TaskReadScratchCloseUnknown TaskReadScratchCode = "TASK_READ_SCRATCH_CLOSE_UNKNOWN"
)

// Failures are classified, path-free and nonretryable. CloseUnknown concerns
// original descriptor release only; it never licenses another close or cleanup.
type TaskReadScratchFailure struct{ Code TaskReadScratchCode }

func (f *TaskReadScratchFailure) Error() string        { return string(f.Code) }
func (f *TaskReadScratchFailure) Unwrap() error        { return f.Code }
func (f *TaskReadScratchFailure) Retry() string        { return "never" }
func (f *TaskReadScratchFailure) OutcomeUnknown() bool { return f.Code == TaskReadScratchCloseUnknown }
func taskScratchFailure(c TaskReadScratchCode) error   { return &TaskReadScratchFailure{Code: c} }

func taskScratchClassify(err error) error {
	var own *TaskReadScratchFailure
	if errors.As(err, &own) {
		return taskScratchFailure(own.Code)
	}
	var p *ProfileFailure
	if errors.As(err, &p) {
		switch p.Code {
		case ProfileRefused:
			return taskScratchFailure(TaskReadScratchRefused)
		case ProfileCleanupUnknown:
			return taskScratchFailure(TaskReadScratchCloseUnknown)
		}
	}
	return taskScratchFailure(TaskReadScratchUnavailable)
}

// TaskReadScratchRoot is an observation, never authority. Path is disclosed by
// Open only after the original named child, pins, physical spelling and empty
// inventory have been qualified. NativeBoundary still verifies before Launch;
// this scratch does not select or replace ExpectedCodexHome (the server HOME).
type TaskReadScratchRoot struct {
	Path           string
	Device, Inode  uint64
	OwnerUID, Mode uint32
}

// The trusted caller supplies these separately, after joining the ORIGINAL
// client exit and every ORIGINAL read handler. Neither is inferred from context
// cancellation, a close request, metadata, a PID, or this resource's observation.
type TaskReadScratchJoined struct {
	OriginalClientExit  bool
	ReadHandlersDrained bool
}

// Retention records the ORIGINAL observed identities, even when the namespace
// changes later. Created means mkdir reported success, not atomic provenance.
// With Qualified=false, Path is only the attempted artifact location and Child
// identity can be unknown (zero). Observation is the final check failure, if any.
// Released is true only if all original descriptor closes reported success.
// Every directory, including a successful empty scratch, is deliberately kept.
type TaskReadScratchRetention struct {
	Parent, Child                           TaskReadScratchRoot
	Attempted, Created, Qualified, Released bool
	Observation                             TaskReadScratchCode
}

// TaskReadScratch is an internal boot resource for later trusted NativeRuntime
// wiring. Construction is inert. trustedTemp must be the explicit trusted
// app.getPath("temp") value in canonical physical spelling, never request/body,
// HOME, cwd or a discovered fallback. Copies share one serialized lifetime.
type TaskReadScratch struct{ owner *taskScratchOwner }

func NewTaskReadScratch(trustedTemp string) *TaskReadScratch {
	return newTaskReadScratch(trustedTemp, nativeTaskScratchOS())
}

// This private port is deterministic in CPU tests; production cannot inject it.
// Each directory open and the one mkdir have no retry/adoption path. empty must
// perform a bounded inventory of the held child, without changing its contents.
type taskScratchOS interface {
	profileOS
	name() (string, error)
	mkdir(int, string) error
	empty(int) error
}

type taskScratchOwner struct {
	mu                 sync.Mutex
	os                 taskScratchOS
	parentPath         string
	uid                uint32
	dirs               []profileDirectory
	attempted, closing bool
	failure, closeErr  error
	retained           TaskReadScratchRetention
}

func newTaskReadScratch(parent string, native taskScratchOS) *TaskReadScratch {
	return &TaskReadScratch{owner: &taskScratchOwner{os: native, parentPath: parent}}
}

// Open makes at most one allocation/open attempt. Later calls only requalify the
// original pins and empty inventory; every failure is sticky, including cancelled
// observations. No path is returned on failure. No same-UID namespace exclusion
// or continued emptiness between observation and the consumer's use is claimed.
func (q *TaskReadScratch) Open(ctx context.Context) (TaskReadScratchRoot, error) {
	if q == nil || q.owner == nil {
		return TaskReadScratchRoot{}, taskScratchFailure(TaskReadScratchInvalid)
	}
	s := q.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return TaskReadScratchRoot{}, taskScratchFailure(TaskReadScratchClosed)
	}
	if s.failure != nil {
		return TaskReadScratchRoot{}, s.failure
	}
	if !s.attempted {
		s.attempted = true
		s.retained.Attempted = true
		if err := s.allocate(ctx); err != nil {
			s.failure = taskScratchClassify(err)
		}
	}
	if s.failure == nil {
		s.failure = s.observe(ctx)
	}
	if s.failure != nil {
		return TaskReadScratchRoot{}, s.failure
	}
	s.retained.Qualified = true
	return s.retained.Child, nil
}

func taskScratchRoot(d profileDirectory) TaskReadScratchRoot {
	return TaskReadScratchRoot{Path: d.path, Device: d.meta.device, Inode: d.meta.inode, OwnerUID: d.meta.uid, Mode: d.meta.mode & 07777}
}

func taskScratchDirectoryValid(m profileMetadata, uid uint32, parent bool) bool {
	if m.device == 0 || m.inode == 0 || m.mode&0170000 != profileDirectoryType || m.mode&06000 != 0 {
		return false
	}
	if parent {
		return m.uid == uid && m.mode&01000 == 0 && m.mode&0022 == 0 && m.mode&0700 == 0700
	}
	// Root-owned sticky shared ancestors can occur above app.getPath("temp").
	// They do not make the selected final parent shared or owner-unqualified.
	return (m.uid == 0 || m.uid == uid) && (m.mode&0022 == 0 || m.uid == 0 && m.mode&01000 != 0)
}

func (s *taskScratchOwner) allocate(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil || !validProfilePath(s.parentPath) {
		return taskScratchFailure(TaskReadScratchInvalid)
	}
	if s.os == nil {
		return taskScratchFailure(TaskReadScratchUnsupported)
	}
	s.uid = s.os.uid()
	fd, err := s.os.openRoot()
	if err != nil {
		return err
	}
	if fd < 0 {
		return taskScratchFailure(TaskReadScratchRefused)
	}
	s.dirs = append(s.dirs, profileDirectory{fd: fd, parent: -1, path: "/"})
	if s.dirs[0].meta, err = s.os.stat(fd); err != nil {
		return err
	}
	if !taskScratchDirectoryValid(s.dirs[0].meta, s.uid, false) {
		return taskScratchFailure(TaskReadScratchRefused)
	}
	for _, name := range strings.Split(s.parentPath[1:], "/") {
		if ctx.Err() != nil {
			return taskScratchFailure(TaskReadScratchUnavailable)
		}
		if err := s.pin(name); err != nil {
			return err
		}
	}
	p := s.dirs[len(s.dirs)-1]
	s.retained.Parent = taskScratchRoot(p)
	if !taskScratchDirectoryValid(p.meta, s.uid, true) {
		return taskScratchFailure(TaskReadScratchRefused)
	}
	if err := s.checkPins(ctx, false); err != nil {
		return err
	}
	name, err := s.os.name()
	if err != nil {
		return err
	}
	if !validTaskScratchName(name) {
		return taskScratchFailure(TaskReadScratchInvalid)
	}
	s.retained.Child.Path = filepath.Join(p.path, name)
	if ctx.Err() != nil {
		return taskScratchFailure(TaskReadScratchUnavailable)
	}
	if err := s.os.mkdir(p.fd, name); err != nil {
		return err
	}
	s.retained.Created = true
	if ctx.Err() != nil {
		return taskScratchFailure(TaskReadScratchUnavailable)
	}
	beforePin := len(s.dirs)
	err = s.pin(name)
	if len(s.dirs) > beforePin {
		s.retained.Child = taskScratchRoot(s.dirs[len(s.dirs)-1])
	}
	if err != nil {
		return err
	}
	d := s.dirs[len(s.dirs)-1]
	s.retained.Child = taskScratchRoot(d)
	if !profileDirectoryValid(d.meta, s.uid, true) || d.meta.device != p.meta.device || profileSame(d.meta, p.meta) {
		return taskScratchFailure(TaskReadScratchRefused)
	}
	return nil
}

func validTaskScratchName(n string) bool {
	if len(n) != len("farol-codex-read-")+32 || !strings.HasPrefix(n, "farol-codex-read-") {
		return false
	}
	for _, c := range n[len("farol-codex-read-"):] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func (s *taskScratchOwner) pin(name string) error {
	parent := len(s.dirs) - 1
	p := s.dirs[parent]
	named, err := s.os.statEntry(p.fd, name)
	if err != nil {
		return err
	}
	if !taskScratchDirectoryValid(named, s.uid, false) {
		return taskScratchFailure(TaskReadScratchRefused)
	}
	fd, err := s.os.openDirectory(p.fd, name)
	if err != nil {
		return err
	}
	if fd < 0 {
		return taskScratchFailure(TaskReadScratchRefused)
	}
	index := len(s.dirs)
	s.dirs = append(s.dirs, profileDirectory{fd: fd, parent: parent, name: name, path: filepath.Join(p.path, name)})
	opened, err := s.os.stat(fd)
	s.dirs[index].meta = opened
	if err != nil {
		return err
	}
	if opened != named {
		return taskScratchFailure(TaskReadScratchChanged)
	}
	return nil
}

func (s *taskScratchOwner) checkPins(ctx context.Context, child bool) error {
	if ctx == nil || ctx.Err() != nil {
		return taskScratchFailure(TaskReadScratchUnavailable)
	}
	for i, d := range s.dirs {
		if ctx.Err() != nil {
			return taskScratchFailure(TaskReadScratchUnavailable)
		}
		current, err := s.os.stat(d.fd)
		if err != nil {
			return taskScratchClassify(err)
		}
		if current != d.meta {
			return taskScratchFailure(TaskReadScratchChanged)
		}
		physical, err := s.os.physicalPath(d.fd)
		if err != nil {
			return taskScratchClassify(err)
		}
		if physical != d.path {
			return taskScratchFailure(TaskReadScratchChanged)
		}
		var named profileMetadata
		if d.parent < 0 {
			named, err = s.os.statRoot()
		} else {
			p := s.dirs[d.parent]
			named, err = s.os.statEntry(p.fd, d.name)
			if err == nil {
				up, e := s.os.statEntry(d.fd, "..")
				if e != nil {
					return taskScratchClassify(e)
				}
				if !profileSame(up, p.meta) {
					return taskScratchFailure(TaskReadScratchChanged)
				}
			}
		}
		if err != nil {
			return taskScratchClassify(err)
		}
		if named != d.meta {
			return taskScratchFailure(TaskReadScratchChanged)
		}
		if child && i == len(s.dirs)-1 && !profileDirectoryValid(current, s.uid, true) {
			return taskScratchFailure(TaskReadScratchRefused)
		}
	}
	if ctx.Err() != nil {
		return taskScratchFailure(TaskReadScratchUnavailable)
	}
	return nil
}

func (s *taskScratchOwner) observe(ctx context.Context) error {
	if err := s.checkPins(ctx, true); err != nil {
		return err
	}
	if err := s.os.empty(s.dirs[len(s.dirs)-1].fd); err != nil {
		return taskScratchClassify(err)
	}
	return s.checkPins(ctx, true)
}

// Close is one terminal decision. Missing joins refuse release and remain sticky;
// callers must gather both original facts BEFORE calling. With both supplied,
// cancellation, nonempty/changed/unknown observations still retain all artifacts
// and release only the original pins, in reverse order. No descriptor is reopened
// or retried, including EINTR/unknown close results. Repeated Close returns the
// identical result. Inspection errors and close errors are both preserved.
func (q *TaskReadScratch) Close(ctx context.Context, joined TaskReadScratchJoined) (TaskReadScratchRetention, error) {
	if q == nil || q.owner == nil {
		return TaskReadScratchRetention{}, taskScratchFailure(TaskReadScratchInvalid)
	}
	s := q.owner
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return s.retained, s.closeErr
	}
	s.closing = true
	if !joined.OriginalClientExit || !joined.ReadHandlersDrained {
		s.retained.Observation = TaskReadScratchJoinMissing
		s.closeErr = taskScratchFailure(TaskReadScratchJoinMissing)
		return s.retained, s.closeErr
	}
	observation := s.failure
	if observation == nil && s.retained.Qualified {
		observation = s.observe(ctx)
	}
	if observation != nil {
		var f *TaskReadScratchFailure
		if errors.As(observation, &f) {
			s.retained.Observation = f.Code
		}
	}
	s.closeErr = observation
	s.retained.Released = true
	for i := len(s.dirs) - 1; i >= 0; i-- {
		fd := s.dirs[i].fd
		s.dirs[i].fd = -1
		if s.os.close(fd) != nil {
			s.retained.Released = false
		}
	}
	if !s.retained.Released {
		// Put the unknown release first so errors.As also fails closed when an
		// earlier inspection failure is retained in the same error tree.
		s.closeErr = errors.Join(taskScratchFailure(TaskReadScratchCloseUnknown), s.closeErr)
	}
	return s.retained, s.closeErr
}
