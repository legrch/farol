package access

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	observationport "github.com/legrch/farol/modules/computer/app/port/observation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/modules/computer/domain/observation"
)

type SettingsCurrentReader func(context.Context, string) (observationport.CurrentSettings, error)

func (load SettingsCurrentReader) ReadQualified(ctx context.Context, entry journal.Entry, proposed authority.Approval) (CurrentReaderProof, error) {
	request := entry.Request
	if load == nil || ctx == nil || ctx.Err() != nil || entry.Phase != journal.Committed ||
		entry.Certificate == nil || entry.Certificate.Kind != journal.Committed || entry.DischargedBy != "" ||
		request.ProfileID == "" || request.WorkspaceID == "" || !observation.CanonicalPath(request.Root) ||
		request.OwnerID == "" || request.OwnerID != proposed.OwnerID ||
		request.ComputerID == "" || request.ComputerID != proposed.ComputerID {
		return CurrentReaderProof{}, journal.ErrRefused
	}
	snapshot, err := load(ctx, request.WorkspaceID)
	if err != nil {
		return CurrentReaderProof{}, err
	}
	if ctx.Err() != nil || snapshot.Unsettled || snapshot.Revision == 0 ||
		snapshot.Generation == 0 || snapshot.Generation != proposed.Generation ||
		snapshot.ProfileID != request.ProfileID || snapshot.OwnerID != request.OwnerID ||
		snapshot.ComputerID != request.ComputerID || snapshot.WorkspaceID != request.WorkspaceID ||
		snapshot.Root != request.Root || snapshot.ConsentProjection == "" {
		return CurrentReaderProof{}, journal.ErrRefused
	}
	digest := currentConsentDigest(snapshot.ConsentProjection)
	if digest != request.ConsentDigest {
		return CurrentReaderProof{}, journal.ErrRefused
	}
	evidence, err := observation.ParseEvidence(snapshot.Evidence)
	saved := observation.Saved{
		Binding:  observation.Binding{Path: snapshot.Root, Device: snapshot.RootIdentity.Device, Inode: snapshot.RootIdentity.Inode},
		Evidence: &evidence,
	}
	if err != nil || observation.Preflight(saved, observation.Settled) != "" {
		return CurrentReaderProof{}, journal.ErrRefused
	}
	matches := 0
	for _, workspace := range proposed.Workspaces {
		if workspace.WorkspaceID == request.WorkspaceID {
			if workspace.Root != snapshot.Root || workspace.RootIdentity != snapshot.RootIdentity || workspace.ShellVerified {
				return CurrentReaderProof{}, journal.ErrRefused
			}
			matches++
		}
	}
	if matches != 1 {
		return CurrentReaderProof{}, journal.ErrRefused
	}
	return CurrentReaderProof{Saved: saved, ConsentDigest: digest, SettingsRevision: snapshot.Revision, ComputerGeneration: snapshot.Generation}, nil
}

// The Stop journal binds ownerComputerConsentDigest. Hash the exact UTF-8
// serialization produced by that same owner projection, including JS escaping.
func currentConsentDigest(projection string) string {
	sum := sha256.Sum256([]byte(projection))
	return hex.EncodeToString(sum[:])
}
