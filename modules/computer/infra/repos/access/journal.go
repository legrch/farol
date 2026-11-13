package access

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"

	transition "github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/pkg/descriptor"
	"golang.org/x/sys/unix"
)

// Private, descriptor-relative WAL under the existing access lifetime lock.
// The lock file also contains a one-byte existence witness: loss of the WAL
// after one confirmed intent never silently restores a legacy empty journal.
const transitionName = "computer-transition.json"
const transitionMaxBytes = 256 * 1024
const journalMarker = "J"

type journalDocument struct {
	Schema     int                `json:"schema"`
	ProfileID  string             `json:"profileId"`
	OwnerID    string             `json:"ownerId"`
	ComputerID string             `json:"computerId"`
	Entries    []transition.Entry `json:"entries"`
}

// Schema-1 remains byte-for-byte canonical for historical entries. A linked
// child upgrades the entire document to schema-2 in its SINGLE C4 WAL append;
// earlier entries retain their original absent link fields.
func journalSchema(value transition.Journal) int {
	for _, entry := range value.Entries {
		if entry.Parent != nil {
			return 2
		}
	}
	return 1
}

func encodeJournal(binding Binding, value transition.Journal) ([]byte, error) {
	if !value.Valid() {
		return nil, unavailable()
	}
	raw, err := json.Marshal(journalDocument{Schema: journalSchema(value), ProfileID: binding.ProfileID, OwnerID: binding.OwnerID, ComputerID: binding.ComputerID, Entries: value.Entries})
	if err != nil || len(raw)+1 > transitionMaxBytes {
		return nil, refuse(err)
	}
	return append(raw, '\n'), nil
}
func decodeJournal(binding Binding, raw []byte) (transition.Journal, error) {
	out := transition.Journal{}
	if len(raw) == 0 || len(raw) > transitionMaxBytes {
		return out, unavailable()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var doc journalDocument
	if decoder.Decode(&doc) != nil || (doc.Schema != 1 && doc.Schema != 2) || doc.ProfileID != binding.ProfileID || doc.OwnerID != binding.OwnerID || doc.ComputerID != binding.ComputerID {
		return out, unavailable()
	}
	// Own publication always uses a unique canonical JSON encoding. This also
	// rejects duplicate fields, alternative numeric spellings and trailing data.
	out = transition.Journal{Entries: doc.Entries}
	// A prior schema-1 reader may never invent a parent certificate, while a
	// schema-2 reader must not accept a silently downgraded/unlinked document.
	if doc.Schema != journalSchema(out) {
		return transition.Journal{}, unavailable()
	}
	expected, err := encodeJournal(binding, out)
	if err != nil || !bytes.Equal(expected, raw) {
		return transition.Journal{}, unavailable()
	}
	return out, nil
}

func (d *disk) journalMarked() (bool, error) {
	if err := d.check(); err != nil {
		return false, err
	}
	var info unix.Stat_t
	if err := unix.Fstat(d.lock, &info); err != nil || info.Size < 0 || info.Size > 1 {
		return false, refuse(err)
	}
	if info.Size == 0 {
		return false, nil
	}
	var b [1]byte
	if n, e := unix.Pread(d.lock, b[:], 0); e != nil || n != 1 || string(b[:]) != journalMarker {
		return false, refuse(e)
	}
	return true, nil
}
func (d *disk) markJournal() error {
	current, err := d.journalMarked()
	if err != nil {
		return err
	}
	if current {
		return nil
	}
	if n, e := unix.Pwrite(d.lock, []byte(journalMarker), 0); e != nil || n != 1 {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e := unix.Fsync(d.lock); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	ok, e := d.journalMarked()
	if e != nil || !ok {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}

func (d *disk) readJournal() (raw []byte, err error) {
	if err = d.check(); err != nil {
		return nil, err
	}
	fd, e := unix.Openat(d.dir, transitionName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(e, unix.ENOENT) {
		return nil, os.ErrNotExist
	}
	if e != nil {
		return nil, refuse(e)
	}
	f := os.NewFile(uintptr(fd), transitionName)
	defer func() {
		if closed := d.closeFile(f); closed != nil {
			raw, err = nil, refuse(err, closed)
		}
	}()
	before, e := descriptor.Stat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) || before.Size < 1 || before.Size > transitionMaxBytes {
		return nil, refuse(e)
	}
	raw, e = io.ReadAll(io.LimitReader(f, transitionMaxBytes+1))
	if e != nil || len(raw) > transitionMaxBytes {
		return nil, refuse(e)
	}
	after, e := descriptor.Stat(fd)
	var named unix.Stat_t
	if e != nil || !descriptor.Stable(before, after) {
		return nil, refuse(e)
	}
	if e = unix.Fstatat(d.dir, transitionName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil || !descriptor.Stable(named, after) || !private(named, unix.S_IFREG, 0600) {
		return nil, refuse(e)
	}
	if e = d.check(); e != nil {
		return nil, e
	}
	return raw, nil
}

// qualifyJournal is restart-current fsync, directory fsync, exact readback;
// no logical effect, prior caller acknowledgement or grant is replayed.
func (d *disk) qualifyJournal(raw []byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	fd, e := unix.Openat(d.dir, transitionName, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return refuse(e)
	}
	f := os.NewFile(uintptr(fd), transitionName)
	defer func() {
		if closeErr := d.closeFile(f); closeErr != nil {
			err = refuse(err, closeErr)
		}
	}()
	before, e := descriptor.Stat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(raw)) {
		return refuse(e)
	}
	bytesRead, e := io.ReadAll(io.LimitReader(f, transitionMaxBytes+1))
	after, statErr := descriptor.Stat(fd)
	if e != nil || statErr != nil || !bytes.Equal(bytesRead, raw) || !descriptor.Stable(before, after) {
		return refuse(e, statErr)
	}
	if err = d.syncSnapshot(fd); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	last, e := d.readJournal()
	if e != nil || !bytes.Equal(last, raw) {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}

// beginJournal publishes the very FIRST intent via O_EXCL, confirms exact
// bytes, then marks the locked owner. An uncertain first write never allows
// acquiring any workspace or anchor handles in that runtime.
func (d *disk) beginJournal(raw []byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	fd, e := unix.Openat(d.dir, transitionName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		return refuse(e)
	}
	f := os.NewFile(uintptr(fd), transitionName)
	_, writeErr := f.Write(raw)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := d.closeFile(f)
	if writeErr != nil || closeErr != nil {
		return &CommitFailure{Unknown: true, cause: errors.Join(writeErr, closeErr)}
	}
	if e = d.syncDirectory(d.dir); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e = d.qualifyJournal(raw); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e = d.markJournal(); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}

func (d *disk) updateJournal(raw []byte, expected [32]byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	current, e := d.readJournal()
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	name, e := descriptor.Name(".computer-transition-", 16, ".tmp")
	if e != nil {
		return refuse(e)
	}
	fd, e := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		return refuse(e)
	}
	f := os.NewFile(uintptr(fd), name)
	renamed := false
	defer func() {
		if !renamed {
			if e := unix.Unlinkat(d.dir, name, 0); e != nil && !errors.Is(e, unix.ENOENT) {
				err = &CommitFailure{Unknown: true, cause: errors.Join(err, e)}
			}
		}
	}()
	_, e = f.Write(raw)
	if e == nil {
		e = f.Sync()
	}
	closeErr := d.closeFile(f)
	if e != nil || closeErr != nil {
		return refuse(e, closeErr)
	}
	if e = d.check(); e != nil {
		return e
	}
	current, e = d.readJournal()
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	if e = unix.Renameat(d.dir, name, d.dir, transitionName); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	renamed = true
	if e = d.syncDirectory(d.dir); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e = d.qualifyJournal(raw); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}
