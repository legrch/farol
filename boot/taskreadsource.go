package boot

import (
	"context"
	"errors"
	"time"

	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

// PublishedCodexReadSource is trusted Root wiring to an existing publication.
// The publication is a prerequisite, not native qualification. Native startup
// must separately qualify this source and the profile before exposing reads.
type PublishedCodexReadSource struct {
	Current             *ComputerIngress
	HostID, ScratchRoot string
	Verifier            codexclient.SelectionVerifier
	Now                 func() time.Time
}

// One slot seals the source and exact reference for the profile lifetime. The
// client belongs only to TaskProfile.clients/Close, including failed selection.
type taskReadSlot struct {
	current  *ComputerIngress
	snapshot codexclient.AuthoritySnapshot
	selected selectedthread.Selection
	reader   *codexclient.SelectedThreadReader
	err      error
}

// SelectPublishedCodexRead retains one lazy original client, with no Task owner,
// journal admission or Chat parent selection. Exact duplicates share the reader;
// failure, changed selection and unknown transport never replace the lifetime.
func (p *TaskProfile) SelectPublishedCodexRead(ctx context.Context, input PublishedCodexReadSource) (selectedthread.Reader, error) {
	if err := p.available(ctx); err != nil {
		return nil, err
	}
	if input.Current == nil || input.Current.peer != p.peer || input.Current.ownerID != p.owner {
		return nil, task.ErrIdentity
	}
	snapshot, ref, err := input.Current.currentCodexReadAuthority(ctx, input.HostID, input.ScratchRoot)
	if err != nil {
		return nil, err
	}
	if snapshot.Selection.Binding.ProfileID != p.peer.ProfileId {
		return nil, task.ErrIdentity
	}
	selected := taskReadSelection(snapshot.Selection.Binding, ref)
	read := func(ctx context.Context) (codexclient.AuthoritySnapshot, error) {
		if err := p.available(ctx); err != nil {
			return codexclient.AuthoritySnapshot{}, err
		}
		current, exact, err := input.Current.currentCodexReadAuthority(ctx, input.HostID, input.ScratchRoot)
		if denied := p.available(ctx); denied != nil {
			return codexclient.AuthoritySnapshot{}, denied
		}
		if err != nil {
			return codexclient.AuthoritySnapshot{}, err
		}
		if exact != ref {
			return codexclient.AuthoritySnapshot{}, task.ErrIdentity
		}
		return current, nil
	}
	authority, err := codexclient.NewSelectionAuthority(codexclient.SelectionAuthorityOptions{
		Selected: snapshot, ReadCurrent: read, Verifier: input.Verifier, Now: input.Now,
	})
	if err != nil {
		return nil, err
	}
	grant := func(ctx context.Context, binding task.Binding) error {
		if err := p.available(ctx); err != nil {
			return err
		}
		if err := authority.Recheck(ctx, binding); err != nil {
			return err
		}
		return p.available(ctx)
	}

	// Only inert construction and registration run under this mutex: no clock,
	// Verifier, authority callback or provider work. Close cannot snapshot clients
	// between the claim and registration. A claimed failure remains terminal.
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.available(ctx); err != nil {
		return nil, err
	}
	if p.clients == nil || p.closeDone == nil || p.newClient == nil {
		return nil, task.ErrUnavailable
	}
	if slot := p.read; slot != nil {
		if slot.current != input.Current || slot.snapshot != snapshot || slot.selected != selected {
			return nil, task.ErrIdentity
		}
		if slot.err != nil {
			return nil, slot.err
		}
		return slot.reader, nil
	}
	slot := &taskReadSlot{current: input.Current, snapshot: snapshot, selected: selected, err: task.ErrUnavailable}
	p.read = slot
	client, err := p.newClient(snapshot.Selection, snapshot.Followup, grant, func(context.Context, task.Intent) error {
		return task.ErrUnsupported // Permanently read-only; no Task dispatch authority.
	})
	if client != nil {
		if _, owned := p.clients[client]; owned {
			return nil, slot.err
		}
		// Register even a client returned alongside an error before any fallible
		// reader composition. The original Close path owns all such clients.
		p.clients[client] = "selected-read"
	}
	if err != nil || client == nil {
		if errors.Is(err, task.ErrUnknown) {
			slot.err = task.ErrUnknown
		}
		return nil, slot.err
	}
	slot.reader, err = codexclient.NewSelectedThreadReader(client, selected, func(ctx context.Context, got selectedthread.Selection) error {
		if got != selected {
			return task.ErrIdentity
		}
		return grant(ctx, snapshot.Selection.Binding)
	})
	if err != nil {
		return nil, slot.err
	}
	slot.err = nil
	return slot.reader, nil
}

func taskReadSelection(b task.Binding, ref controlct.Reference) selectedthread.Selection {
	root := func(r task.Root) controlct.Root {
		return controlct.Root{Path: r.Path, Device: r.Device, Inode: r.Inode, GitCommonDirectory: r.GitCommonDirectory}
	}
	return selectedthread.Selection{Binding: controlct.Binding{
		Provider: controlct.Provider(b.Provider), ProfileID: b.ProfileID, HostID: b.HostID,
		ProjectID: b.ProjectID, WorkspaceID: b.WorkspaceID, Project: root(b.Project), Writer: root(b.Writer),
		ModelAlias: b.ModelAlias, Model: b.Model, Effort: b.Effort, ConfigDigest: b.ConfigDigest,
	}, Reference: ref}
}
