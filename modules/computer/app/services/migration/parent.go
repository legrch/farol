package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/modules/computer/domain/observation"
)

// Parent reads the separately owned Stop ledger. The Access Store rechecks
// the selected certificate and atomically consumes it when admitting the child.
type Parent struct {
	read                            func(context.Context) (journal.StopLedger, error)
	hostLifetime, backendGeneration string
}

func NewParent(read func(context.Context) (journal.StopLedger, error), hostLifetime, backendGeneration string) *Parent {
	return &Parent{read: read, hostLifetime: hostLifetime, backendGeneration: backendGeneration}
}

func (p *Parent) resolve(ctx context.Context, id string, mode Mode) (journal.StopEntry, error) {
	ledger, err := p.read(ctx)
	if err != nil {
		return journal.StopEntry{}, err
	}
	var match journal.StopEntry
	for _, entry := range ledger.Entries {
		if entry.Phase != journal.StopComplete || entry.Request.ChildOperationID != id || entry.Request.ChildMode != string(mode) {
			continue
		}
		if match.Request.OperationID != "" {
			return journal.StopEntry{}, journal.ErrRefused
		}
		match = entry
	}
	if match.Request.OperationID == "" || match.SettingsAck == nil || p.hostLifetime == "" ||
		match.Request.HostLifetimeID != p.hostLifetime || match.Request.BackendGeneration != p.backendGeneration {
		return journal.StopEntry{}, journal.ErrRefused
	}
	return match, nil
}

func (p *Parent) OriginalParent(ctx context.Context, selection Selection) (string, error) {
	entry, err := p.resolve(ctx, selection.Request.OperationID, selection.Mode)
	return entry.Request.OperationID, err
}

// Select freezes only the child's saved observation from the trusted host.
// Every scope field is taken from the completed prerequisite.
func (p *Parent) Select(ctx context.Context, id string, mode Mode, saved observation.Saved) (Selection, error) {
	entry, err := p.resolve(ctx, id, mode)
	if err != nil {
		return Selection{}, err
	}
	// The Settings writer advances both counters as safe JavaScript integers.
	const maxSafeInteger = (1 << 53) - 1
	for _, counter := range []string{entry.SettingsAck.Revision, entry.SettingsAck.ComputerGeneration} {
		value, err := strconv.ParseUint(counter, 10, 64)
		if err != nil || value >= maxSafeInteger {
			return Selection{}, journal.ErrRefused
		}
	}
	stop := entry.Request
	saved.Binding.Path = stop.Root
	if !saved.Binding.Valid() ||
		(mode == Legacy && saved.Evidence != nil) ||
		(mode == Rebind && observation.Preflight(saved, observation.Settled) != "") {
		return Selection{}, journal.ErrRefused
	}
	selection := Selection{Mode: mode, Saved: saved, Request: journal.Request{
		OperationID: id, ProfileID: stop.ProfileID, OwnerID: stop.OwnerID,
		ComputerID: stop.ComputerID, WorkspaceID: stop.WorkspaceID, Root: stop.Root,
		ConsentDigest: entry.SettingsAck.ConsentDigest, ExpectedRevision: entry.SettingsAck.Revision,
		ExpectedGeneration: entry.SettingsAck.ComputerGeneration,
		BootUUID:           stop.BootUUID, HostLifetimeID: stop.HostLifetimeID,
	}}
	raw, err := json.Marshal(selection)
	if err != nil {
		return Selection{}, err
	}
	digest := sha256.Sum256(raw)
	selection.Request.RequestDigest = hex.EncodeToString(digest[:])
	return selection, nil
}
