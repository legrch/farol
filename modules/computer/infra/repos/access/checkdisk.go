package access

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"

	check "github.com/legrch/farol/modules/computer/domain/connector"
	"golang.org/x/sys/unix"
)

// Connection checks reuse the existing protected Computer Store's native
// lifetime lock, current snapshot ownership and fsync/descriptor discipline.
// This independent presence witness cannot alter the C4 journal lock marker.
const connectionCheckName = "computer-connection-check.json"
const connectionCheckWitnessName = "computer-connection-check.present"
const connectionCheckWitnessPayload = "C\n"
const connectionCheckMaxBytes = 128 * 1024

type connectionCheckDocument struct {
	Schema     int           `json:"schema"`
	ProfileID  string        `json:"profileId"`
	OwnerID    string        `json:"ownerId"`
	ComputerID string        `json:"computerId"`
	Entries    []check.Entry `json:"entries"`
}

func encodeConnectionChecks(b Binding, value check.Journal) ([]byte, error) {
	if !value.Valid() {
		return nil, unavailable()
	}
	raw, err := json.Marshal(connectionCheckDocument{
		Schema: 1, ProfileID: b.ProfileID, OwnerID: b.OwnerID,
		ComputerID: b.ComputerID, Entries: value.Entries,
	})
	if err != nil || len(raw)+1 > connectionCheckMaxBytes {
		return nil, refuse(err)
	}
	return append(raw, '\n'), nil
}

