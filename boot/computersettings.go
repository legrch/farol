package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	settingssvc "github.com/legrch/farol/modules/computer/app/services/settingsworkspace"
	settingsct "github.com/legrch/farol/modules/computer/contracts/settingsworkspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type ownerApprovalStore interface {
	WithOwnerApproval(context.Context, func(accessrepo.Status, *authority.Approval) error) error
}

// One Settings call captures the publication and the store revision at its first
// authority check. Chat participant admission can precede this call, but cannot
// change that revision while the native result is being prepared. No Task/Turn
// is created for a Settings action, and no request path becomes an approval.
type settingsApproval struct {
	root        *ComputerIngress
	store       ownerApprovalStore
	publication knownComputerPublication
	revision    uint64
	observed    bool
}

func (a *settingsApproval) WithCurrent(ctx context.Context, inspect func(*authority.Approval) error) error {
	if ctx == nil || ctx.Err() != nil || inspect == nil {
		return computerUnavailable()
	}
	fence, err := strconv.ParseUint(a.publication.receipt.Fence, 10, 64)
	if err != nil || fence == 0 {
		return computerUnavailable()
	}
	published, err := strconv.ParseUint(a.publication.receipt.StoreRevision, 10, 64)
	if err != nil || published == 0 {
		return computerUnavailable()
	}
	return a.store.WithOwnerApproval(ctx, func(status accessrepo.Status, current *authority.Approval) error {
		// Access owner -> activation -> root state, matching the existing join.
		a.root.guard.mu.Lock()
		defer a.root.guard.mu.Unlock()
		a.root.mu.Lock()
		defer a.root.mu.Unlock()
		if a.root.unknown || a.root.guard.exhausted || a.root.guard.revision != fence ||
			a.root.publication == nil || a.root.publication.receipt != a.publication.receipt ||
			!status.ApprovalPresent || status.Revision < published || current == nil ||
			current.OwnerID != a.root.ownerID || current.ComputerID != a.root.computerID ||
			status.Generation != a.publication.approval.Generation ||
			!authority.SameApprovalPolicy(*current, a.publication.approval) ||
			!current.ExpiresAt.Equal(a.publication.approval.ExpiresAt) || ctx.Err() != nil {
			return computerUnavailable()
		}
		if a.observed && a.revision != status.Revision {
			return computerUnavailable()
		}
		a.revision, a.observed = status.Revision, true
		copy := current.Clone()
		return inspect(&copy)
	})
}

func (s *ComputerIngress) settingsList(ctx context.Context, in wire.ComputerSettingsListRequest) (*wire.ComputerSettingsListResponse, error) {
	if ctx == nil || ctx.Err() != nil || validateIngress("ComputerSettingsListRequest", in) != nil || s.native == nil {
		return nil, computerUnavailable()
	}
	store, ok := s.store.(ownerApprovalStore)
	if !ok {
		return nil, computerUnavailable()
	}
	s.mu.Lock()
	p := s.publication
	valid := !s.unknown && p != nil && p.receipt == in.Publication
	var publication knownComputerPublication
	if valid {
		publication = knownComputerPublication{receipt: p.receipt, approval: p.approval.Clone()}
	}
	s.mu.Unlock()
	if !valid {
		return nil, computerUnavailable()
	}
	current := &settingsApproval{root: s, store: store, publication: publication}
	var clock computerport.Clock = s.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	contract := settingsct.New(settingssvc.New(current, s.native, clock))
	result, err := contract.List(ctx, settingsct.Request{WorkspaceID: in.WorkspaceId, RelativePath: in.RelativePath})
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, computerUnavailable()
	}
	entries := result.Entries
	if entries == nil {
		entries = []string{}
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		return nil, err
	}
	return &wire.ComputerSettingsListResponse{
		Publication: publication.receipt, WorkspaceId: result.WorkspaceID, RelativePath: result.RelativePath,
		Root:    wire.ComputerSettingsRoot{Path: result.Root.Path, Device: result.Root.Device, Inode: result.Root.Inode},
		Entries: encoded, Truncated: result.Truncated,
	}, nil
}

func (s *ComputerIngress) settingsListMethod() desktop.Method {
	return desktop.Method{Concurrent: true, Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
		if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerSettingsListRequest", r.Body) != nil {
			return invalidIngress()
		}
		var body wire.ComputerSettingsListRequest
		if json.Unmarshal(r.Body, &body) != nil {
			return invalidIngress()
		}
		value, err := s.settingsList(ctx, body)
		var failure *settingsct.Failure
		if errors.As(err, &failure) {
			return &desktop.Outcome{Status: "refused", Code: failure.Code}, nil
		}
		return ingressOutcome(value, err)
	}}
}
