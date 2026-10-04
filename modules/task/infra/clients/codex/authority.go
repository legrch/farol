package codex

import (
	"context"
	"errors"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type AuthorityState string

const (
	AuthorityReady       AuthorityState = "ready"
	AuthorityUnavailable AuthorityState = "unavailable"
	AuthorityUnknown     AuthorityState = "unknown"
	AuthorityRefused     AuthorityState = "refused"
)

type WorkspaceAccess string

const (
	WorkspaceRead  WorkspaceAccess = "read"
	WorkspaceWrite WorkspaceAccess = "write"
)

// HandoffQualification projects a real inspectCodexHandoffHostContract result.
// Trusted composition binds its selected executable/generation provenance. The
// ordinary base host digest is not this witness; none of these fields prove an
// account, serving permission or follow-up capability.
type HandoffQualification struct {
	ExecutablePath, ExecutableSHA256, Protocol, SchemaSHA256 string
	HostGeneration                                           uint64
	ProjectBoundCreateStatus                                 bool
}

// AuthoritySnapshot is a typed, non-secret current settings projection supplied
// by trusted composition. Selection includes the exact saved grant dates, roots,
// model/effort and unchanged TS semantic policy digest. Grant generations belong
// to the saved route; verified fields belong to current workspace setup. No
// browser/request input can issue approval by constructing this value.
type AuthoritySnapshot struct {
	State                                        AuthorityState
	Selection                                    Selection
	HostGeneration, ComputerGeneration           uint64
	GrantHostGeneration, GrantComputerGeneration uint64
	Approved                                     bool
	Access                                       WorkspaceAccess
	VerifiedWorkspaceID                          string
	VerifiedComputerGeneration                   uint64
	Handoff                                      HandoffQualification
	Followup                                     FollowupQualification
}

// SelectionVerifier is only the Verify portion of the existing Boundary. The
// authority cannot launch a proxy, discover an executor or inspect an account.
type SelectionVerifier interface {
	Verify(context.Context, Selection) error
}

type SelectionAuthorityOptions struct {
	Selected AuthoritySnapshot
	// ReadCurrent must freshly read the owning current settings/approval, not
	// return a cached startup grant. Unknown or refused reads must return errors
	// or non-ready states. Root owns parsing and current-reader invalidation.
	ReadCurrent func(context.Context) (AuthoritySnapshot, error)
	Verifier    SelectionVerifier
	Now         func() time.Time
}

// SelectionAuthority supplies only Resolve/Recheck. It deliberately does not
// implement port.Authority: Root must compose the actual existing Parent peer.
// It owns no admission, provider client, journal, lifecycle or retry policy.
type SelectionAuthority struct {
	selected AuthoritySnapshot
	current  func(context.Context) (AuthoritySnapshot, error)
	verify   SelectionVerifier
	now      func() time.Time
}

// NewSelectionAuthority captures immutable values without reading settings,
// invoking the clock/verifier or acquiring native/provider resources.
func NewSelectionAuthority(o SelectionAuthorityOptions) (*SelectionAuthority, error) {
	if o.ReadCurrent == nil || o.Verifier == nil || o.Now == nil {
		return nil, task.ErrInvalid
	}
	if err := o.Selected.check(); err != nil {
		return nil, err
	}
	return &SelectionAuthority{o.Selected, o.ReadCurrent, o.Verifier, o.Now}, nil
}

func (s AuthoritySnapshot) check() error {
	switch s.State {
	case AuthorityUnknown:
		return task.ErrUnknown
	case AuthorityRefused:
		return task.ErrState
	case AuthorityReady:
	default:
		return task.ErrUnavailable
	}
	x := s.Selection
	h := s.Handoff
	if !x.valid() || !digest(x.Binding.ConfigDigest) || !s.Approved ||
		s.HostGeneration == 0 || s.ComputerGeneration == 0 ||
		s.GrantHostGeneration != s.HostGeneration || s.GrantComputerGeneration != s.ComputerGeneration ||
		s.VerifiedWorkspaceID != x.Binding.WorkspaceID || s.VerifiedComputerGeneration != s.ComputerGeneration ||
		(s.Access != WorkspaceRead && s.Access != WorkspaceWrite) ||
		(x.Sandbox == "workspace-write" && s.Access != WorkspaceWrite) ||
		!h.ProjectBoundCreateStatus || h.HostGeneration != s.HostGeneration ||
		h.ExecutablePath != x.ExecutablePath || h.ExecutableSHA256 != x.ExecutableSHA256 ||
		h.Protocol != x.Protocol || h.SchemaSHA256 != x.SchemaSHA256 ||
		(s.Followup != (FollowupQualification{}) && !s.Followup.valid(x)) {
		return task.ErrUnavailable
	}
	return nil
}

func authorityError(err error) error {
	// Never disclose raw settings/filesystem diagnostics from injected boundaries.
	for _, classified := range []error{task.ErrUnknown, task.ErrIdentity, task.ErrState} {
		if errors.Is(err, classified) {
			return classified
		}
	}
	return task.ErrUnavailable
}

func (a *SelectionAuthority) usable(ctx context.Context) error {
	if ctx == nil {
		return task.ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if a == nil || a.current == nil || a.verify == nil || a.now == nil {
		return task.ErrUnavailable
	}
	x := a.selected.Selection
	now := a.now()
	if now.Before(x.GrantedAt) || !now.Before(x.ExpiresAt) {
		return task.ErrUnavailable
	}
	return ctx.Err()
}

func (a *SelectionAuthority) read(ctx context.Context) error {
	if err := a.usable(ctx); err != nil {
		return err
	}
	current, err := a.current(ctx)
	// The read can await settings IO; neither expiry nor cancellation is waived.
	if denied := a.usable(ctx); denied != nil {
		return denied
	}
	if err != nil {
		return authorityError(err)
	}
	if err := current.check(); err != nil {
		return err
	}
	// Every captured value remains fixed, including approval/access, setup,
	// both generations and optional full-selection follow-up qualification.
	if current != a.selected {
		return task.ErrIdentity
	}
	return nil
}

// Resolve matches the app's existing exact request semantics, including Effort.
// It cannot select another model, invent a default or adopt a newer snapshot.
// Service.Resolve separately performs the retained Client.Supports catalogue
// qualification and subsequent Recheck before publishing any resolved response.
func (a *SelectionAuthority) Resolve(ctx context.Context, req port.Selection) (task.Binding, error) {
	if err := a.usable(ctx); err != nil {
		return task.Binding{}, err
	}
	b := a.selected.Selection.Binding
	if req.Provider != b.Provider || req.ProjectID != b.ProjectID || req.WorkspaceID != b.WorkspaceID ||
		req.ModelAlias != b.ModelAlias || req.Effort != b.Effort {
		return task.Binding{}, task.ErrIdentity
	}
	if err := a.Recheck(ctx, b); err != nil {
		return task.Binding{}, err
	}
	return b, nil
}

// Recheck checks the original snapshot before and after awaited physical Verify.
// Success proves only these current reads; Root/client final dispatch fences
// remain required across subsequent awaits. There is no provider operation here.
func (a *SelectionAuthority) Recheck(ctx context.Context, binding task.Binding) error {
	if err := a.usable(ctx); err != nil {
		return err
	}
	if binding != a.selected.Selection.Binding {
		return task.ErrIdentity
	}
	if err := a.read(ctx); err != nil {
		return err
	}
	err := a.verify.Verify(ctx, a.selected.Selection)
	if denied := a.usable(ctx); denied != nil {
		return denied
	}
	if err != nil {
		return authorityError(err)
	}
	return a.read(ctx)
}
