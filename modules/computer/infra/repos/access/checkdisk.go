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

// checkJournalFile names one connection-check journal file and its witness.
//
// legacyCheckFile is the schema-1 journal that the retained predecessor image
// (0.5.24) reads while it opens the Store: it refuses the WHOLE Store when that
// journal holds more than 48 entries or more than one entry that is not
// verified or refused_before_send. This build therefore only reads it: it stays
// exactly as the predecessor last wrote it, so a rollback always opens.
//
// historyCheckFile is this build's complete schema-2 history. The predecessor
// never opens it. It has no entry or byte bound: an attempt is never dropped
// or refused because of history size.
type checkJournalFile struct {
	name, witness, temporary string
	maxBytes                 int64 // 0: no bound
}

var legacyCheckFile = checkJournalFile{connectionCheckName, connectionCheckWitnessName, ".computer-connection-check-", connectionCheckMaxBytes}
var historyCheckFile = checkJournalFile{"computer-connection-check-history.json", "computer-connection-check-history.present", ".computer-connection-check-history-", 0}

type connectionCheckDocument struct {
	Schema     int           `json:"schema"`
	ProfileID  string        `json:"profileId"`
	OwnerID    string        `json:"ownerId"`
	ComputerID string        `json:"computerId"`
	Entries    []check.Entry `json:"entries"`
}

// connectionCheckHistoryDocument records the exact predecessor journal bytes it
// last absorbed (LegacyDigest, empty when there was none). Different current
// bytes mean the predecessor ran after that, and its attempts are imported.
type connectionCheckHistoryDocument struct {
	Schema       int           `json:"schema"`
	ProfileID    string        `json:"profileId"`
	OwnerID      string        `json:"ownerId"`
	ComputerID   string        `json:"computerId"`
	LegacyDigest string        `json:"legacyDigest"`
	Entries      []check.Entry `json:"entries"`
}

// encodeConnectionChecks is the predecessor's schema-1 encoding. This build
// uses it only to check that a predecessor journal is canonical.
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

func validLegacyDigest(value string) bool {
	if value == "" {
		return true
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32 && hex.EncodeToString(decoded) == value
}

func encodeConnectionCheckHistory(b Binding, value check.Journal, legacyDigest string) ([]byte, error) {
	if !value.Valid() || !validLegacyDigest(legacyDigest) {
		return nil, unavailable()
	}
	raw, err := json.Marshal(connectionCheckHistoryDocument{
		Schema: 2, ProfileID: b.ProfileID, OwnerID: b.OwnerID,
		ComputerID: b.ComputerID, LegacyDigest: legacyDigest, Entries: value.Entries,
	})
	if err != nil {
		return nil, refuse(err)
	}
	return append(raw, '\n'), nil
}

func decodeConnectionCheckHistory(b Binding, raw []byte) (check.Journal, string, error) {
	empty := check.Journal{}
	if len(raw) == 0 {
		return empty, "", unavailable()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var doc connectionCheckHistoryDocument
	if decoder.Decode(&doc) != nil || doc.Schema != 2 ||
		doc.ProfileID != b.ProfileID || doc.OwnerID != b.OwnerID ||
		doc.ComputerID != b.ComputerID {
		return empty, "", unavailable()
	}
	value := check.Journal{Entries: doc.Entries}
	expected, err := encodeConnectionCheckHistory(b, value, doc.LegacyDigest)
	if err != nil || !bytes.Equal(expected, raw) {
		return empty, "", unavailable()
	}
	return value, doc.LegacyDigest, nil
}

// connectionCheckWitness is a separate protected, permanently retained first-presence
// observation. A malformed marker is never interpreted as an absent marker.
func (d *disk) connectionCheckWitness(f checkJournalFile) (present bool, err error) {
	if err = d.check(); err != nil {
		return false, err
	}
	fd, e := unix.Openat(d.dir, f.witness, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(e, unix.ENOENT) {
		return false, nil
	}
	if e != nil {
		return false, refuse(e)
	}
	file := os.NewFile(uintptr(fd), f.witness)
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
	if e = unix.Fstatat(d.dir, f.witness, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
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
func (d *disk) markConnectionCheckWitness(f checkJournalFile) error {
	found, err := d.connectionCheckWitness(f)
	if err != nil || found {
		return refuse(err)
	}
	fd, err := unix.Openat(d.dir, f.witness,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	file := os.NewFile(uintptr(fd), f.witness)
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
	found, err = d.connectionCheckWitness(f)
	if err != nil || !found {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

func (d *disk) readConnectionChecks(f checkJournalFile) (raw []byte, err error) {
	if err = d.check(); err != nil {
		return nil, err
	}
	fd, e := unix.Openat(d.dir, f.name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(e, unix.ENOENT) {
		return nil, os.ErrNotExist
	}
	if e != nil {
		return nil, refuse(e)
	}
	file := os.NewFile(uintptr(fd), f.name)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			raw, err = nil, refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) ||
		before.Size < 1 || (f.maxBytes > 0 && before.Size > f.maxBytes) {
		return nil, refuse(e)
	}
	limit := before.Size
	raw, e = io.ReadAll(io.LimitReader(file, limit+1))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || len(raw) == 0 ||
		int64(len(raw)) > limit || !stableState(before, after) {
		return nil, refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, f.name, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
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
func (d *disk) qualifyConnectionChecks(f checkJournalFile, expected []byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	fd, e := unix.Openat(d.dir, f.name, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return refuse(e)
	}
	file := os.NewFile(uintptr(fd), f.name)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			err = refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(expected)) {
		return refuse(e)
	}
	actual, e := io.ReadAll(io.LimitReader(file, int64(len(expected))+1))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || !bytes.Equal(actual, expected) || !stableState(before, after) {
		return refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, f.name, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
		!stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return refuse(e)
	}
	if err = d.syncSnapshot(fd); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	last, e := d.readConnectionChecks(f)
	if e != nil || !bytes.Equal(last, expected) {
		return &CommitFailure{Unknown: true, cause: e}
	}
	marked, e := d.connectionCheckWitness(f)
	if e != nil || !marked {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}

func (d *disk) beginConnectionChecks(f checkJournalFile, raw []byte) error {
	if err := d.check(); err != nil {
		return err
	}
	marked, err := d.connectionCheckWitness(f)
	if err != nil || !marked {
		return refuse(err)
	}
	if _, err = d.readConnectionChecks(f); !errors.Is(err, os.ErrNotExist) {
		return refuse(err)
	}
	fd, err := unix.Openat(d.dir, f.name,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	file := os.NewFile(uintptr(fd), f.name)
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
	if err = d.qualifyConnectionChecks(f, raw); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

// updateConnectionChecks uses the existing descriptor-relative Store owner and CAS
// digest. Errors after a possible rename are UNKNOWN; same visible bytes are
// never sufficient to infer an original Stop/Settings/cleanup ACK.
func (d *disk) updateConnectionChecks(f checkJournalFile, raw []byte, expected [32]byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	current, e := d.readConnectionChecks(f)
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	var token [16]byte
	if _, e = rand.Read(token[:]); e != nil {
		return refuse(e)
	}
	name := f.temporary + hex.EncodeToString(token[:]) + ".tmp"
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
	current, e = d.readConnectionChecks(f)
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	marked, e := d.connectionCheckWitness(f)
	if e != nil || !marked {
		return refuse(e)
	}
	if e = unix.Renameat(d.dir, name, d.dir, f.name); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	renamed = true
	if e = d.syncDirectory(d.dir); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e = d.qualifyConnectionChecks(f, raw); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}
