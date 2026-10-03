// Package journal persists the existing current-alpha journal. Native reads and
// persistence acknowledge no package acceptance, helper exit or startup grant.
package journal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

const filename = "journal.json"

type fileState struct {
	Device, Inode, UID, GID, Links                               uint64
	Mode                                                         uint32
	Size                                                         int64
	ModifiedSeconds, ModifiedNanos, ChangedSeconds, ChangedNanos int64
}

func (s fileState) object() fileState {
	s.Size, s.ModifiedSeconds, s.ModifiedNanos, s.ChangedSeconds, s.ChangedNanos = 0, 0, 0, 0, 0
	return s
}

func (s fileState) directoryObject() fileState {
	s = s.object()
	s.Links = 0
	return s
}

type Repo struct {
	root            *os.Root
	parent          *os.File
	ancestor        *os.File
	ancestorPath    string
	ancestorState   fileState
	path            string
	directory       fileState
	operation       release.Operation
	admission       port.JournalAdmission
	gate            port.StateGate
	closed, unknown bool
	// Deterministic test-only fault/race checkpoints. Production leaves nil.
	step       func(string) error
	writeChunk func(*os.File, []byte) (int, error)
	publish    func(*os.File, string, bool) error
}

var _ port.JournalRepository = (*Repo)(nil)

// New opens an existing, canonical operation directory; it creates no directory
// or lock. Boot supplies a fixed trusted path and the same borrowed gate from
// the authoritative Release exclusion domain to every journal consumer. This
// gate serializes existing ownership; it does not create or prove authority.
// Admission must not recursively acquire that gate during its callbacks.
func New(ctx context.Context, directory string, operation release.Operation, admission port.JournalAdmission) (*Repo, error) {
	if admission == nil {
		return nil, port.JournalInvalid
	}
	gate := admission.JournalGate()
	if gate == nil {
		return nil, port.JournalInvalid
	}
	if _, err := records.EncodeJournal(record(release.Journal{Operation: operation, Phase: "prepared"})); err != nil {
		return nil, err
	}
	gate.Lock()
	defer gate.Unlock()
	if ctx.Err() != nil {
		return nil, port.JournalCancelled
	}
	if admission.JournalUnknown(operation) {
		return nil, port.JournalUnknown
	}
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || filepath.Base(directory) != operation.ID {
		return nil, port.JournalPathInvalid
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil || canonical != directory {
		return nil, port.JournalPathInvalid
	}
	named, err := os.Lstat(directory)
	if err != nil {
		return nil, port.JournalUnavailable
	}
	before, ok := metadata(named)
	if !ok || !privateDirectory(named, before) {
		return nil, port.JournalPathInvalid
	}
	anchorPath := filepath.Dir(directory)
	anchorInfo, err := os.Lstat(anchorPath)
	if err != nil {
		return nil, port.JournalUnavailable
	}
	anchorState, ok := metadata(anchorInfo)
	if !ok || !privateDirectory(anchorInfo, anchorState) {
		return nil, port.JournalPathInvalid
	}
	ancestor, err := os.OpenFile(anchorPath, directoryFlags(), 0)
	if err != nil {
		return nil, port.JournalUnavailable
	}
	owned := false
	defer func() {
		if !owned {
			ancestor.Close()
		}
	}()
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, port.JournalUnavailable
	}
	parent, err := root.OpenFile(".", directoryFlags(), 0)
	if err != nil {
		root.Close()
		return nil, port.JournalUnavailable
	}
	r := &Repo{root: root, parent: parent, path: directory, directory: before.directoryObject(), operation: operation, admission: admission, gate: gate, ancestor: ancestor, ancestorPath: anchorPath, ancestorState: anchorState.directoryObject()}
	if err := r.checkDirectory(); err != nil {
		parent.Close()
		root.Close()
		return nil, err
	}
	if err := admission.ReverifyJournal(ctx, operation, r.identity()); err != nil {
		admission.RetainJournalUnknown(operation)
		parent.Close()
		root.Close()
		return nil, port.JournalUnproven
	}
	if ctx.Err() != nil {
		parent.Close()
		root.Close()
		return nil, port.JournalCancelled
	}
	owned = true
	return r, nil
}

func (r *Repo) identity() port.JournalDirectory {
	return port.JournalDirectory{Device: strconv.FormatUint(r.directory.Device, 10), Inode: strconv.FormatUint(r.directory.Inode, 10), ParentDevice: strconv.FormatUint(r.ancestorState.Device, 10), ParentInode: strconv.FormatUint(r.ancestorState.Inode, 10)}
}

