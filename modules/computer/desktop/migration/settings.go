package migration

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	observationport "github.com/legrch/farol/modules/computer/app/port/observation"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/modules/computer/domain/observation"
)

// SettingsReader adapts the exact reciprocal Settings readback. The exchange
// validates the envelope before delivery and retains lost-call custody.
func SettingsReader(load func(context.Context, string) (delivery.Snapshot, *wire.SettingsStoreContinuity, error)) func(context.Context, string) (observationport.CurrentSettings, error) {
	return func(ctx context.Context, workspace string) (observationport.CurrentSettings, error) {
		snapshot, proof, err := load(ctx, workspace)
		if errors.Is(err, journal.ErrUnknown) {
			return observationport.CurrentSettings{}, journal.ErrUnknown
		}
		if err != nil || proof == nil {
			return observationport.CurrentSettings{}, journal.ErrRefused
		}
		evidence := proof.Evidence
		if evidence.ComputerId != snapshot.Current.ComputerID || evidence.WorkspaceId != workspace {
			return observationport.CurrentSettings{}, journal.ErrRefused
		}
		// The closed wire schema has already checked the Settings envelope, including
		// enrollment metadata. The native codec checks the candidate tuple itself.
		raw, err := json.Marshal(observation.Evidence{
			Schema: observation.EvidenceSchema, Filesystem: evidence.Filesystem, VolumeUUID: evidence.VolumeUuid,
			FileID: evidence.FileId, BirthSeconds: evidence.BirthSeconds, BirthNanoseconds: evidence.BirthNanoseconds,
		})
		if err != nil {
			return observationport.CurrentSettings{}, journal.ErrRefused
		}
		return observationport.CurrentSettings{
			ProfileID: snapshot.Current.ProfileID, OwnerID: snapshot.Current.OwnerID, ComputerID: snapshot.Current.ComputerID,
			WorkspaceID: evidence.WorkspaceId, Root: evidence.Root, Revision: snapshot.Revision, Generation: snapshot.Current.Generation,
			Unsettled:    snapshot.Pending != nil || snapshot.VerificationInvalidated,
			RootIdentity: authority.RootIdentity{Device: proof.RootIdentity.Device, Inode: proof.RootIdentity.Inode},
			Evidence:     raw, ConsentProjection: proof.ConsentProjection,
		}, nil
	}
}
