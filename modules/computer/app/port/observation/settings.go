package observation

import "github.com/legrch/farol/modules/computer/domain/authority"

// CurrentSettings is the protected readback of one workspace and the owner
// consent projection from the same Settings revision. The reciprocal adapter
// validates the persisted evidence envelope before mapping its native fields.
type CurrentSettings struct {
	ProfileID, OwnerID, ComputerID, WorkspaceID, Root string
	Revision, Generation                              uint64
	Unsettled                                         bool
	RootIdentity                                      authority.RootIdentity
	Evidence                                          []byte
	ConsentProjection                                 string
}
