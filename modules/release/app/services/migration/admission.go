// Package migration owns the admission lifetime for one accepted migration.
package migration

import (
	"context"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	BindingInvalid    Code = "MIGRATION_BINDING_INVALID"
	AdmissionUnproven Code = "MIGRATION_ADMISSION_UNPROVEN"
	ClaimConsumed     Code = "MIGRATION_CLAIM_CONSUMED"
	AdmissionClosed   Code = "MIGRATION_ADMISSION_CLOSED"
	CallerCancelled   Code = "MIGRATION_CALLER_CANCELLED"
)

// Service is the sole Release admission owner for one accepted operation.
// Boot constructs it once under the already-held exclusion domain and injects
// this same borrowed port into every filesystem consumer. It must never be
// constructed per Acquire, per handle, or to recover a lost acknowledgment.
type Service struct {
	mu       port.StateGate
	binding  port.MigrationBinding
	guard    port.MigrationGuard
	claimed  bool
	unproven bool
	closed   bool
}

var _ port.MigrationAdmission = (*Service)(nil)

func New(binding port.MigrationBinding, guard port.MigrationGuard, gate port.StateGate) (*Service, error) {
	if guard == nil || gate == nil || !valid(binding) {
		return nil, BindingInvalid
	}
	return &Service{mu: gate, binding: binding, guard: guard}, nil
}
func valid(b port.MigrationBinding) bool {
	text := func(s string) bool {
		if len(s) == 0 || len(s) > 128 || !utf8.ValidString(s) {
			return false
		}
		for _, c := range s {
			if c < 0x20 || c == 0x7f {
				return false
			}
		}
		return true
	}
	number := func(s string) bool {
		if len(s) == 0 || len(s) > 30 {
			return false
		}
		for _, c := range s {
			if c < '0' || c > '9' {
				return false
			}
		}
		return true
	}
	// Identity spelling is not provenance. The injected guard separately
	// verifies accepted bytes/profile and the complete stopped-writer set.
	return text(b.Operation) && text(b.AlphaBuild) && number(b.Source.Device) && number(b.Source.File)
}

// ReverifyMigration serializes checks against the retained guard. A failed
// invoked verification fences this owner; subsequent calls return locally and
// do not repeat that uncertain/refused observation through another consumer.
func (s *Service) ReverifyMigration(ctx context.Context, binding port.MigrationBinding, roots port.MigrationRoots) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if binding != s.binding {
		return BindingInvalid
	}
	if s.unproven {
		return AdmissionUnproven
	}
	if ctx.Err() != nil {
		return CallerCancelled
	}
	if err := s.guard.ReverifyMigration(ctx, binding, roots); err != nil {
		s.unproven = true
		return AdmissionUnproven
	}
	return nil
}

// ClaimMigration consumes this operation once across all consumers. It neither
// writes Dispatched nor authorizes a move: the consumer must still require that
// durable record and freshly reverify the held guard and exact physical pair.
func (s *Service) ClaimMigration(ctx context.Context, binding port.MigrationBinding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if binding != s.binding {
		return BindingInvalid
	}
	if s.claimed {
		return ClaimConsumed
	}
	if s.unproven {
		return AdmissionUnproven
	}
	if s.closed {
		return AdmissionClosed
	}
	if ctx.Err() != nil {
		return CallerCancelled
	}
	s.claimed = true
	return nil
}

// Close prevents new claims only. It does not close/release the injected guard,
// clear the consumed claim, settle a record, or permit profile startup. Already
// issued work may still reverify under that retained guard while draining.
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
}
