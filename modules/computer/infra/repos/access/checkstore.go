package access

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"

	check "github.com/legrch/farol/modules/computer/domain/connector"
)

// The existing Store's lifetime mutex/flock is the only owner of original
// explicit connection-check records. It does not create another approval or
// persist browser/app credentials. A distinct first-presence witness is durable.
//
// Two files hold the records. The predecessor journal (0.5.24, schema 1) is
// only read, so a rollback finds exactly what the predecessor last wrote. The
// full history (schema 2) is the source of truth; its first write absorbs the
// predecessor journal, and a later change to that journal (a rollback that ran
// checks, then a roll-forward) is imported, never ignored.
func (s *Store) restoreConnectionChecks() error {
	legacy, legacyDigest, err := s.readLegacyConnectionChecks(true)
	if err != nil {
		return err
	}
	marked, err := s.disk.connectionCheckWitness(historyCheckFile)
	if err != nil {
		return err
	}
	raw, err := s.disk.readConnectionChecks(historyCheckFile)
	if !marked && errors.Is(err, os.ErrNotExist) {
		s.checks, s.checksLegacy = legacy, legacyDigest
		return nil
	}
	if !marked || err != nil {
		return unavailable()
	}
	parsed, recorded, err := decodeConnectionCheckHistory(s.binding, raw)
	if err != nil {
		return err
	}
	if err = s.disk.qualifyConnectionChecks(historyCheckFile, raw); err != nil {
		return err
	}
	if recorded != legacyDigest {
		// A predecessor journal cannot disappear once absorbed: its own
		// witness forbids that. Different bytes are the predecessor's own
		// later attempts; they persist with this history's next write.
		if recorded != "" && legacyDigest == "" {
			return unavailable()
		}
		if parsed, err = parsed.Import(legacy); err != nil {
			return unavailable()
		}
	}
	s.checks, s.checksPresent, s.checksDigest, s.checksLegacy = parsed, true, digest(raw), legacyDigest
	return nil
}

// readLegacyConnectionChecks reads the predecessor journal exactly as the
// predecessor does, without ever writing it. qualify re-syncs its unchanged
// bytes at restore, as the predecessor itself does.
func (s *Store) readLegacyConnectionChecks(qualify bool) (check.Journal, string, error) {
	empty := check.Journal{Entries: []check.Entry{}}
	marked, err := s.disk.connectionCheckWitness(legacyCheckFile)
	if err != nil {
		return check.Journal{}, "", err
	}
	raw, err := s.disk.readConnectionChecks(legacyCheckFile)
	if !marked && errors.Is(err, os.ErrNotExist) {
		return empty, "", nil
	}
	if !marked || err != nil {
		return check.Journal{}, "", unavailable()
	}
	parsed, err := decodeConnectionChecks(s.binding, raw)
	if err != nil {
		return check.Journal{}, "", err
	}
	if qualify {
		if err = s.disk.qualifyConnectionChecks(legacyCheckFile, raw); err != nil {
			return check.Journal{}, "", err
		}
	}
	sum := digest(raw)
	return parsed, hex.EncodeToString(sum[:]), nil
}
func (s *Store) checkConnectionStorage() error {
	if _, legacy, err := s.readLegacyConnectionChecks(false); err != nil || legacy != s.checksLegacy {
		s.poisoned = true
		return refuse(err)
	}
	marked, err := s.disk.connectionCheckWitness(historyCheckFile)
	if err != nil {
		s.poisoned = true
		return err
	}
	raw, err := s.disk.readConnectionChecks(historyCheckFile)
	if !s.checksPresent {
		if marked || !errors.Is(err, os.ErrNotExist) {
			s.poisoned = true
			return unavailable()
		}
		return nil
	}
	if !marked || err != nil || digest(raw) != s.checksDigest {
		s.poisoned = true
		return refuse(err)
	}
	return nil
}
func (s *Store) CheckStatus(ctx context.Context, id string) (check.Entry, bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return check.Entry{}, false, err
	}
	entry, ok := s.checks.Find(id)
	return entry, ok, nil
}
func (s *Store) CheckPending(ctx context.Context) (bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return false, err
	}
	return s.checks.Pending(), nil
}