func privateDirectory(info os.FileInfo, state fileState) bool {
	return info.IsDir() && state.UID == uint64(os.Geteuid()) && info.Mode().Perm()&0o077 == 0 &&
		info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) == 0
}

func privateFile(info os.FileInfo, state fileState) bool {
	return info.Mode().IsRegular() && state.UID == uint64(os.Geteuid()) && state.Links == 1 &&
		info.Mode().Perm()&0o077 == 0 && info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) == 0 &&
		state.Size >= 0 && state.Size <= records.MaxRecordBytes
}

func (r *Repo) checkDirectory() error {
	canonical, err := filepath.EvalSymlinks(r.path)
	if err != nil || canonical != r.path {
		return port.JournalChanged
	}
	anchorNamed, err := os.Lstat(r.ancestorPath)
	if err != nil {
		return port.JournalChanged
	}
	anchorHeld, err := r.ancestor.Stat()
	if err != nil {
		return port.JournalChanged
	}
	for _, info := range []os.FileInfo{anchorNamed, anchorHeld} {
		state, ok := metadata(info)
		if !ok || !privateDirectory(info, state) || state.directoryObject() != r.ancestorState {
			return port.JournalChanged
		}
	}
	named, err := os.Lstat(r.path)
	if err != nil {
		return port.JournalChanged
	}
	held, err := r.parent.Stat()
	if err != nil {
		return port.JournalChanged
	}
	rootInfo, err := r.root.Lstat(".")
	if err != nil {
		return port.JournalChanged
	}
	for _, info := range []os.FileInfo{named, held, rootInfo} {
		state, ok := metadata(info)
		if !ok || !privateDirectory(info, state) || state.directoryObject() != r.directory {
			return port.JournalChanged
		}
	}
	return nil
}

func (r *Repo) checkpoint(point string) error {
	if r.step == nil {
		return nil
	}
	return r.step(point)
}

func (r *Repo) retainUnknown() error {
	r.unknown = true
	r.admission.RetainJournalUnknown(r.operation)
	return port.JournalUnknown
}

func (r *Repo) Close() error {
	r.gate.Lock()
	defer r.gate.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	a, b, c := r.parent.Close(), r.root.Close(), r.ancestor.Close()
	if a != nil || b != nil || c != nil {
		return port.JournalUnavailable
	}
	return nil
}

func record(value release.Journal) records.Journal {
	mapBuild := func(b release.Build) records.Build {
		return records.Build{Digest: b.Digest, Version: b.Version, BuildID: b.BuildID}
	}
	return records.Journal{Schema: "farol.installed-update-journal/1", Operation: records.Operation{ID: value.Operation.ID, Source: mapBuild(value.Operation.Source), Target: mapBuild(value.Operation.Target)}, Phase: value.Phase}
}

func (r *Repo) revision(state *fileState, data []byte) string {
	directory := r.directory
	h := sha256.New()
	bound, _ := records.EncodeJournal(record(release.Journal{Operation: r.operation, Phase: "prepared"}))
	h.Write(bound)
	h.Write([]byte(strconv.FormatUint(r.ancestorState.Device, 10) + "\n" + strconv.FormatUint(r.ancestorState.Inode, 10) + "\n"))
	// All fields have fixed numeric encodings or bounded encoded journal bytes.
	if state == nil {
		h.Write([]byte("absent\n"))
	} else {
		h.Write([]byte("present\n"))
		h.Write([]byte(strconv.FormatUint(state.Device, 10) + "\n" + strconv.FormatUint(state.Inode, 10) + "\n" +
			strconv.FormatUint(state.UID, 10) + "\n" + strconv.FormatUint(state.GID, 10) + "\n" + strconv.FormatUint(state.Links, 10) + "\n" +
			strconv.FormatUint(uint64(state.Mode), 10) + "\n" + strconv.FormatInt(state.Size, 10) + "\n" +
			strconv.FormatInt(state.ModifiedSeconds, 10) + "\n" + strconv.FormatInt(state.ModifiedNanos, 10) + "\n" +
			strconv.FormatInt(state.ChangedSeconds, 10) + "\n" + strconv.FormatInt(state.ChangedNanos, 10) + "\n"))
	}
	h.Write([]byte(strconv.FormatUint(directory.Device, 10) + "\n" + strconv.FormatUint(directory.Inode, 10) + "\n" + strconv.FormatUint(directory.UID, 10) + "\n" + strconv.FormatUint(directory.GID, 10) + "\n" + strconv.FormatUint(uint64(directory.Mode), 10) + "\n"))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}
