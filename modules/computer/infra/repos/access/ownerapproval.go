package access

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// WithOwnerApproval exposes the same sole owner's protected approval to trusted
// composition for explicit Settings inspection. It creates no participant or
// execution grant. The caller must bind its actual publication and owner before
// passing a narrower current-approval port to the application service.
// The callback is synchronous and must not reenter this store. Only one guarded
// workspace-parent mkdir or final file publication/verification/undo callback
// may perform native IO;
// preparation, staging and operation-journal IO remain outside this owner gate.
func (s *Store) WithOwnerApproval(ctx context.Context, inspect func(Status, *authority.Approval) error) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if inspect == nil {
		return unavailable()
	}
	if err := s.check(ctx); err != nil {
		return err
	}
	var current *authority.Approval
	if s.current.Approval != nil {
		copy := approval(*s.current.Approval)
		current = &copy
	}
	return inspect(Status{s.current.Revision, s.current.Generation, current != nil}, current)
}
