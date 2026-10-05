package boot

import (
	"context"
	"errors"
	"sync"

	"github.com/legrch/farol/modules/chat/app/port"
)

// The inherited Desktop pipe has one trusted selected profile owner. This
// adapter authorizes only that owner's retained local Chat content in this
// exact live backend. It is not a Computer/workspace lease, provider account
// approval, disclosure grant, or permission to resume a conversation. No wire
// body can select a different owner/profile or reactivate a closed lifetime.
type historyReadAuthority struct {
	mu       sync.Mutex
	lifetime context.Context
	scope    port.HistoryReadScope
	qualify  func() error
	closed   bool
}
type historyReadLease struct{ owner *historyReadAuthority }

func newHistoryReadAuthority(lifetime context.Context, scope port.HistoryReadScope, qualify func() error) (*historyReadAuthority, error) {
	if lifetime == nil || lifetime.Err() != nil || !validIngressID(scope.ProfileID) || !validIngressID(scope.BackendGeneration) || !validIngressID(scope.OwnerID) || qualify == nil {
		return nil, errors.New("chat_history_authority_invalid")
	}
	if err := qualify(); err != nil {
		return nil, err
	}
	return &historyReadAuthority{lifetime: lifetime, scope: scope, qualify: qualify}, nil
}

func (a *historyReadAuthority) current(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil || a.closed || a.lifetime.Err() != nil {
		return errors.New("chat_history_authority_unavailable")
	}
	// Physical qualification is an adapter operation, outside the app's pure
	// inspection callback. The qualified profile owns its own descriptor lock.
	if err := a.qualify(); err != nil {
		return err
	}
	if ctx.Err() != nil || a.lifetime.Err() != nil {
		return errors.New("chat_history_authority_unavailable")
	}
	return nil
}
func (a *historyReadAuthority) AdmitHistoryRead(ctx context.Context) (port.HistoryReadLease, error) {
	if a == nil {
		return nil, errors.New("chat_history_authority_unavailable")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.current(ctx); err != nil {
		return nil, err
	}
	return &historyReadLease{owner: a}, nil
}
func (l *historyReadLease) WithCurrent(ctx context.Context, inspect func(port.HistoryReadScope) error) error {
	if l == nil || l.owner == nil || inspect == nil {
		return errors.New("chat_history_authority_invalid")
	}
	a := l.owner
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.current(ctx); err != nil {
		return err
	}
	if err := inspect(a.scope); err != nil {
		return err
	}
	return a.current(ctx)
}
func (a *historyReadAuthority) close() {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.closed = true
	a.mu.Unlock()
}

var _ port.HistoryReadAuthority = (*historyReadAuthority)(nil)
var _ port.HistoryReadLease = (*historyReadLease)(nil)