// writeConnectionCheck writes only the full history, recording the predecessor
// journal it has absorbed. The predecessor journal itself is never written.
func (s *Store) writeConnectionCheck(next check.Journal, first bool) error {
	raw, err := encodeConnectionCheckHistory(s.binding, next, s.checksLegacy)
	if err != nil {
		return err
	}
	if first {
		if err = s.disk.markConnectionCheckWitness(historyCheckFile); err == nil {
			err = s.disk.beginConnectionChecks(historyCheckFile, raw)
		}
	} else {
		err = s.disk.updateConnectionChecks(historyCheckFile, raw, s.checksDigest)
	}
	if err != nil {
		s.poisoned = true
		return err
	}
	s.checks, s.checksDigest, s.checksPresent = next, digest(raw), true
	return nil
}
func (s *Store) ClaimConnectionCheck(ctx context.Context, r check.Request) (check.Entry, bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return check.Entry{}, false, err
	}
	if r.ProfileID != s.binding.ProfileID || r.OwnerID != s.binding.OwnerID ||
		r.ComputerID != s.binding.ComputerID || !check.ValidRequest(r) {
		return check.Entry{}, false, check.ErrRefused
	}
	if old, ok := s.checks.Find(r.OperationID); ok {
		if old.Request != r {
			return check.Entry{}, false, check.ErrRefused
		}
		return old, false, nil
	}
	next, first, err := s.checks.Begin(r)
	if err != nil || !first {
		return check.Entry{}, false, err
	}
	if err = s.writeConnectionCheck(next, !s.checksPresent); err != nil {
		return check.Entry{}, false, err
	}
	if ctx.Err() != nil {
		s.poisoned = true
		return check.Entry{}, false, check.ErrUnknown
	}
	// Only first=true in the same Store lifetime may prepare/dispatch.
	s.activeCheckID = r.OperationID
	entry, _ := next.Find(r.OperationID)
	return entry, true, nil
}
func checkUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	const hx = "0123456789abcdef"
	out := make([]byte, 36)
	pos := 0
	for i, value := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out[pos] = '-'
			pos++
		}
		out[pos] = hx[value>>4]
		out[pos+1] = hx[value&15]
		pos += 2
	}
	return string(out), nil
}
func (s *Store) PrepareConnectionCheck(ctx context.Context, id string, scope check.Scope) (check.Entry, string, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return check.Entry{}, "", err
	}
	old, ok := s.checks.Find(id)
	if !ok || s.activeCheckID != id || old.Phase != check.Claimed {
		return check.Entry{}, "", check.ErrRefused
	}
	if scope.Mode == check.Status {
		if scope.CheckID != "" || scope.Challenge != "" {
			return check.Entry{}, "", check.ErrRefused
		}
		id, err := checkUUID()
		if err != nil {
			return check.Entry{}, "", check.ErrRefused
		}
		scope.CheckID = id
	} else if scope.CheckID != "" {
		return check.Entry{}, "", check.ErrRefused
	}
	scope.PromptDigest = "" // ALWAYS derived by Go, never accepted from a caller
	prompt := check.Prompt(scope)
	if prompt == "" {
		return check.Entry{}, "", check.ErrRefused
	}
	sum := sha256.Sum256([]byte(prompt))
	scope.PromptDigest = hex.EncodeToString(sum[:])
	if !check.ValidScope(scope) || scope.DocumentDigest == "" {
		return check.Entry{}, "", check.ErrRefused
	}
	next := old
	next.Phase = check.Prepared
	next.Scope = &scope
	updated, err := s.checks.Advance(id, next)
	if err != nil {
		return check.Entry{}, "", err
	}
	if err = s.writeConnectionCheck(updated, false); err != nil {
		return check.Entry{}, "", err
	}
	if ctx.Err() != nil {
		s.activeCheckID = ""
		s.poisoned = true
		return check.Entry{}, "", check.ErrUnknown
	}
	return next, prompt, nil
}
func (s *Store) AdvanceConnectionCheck(ctx context.Context, id string, phase check.Phase, receipt *check.Receipt) (check.Entry, bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if err := s.checkStorage(ctx); err != nil {
		return check.Entry{}, false, err
	}
	old, ok := s.checks.Find(id)
	if !ok || s.activeCheckID != id {
		return check.Entry{}, false, check.ErrRefused
	}
	next := old
	next.Phase = phase
	if receipt != nil {
		r := *receipt
		next.Receipt = &r
	}
	updated, err := s.checks.Advance(id, next)
	if err != nil {
		return check.Entry{}, false, err
	}
	if phase == check.DispatchIntent {
		if old.Scope == nil || old.Scope.DocumentDigest == "" {
			return check.Entry{}, false, check.ErrRefused
		}
		// The exclusive legacy-compatible challenge fuse precedes dispatch WAL.
		// A partial fuse or lost acknowledgement cannot be replayed or erased.
		if old.Scope.Mode == check.Bootstrap {
			if err = s.disk.publishConnectionCheckFuse(old); err != nil {
				s.activeCheckID = ""
				s.poisoned = true
				return check.Entry{}, false, check.ErrUnknown
			}
		}
	}
	if err = s.writeConnectionCheck(updated, false); err != nil {
		s.activeCheckID = ""
		return check.Entry{}, false, err
	}
	if ctx.Err() != nil {
		s.activeCheckID = ""
		s.poisoned = true
		return check.Entry{}, false, check.ErrUnknown
	}
	if phase.Terminal() || phase == check.OutcomeUnknown {
		s.activeCheckID = ""
	}
	return next, phase == check.DispatchIntent, nil
}
