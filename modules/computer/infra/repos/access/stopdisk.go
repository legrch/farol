package access

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	stop "github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/pkg/limit"
	"golang.org/x/sys/unix"
)

// This record family shares the existing access Store's lifetime flock and
// mutex. Its independent first-presence witness never changes the C4 lock byte.
const stopLedgerName = "computer-stop-prerequisite.json"
const stopWitnessName = "computer-stop-prerequisite.present"
const stopWitnessPayload = "P\n"
const stopLedgerMaxBytes = 128 * 1024

type stopDocument struct {
	Schema     int              `json:"schema"`
	ProfileID  string           `json:"profileId"`
	OwnerID    string           `json:"ownerId"`
	ComputerID string           `json:"computerId"`
	Entries    []stop.StopEntry `json:"entries"`
}

func encodeStopLedger(b Binding, value stop.StopLedger) ([]byte, error) {
	if !value.Valid() {
		return nil, unavailable()
	}
	raw, err := json.Marshal(stopDocument{
		Schema: 1, ProfileID: b.ProfileID, OwnerID: b.OwnerID,
		ComputerID: b.ComputerID, Entries: value.Entries,
	})
	if err != nil || len(raw)+1 > stopLedgerMaxBytes {
		return nil, refuse(err)
	}
	return append(raw, '\n'), nil
}

// Reserve the serialized union of all possible later fields, including UNKNOWN
// and refusal metadata. This is sizing only, never a receipt or valid history.
// Fixed request fields retain their actual JSON escaping; future identifiers,
// digests and decimal counters have the closed syntax/limits in StopEntry.Valid.
func stopCompletionCapacity(raw []byte, entry stop.StopEntry) bool {
	admission, err := json.Marshal(entry)
	if err != nil {
		return false
	}
	r := entry.Request
	decimal := strings.Repeat("9", 20)
	digest := strings.Repeat("a", 64)
	uuid := "11111111-1111-4111-8111-111111111111"
	entry.Phase = stop.StopComplete
	entry.Closure = &stop.StopClosure{EffectID: r.StopEffectID, BackendGeneration: r.BackendGeneration, RuntimeID: r.RuntimeID, LifecycleID: uuid, StopRevision: decimal, PreparationRevision: decimal, ClosureOperationID: uuid, ClosureDigest: digest}
	entry.SettingsIntent = &stop.StopSettingsPlan{EffectID: r.SettingsEffectID, ExpectedRevision: r.ExpectedRevision, ExpectedDigest: r.SettingsDigest, NextRevision: decimal, NextDigest: digest, ComputerGeneration: r.ComputerGeneration, ConnectorGeneration: r.ConnectorGeneration, ConsentDigest: r.ConsentDigest}
	entry.SettingsAck = &stop.StopSettingsReceipt{EffectID: r.SettingsEffectID, Revision: decimal, DocumentDigest: digest, ComputerGeneration: r.ComputerGeneration, ConnectorGeneration: r.ConnectorGeneration, ConsentDigest: r.ConsentDigest}
	entry.CleanupAck = &stop.StopCleanupReceipt{EffectID: r.CleanupEffectID, BackendGeneration: r.BackendGeneration, RuntimeID: r.RuntimeID, Digest: digest}
	entry.Refusal = "cancelled_before_dispatch"
	entry.UnresolvedAt = stop.StopAdmissionIntent
	entry.Uncertainty = "settings_unconfirmed"
	maximum, err := json.Marshal(entry)
	return err == nil && len(raw)-len(admission)+len(maximum) <= stopLedgerMaxBytes
}