func decodeConnectionChecks(b Binding, raw []byte) (check.Journal, error) {
	empty := check.Journal{}
	if len(raw) == 0 || len(raw) > connectionCheckMaxBytes {
		return empty, unavailable()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var doc connectionCheckDocument
	if decoder.Decode(&doc) != nil || doc.Schema != 1 ||
		doc.ProfileID != b.ProfileID || doc.OwnerID != b.OwnerID ||
		doc.ComputerID != b.ComputerID {
		return empty, unavailable()
	}
	value := check.Journal{Entries: doc.Entries}
	// Canonical equality rejects duplicate/unknown keys, foreign binding,
	// alternate representations and trailing bytes.
	expected, err := encodeConnectionChecks(b, value)
	if err != nil || !bytes.Equal(expected, raw) {
		return empty, unavailable()
	}
	return value, nil
}

// connectionCheckWitness is a separate protected, permanently retained first-presence
// observation. A malformed marker is never interpreted as an absent marker.
func (d *disk) connectionCheckWitness() (present bool, err error) {
	if err = d.check(); err != nil {
		return false, err
	}
	fd, e := unix.Openat(d.dir, connectionCheckWitnessName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(e, unix.ENOENT) {
		return false, nil
	}
	if e != nil {
		return false, refuse(e)
	}
	file := os.NewFile(uintptr(fd), connectionCheckWitnessName)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			present, err = false, refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(connectionCheckWitnessPayload)) {
		return false, refuse(e)
	}
	raw, e := io.ReadAll(io.LimitReader(file, int64(len(connectionCheckWitnessPayload)+1)))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || string(raw) != connectionCheckWitnessPayload || !stableState(before, after) {
		return false, refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, connectionCheckWitnessName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
		!stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return false, refuse(e)
	}
	if e = d.check(); e != nil {
		return false, e
	}
	return true, nil
}

// markConnectionCheckWitness MUST finish before first ledger file creation. A crash after
// the witness but before the original admission leaves a restrictive orphan.
// It is never converted to empty history or retried as a fresh Stop.
func (d *disk) markConnectionCheckWitness() error {
	found, err := d.connectionCheckWitness()
	if err != nil || found {
		return refuse(err)
	}
	fd, err := unix.Openat(d.dir, connectionCheckWitnessName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	file := os.NewFile(uintptr(fd), connectionCheckWitnessName)
	n, written := file.Write([]byte(connectionCheckWitnessPayload))
	if written == nil && n != len(connectionCheckWitnessPayload) {
		written = io.ErrShortWrite
	}
	if written == nil {
		written = file.Sync()
	}
	closed := d.closeFile(file)
	if written != nil || closed != nil {
		return &CommitFailure{Unknown: true, cause: errors.Join(written, closed)}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	found, err = d.connectionCheckWitness()
	if err != nil || !found {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

func (d *disk) readConnectionChecks() (raw []byte, err error) {
	if err = d.check(); err != nil {
		return nil, err
	}
	fd, e := unix.Openat(d.dir, connectionCheckName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(e, unix.ENOENT) {
		return nil, os.ErrNotExist
	}
	if e != nil {
		return nil, refuse(e)
	}
	file := os.NewFile(uintptr(fd), connectionCheckName)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			raw, err = nil, refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) ||
		before.Size < 1 || before.Size > connectionCheckMaxBytes {
		return nil, refuse(e)
	}
	raw, e = io.ReadAll(io.LimitReader(file, connectionCheckMaxBytes+1))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || len(raw) == 0 ||
		len(raw) > connectionCheckMaxBytes || !stableState(before, after) {
		return nil, refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, connectionCheckName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
		!stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return nil, refuse(e)
	}
	if e = d.check(); e != nil {
		return nil, e
	}
	return raw, nil
}

// qualifyConnectionChecks observes CURRENT durability after restart without changing
// an original effect, reconstructing caller delivery or completing a phase.
func (d *disk) qualifyConnectionChecks(expected []byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	fd, e := unix.Openat(d.dir, connectionCheckName, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return refuse(e)
	}
	file := os.NewFile(uintptr(fd), connectionCheckName)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			err = refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(expected)) {
		return refuse(e)
	}
	actual, e := io.ReadAll(io.LimitReader(file, connectionCheckMaxBytes+1))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || !bytes.Equal(actual, expected) || !stableState(before, after) {
		return refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, connectionCheckName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
		!stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return refuse(e)
	}
	if err = d.syncSnapshot(fd); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	last, e := d.readConnectionChecks()
	if e != nil || !bytes.Equal(last, expected) {
		return &CommitFailure{Unknown: true, cause: e}
	}
	marked, e := d.connectionCheckWitness()
	if e != nil || !marked {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}

func (d *disk) beginConnectionChecks(raw []byte) error {
	if err := d.check(); err != nil {
		return err
	}
	marked, err := d.connectionCheckWitness()
	if err != nil || !marked {
		return refuse(err)
	}
	if _, err = d.readConnectionChecks(); !errors.Is(err, os.ErrNotExist) {
		return refuse(err)
	}
	fd, err := unix.Openat(d.dir, connectionCheckName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	file := os.NewFile(uintptr(fd), connectionCheckName)
	n, written := file.Write(raw)
	if written == nil && n != len(raw) {
		written = io.ErrShortWrite
	}
	if written == nil {
		written = file.Sync()
	}
	closed := d.closeFile(file)
	if written != nil || closed != nil {
		return &CommitFailure{Unknown: true, cause: errors.Join(written, closed)}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.qualifyConnectionChecks(raw); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

// updateConnectionChecks uses the existing descriptor-relative Store owner and CAS
// digest. Errors after a possible rename are UNKNOWN; same visible bytes are
// never sufficient to infer an original Stop/Settings/cleanup ACK.
func (d *disk) updateConnectionChecks(raw []byte, expected [32]byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	current, e := d.readConnectionChecks()
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	var token [16]byte
	if _, e = rand.Read(token[:]); e != nil {
		return refuse(e)
	}
	name := ".computer-connection-check-" + hex.EncodeToString(token[:]) + ".tmp"
	fd, e := unix.Openat(d.dir, name, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if e != nil {
		return refuse(e)
	}
	file := os.NewFile(uintptr(fd), name)
	renamed := false
	defer func() {
		if !renamed {
			if removed := unix.Unlinkat(d.dir, name, 0); removed != nil && !errors.Is(removed, unix.ENOENT) {
				err = &CommitFailure{Unknown: true, cause: errors.Join(err, removed)}
			}
		}
	}()
	n, written := file.Write(raw)
	if written == nil && n != len(raw) {
		written = io.ErrShortWrite
	}
	if written == nil {
		written = file.Sync()
	}
	closed := d.closeFile(file)
	if written != nil || closed != nil {
		return refuse(written, closed)
	}
	if e = d.check(); e != nil {
		return e
	}
	current, e = d.readConnectionChecks()
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	marked, e := d.connectionCheckWitness()
	if e != nil || !marked {
		return refuse(e)
	}
	if e = unix.Renameat(d.dir, name, d.dir, connectionCheckName); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	renamed = true
	if e = d.syncDirectory(d.dir); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e = d.qualifyConnectionChecks(raw); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}
