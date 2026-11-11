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
func (s *Store) restoreConnectionChecks() error {
	marked, err := s.disk.connectionCheckWitness()
	if err != nil {
		return err
	}
	raw, err := s.disk.readConnectionChecks()
	if !marked && errors.Is(err, os.ErrNotExist) {
		s.checks = check.Journal{Entries: []check.Entry{}}
		return nil
	}
	if !marked || err != nil {
		return unavailable()
	}
	parsed, err := decodeConnectionChecks(s.binding, raw)
	if err != nil {
		return err
	}
	if err = s.disk.qualifyConnectionChecks(raw); err != nil {
		return err
	}
	s.checks, s.checksPresent, s.checksDigest = parsed, true, digest(raw)
	return nil
}
func (s *Store) checkConnectionStorage() error {
	marked, err := s.disk.connectionCheckWitness()
	if err != nil {
		s.poisoned = true
		return err
	}
	raw, err := s.disk.readConnectionChecks()
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
func (s *Store) writeConnectionCheck(next check.Journal, first bool) error {
	raw, err := encodeConnectionChecks(s.binding, next)
	if err != nil {
		return err
	}
	if first {
		if err = s.disk.markConnectionCheckWitness(); err == nil {
			err = s.disk.beginConnectionChecks(raw)
		}
	} else {
		err = s.disk.updateConnectionChecks(raw, s.checksDigest)
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
