// Package archive exposes stored replies for explicit recovery inspection. It
// never grants a normal HistoryOrigin or interprets recorded outcome as success.
package archive

import (
	"context"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	Invalid     Code = "CHAT_ARCHIVE_INVALID"
	Refused     Code = "CHAT_ARCHIVE_REFUSED"
	Unavailable Code = "CHAT_ARCHIVE_UNAVAILABLE"
)

const Observation = "stored_unconfirmed"

type Dependencies struct {
	Authority port.HistoryReadAuthority
	Store     port.StoredReplyArchive
}

type Service struct {
	scope port.JournalScope
	deps  Dependencies
}

// New performs no archive IO. A busy/corrupt/large old result namespace cannot
// prevent the independent Settings/read composition from starting.
func New(scope port.JournalScope, deps Dependencies) (*Service, error) {
	if !id(scope.ProfileID) || !id(scope.BackendGeneration) || deps.Authority == nil || deps.Store == nil {
		return nil, Invalid
	}
	return &Service{scope: scope, deps: deps}, nil
}

func id(s string) bool {
	if len(s) == 0 || len(s) > 120 || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r <= 32 || r == 127 {
			return false
		}
	}
	return true
}

func key(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}

func current(ctx context.Context, lease port.HistoryReadLease) (port.HistoryReadScope, error) {
	var scope port.HistoryReadScope
	if ctx == nil || ctx.Err() != nil || lease == nil {
		return scope, Refused
	}
	calls := 0
	err := lease.WithCurrent(ctx, func(value port.HistoryReadScope) error {
		calls++
		if calls != 1 || !id(value.ProfileID) || !id(value.BackendGeneration) || !id(value.OwnerID) {
			return Refused
		}
		scope = value
		return nil
	})
	if err != nil || calls != 1 || ctx.Err() != nil {
		return port.HistoryReadScope{}, Refused
	}
	return scope, nil
}

func (s *Service) admit(ctx context.Context) (port.HistoryReadLease, port.HistoryReadScope, error) {
	if s == nil || ctx == nil || ctx.Err() != nil {
		return nil, port.HistoryReadScope{}, Unavailable
	}
	lease, err := s.deps.Authority.AdmitHistoryRead(ctx)
	if err != nil {
		return nil, port.HistoryReadScope{}, Refused
	}
	scope, err := current(ctx, lease)
	if err != nil || scope.ProfileID != s.scope.ProfileID || scope.BackendGeneration != s.scope.BackendGeneration {
		return nil, port.HistoryReadScope{}, Refused
	}
	return lease, scope, nil
}

func recheck(ctx context.Context, lease port.HistoryReadLease, scope port.HistoryReadScope) error {
	actual, err := current(ctx, lease)
	if err != nil || actual != scope {
		return Refused
	}
	return nil
}

func validSummary(v port.ArchiveSummary) bool {
	if !key(v.Key) || v.Digest == ([32]byte{}) || !id(v.ProfileID) || !id(v.OwnerID) || !id(v.BackendGeneration) || !id(v.OperationID) || !id(v.ResultID) || v.Bytes < 0 || v.Bytes > port.ArchiveTextBytes || len(v.ConversationID) > 256 || !utf8.ValidString(v.ConversationID) {
		return false
	}
	for _, r := range v.ConversationID {
		if r <= 32 || r == 127 {
			return false
		}
	}
	switch v.RecordedOutcome {
	case "completed", "refused", "failed", "cancelled", "unknown":
		return true
	default:
		return false
	}
}