func decodeStopLedger(b Binding, raw []byte) (stop.StopLedger, error) {
	empty := stop.StopLedger{}
	if len(raw) == 0 || len(raw) > stopLedgerMaxBytes {
		return empty, unavailable()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var doc stopDocument
	if decoder.Decode(&doc) != nil || doc.Schema != 1 ||
		doc.ProfileID != b.ProfileID || doc.OwnerID != b.OwnerID ||
		doc.ComputerID != b.ComputerID {
		return empty, unavailable()
	}
	value := stop.StopLedger{Entries: doc.Entries}
	// Byte-for-byte canonical equality rejects duplicated keys, excess data,
	// alternate encodings, and keys absent from the closed current schema.
	expected, err := encodeStopLedger(b, value)
	if err != nil || !bytes.Equal(expected, raw) {
		return empty, unavailable()
	}
	return value, nil
}

// stopWitness is a separate protected, permanently retained first-presence
// observation. A malformed marker is never interpreted as an absent marker.
func (d *disk) stopWitness() (present bool, err error) {
	if err = d.check(); err != nil {
		return false, err
	}
	fd, e := unix.Openat(d.dir, stopWitnessName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(e, unix.ENOENT) {
		return false, nil
	}
	if e != nil {
		return false, refuse(e)
	}
	file := os.NewFile(uintptr(fd), stopWitnessName)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			present, err = false, refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(stopWitnessPayload)) {
		return false, refuse(e)
	}
	raw, e := limit.Read(file, int64(len(stopWitnessPayload)))
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || string(raw) != stopWitnessPayload || !stableState(before, after) {
		return false, refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, stopWitnessName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
		!stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return false, refuse(e)
	}
	if e = d.check(); e != nil {
		return false, e
	}
	return true, nil
}

// markStopWitness MUST finish before first ledger file creation. A crash after
// the witness but before the original admission leaves a restrictive orphan.
// It is never converted to empty history or retried as a fresh Stop.
func (d *disk) markStopWitness() error {
	found, err := d.stopWitness()
	if err != nil || found {
		return refuse(err)
	}
	fd, err := unix.Openat(d.dir, stopWitnessName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	file := os.NewFile(uintptr(fd), stopWitnessName)
	n, written := file.Write([]byte(stopWitnessPayload))
	if written == nil && n != len(stopWitnessPayload) {
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
	found, err = d.stopWitness()
	if err != nil || !found {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

func (d *disk) readStopLedger() (raw []byte, err error) {
	if err = d.check(); err != nil {
		return nil, err
	}
	fd, e := unix.Openat(d.dir, stopLedgerName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(e, unix.ENOENT) {
		return nil, os.ErrNotExist
	}
	if e != nil {
		return nil, refuse(e)
	}
	file := os.NewFile(uintptr(fd), stopLedgerName)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			raw, err = nil, refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) ||
		before.Size < 1 || before.Size > stopLedgerMaxBytes {
		return nil, refuse(e)
	}
	raw, e = limit.Read(file, stopLedgerMaxBytes)
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || len(raw) == 0 ||
		!stableState(before, after) {
		return nil, refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, stopLedgerName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
		!stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return nil, refuse(e)
	}
	if e = d.check(); e != nil {
		return nil, e
	}
	return raw, nil
}

// qualifyStopLedger observes CURRENT durability after restart without changing
// an original effect, reconstructing caller delivery or completing a phase.
func (d *disk) qualifyStopLedger(expected []byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	fd, e := unix.Openat(d.dir, stopLedgerName, unix.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if e != nil {
		return refuse(e)
	}
	file := os.NewFile(uintptr(fd), stopLedgerName)
	defer func() {
		if closed := d.closeFile(file); closed != nil {
			err = refuse(err, closed)
		}
	}()
	before, e := fdstat(fd)
	if e != nil || !private(before, unix.S_IFREG, 0600) || before.Size != int64(len(expected)) {
		return refuse(e)
	}
	actual, e := limit.Read(file, stopLedgerMaxBytes)
	after, statErr := fdstat(fd)
	var named unix.Stat_t
	if e != nil || statErr != nil || !bytes.Equal(actual, expected) || !stableState(before, after) {
		return refuse(e, statErr)
	}
	if e = unix.Fstatat(d.dir, stopLedgerName, &named, unix.AT_SYMLINK_NOFOLLOW); e != nil ||
		!stableState(named, after) || !private(named, unix.S_IFREG, 0600) {
		return refuse(e)
	}
	if err = d.syncSnapshot(fd); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	if err = d.syncDirectory(d.dir); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	last, e := d.readStopLedger()
	if e != nil || !bytes.Equal(last, expected) {
		return &CommitFailure{Unknown: true, cause: e}
	}
	marked, e := d.stopWitness()
	if e != nil || !marked {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}

func (d *disk) beginStopLedger(raw []byte) error {
	if err := d.check(); err != nil {
		return err
	}
	marked, err := d.stopWitness()
	if err != nil || !marked {
		return refuse(err)
	}
	if _, err = d.readStopLedger(); !errors.Is(err, os.ErrNotExist) {
		return refuse(err)
	}
	fd, err := unix.Openat(d.dir, stopLedgerName,
		unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return refuse(err)
	}
	file := os.NewFile(uintptr(fd), stopLedgerName)
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
	if err = d.qualifyStopLedger(raw); err != nil {
		return &CommitFailure{Unknown: true, cause: err}
	}
	return nil
}

// updateStopLedger uses the existing descriptor-relative Store owner and CAS
// digest. Errors after a possible rename are UNKNOWN; same visible bytes are
// never sufficient to infer an original Stop/Settings/cleanup ACK.
func (d *disk) updateStopLedger(raw []byte, expected [32]byte) (err error) {
	if err = d.check(); err != nil {
		return err
	}
	current, e := d.readStopLedger()
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	var token [16]byte
	if _, e = rand.Read(token[:]); e != nil {
		return refuse(e)
	}
	name := ".computer-stop-prerequisite-" + hex.EncodeToString(token[:]) + ".tmp"
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
	current, e = d.readStopLedger()
	if e != nil || digest(current) != expected {
		return refuse(e)
	}
	marked, e := d.stopWitness()
	if e != nil || !marked {
		return refuse(e)
	}
	if e = unix.Renameat(d.dir, name, d.dir, stopLedgerName); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	renamed = true
	if e = d.syncDirectory(d.dir); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	if e = d.qualifyStopLedger(raw); e != nil {
		return &CommitFailure{Unknown: true, cause: e}
	}
	return nil
}
