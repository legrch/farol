// Package access supplies coherent Computer authority views. New is the
// disposable K1 in-memory fixture; Create/Open provide the native state owner.
package access

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Repository struct {
	mutex        sync.RWMutex
	participants map[string]authority.Participant
	approvals    map[string]authority.Approval
}

func New() *Repository {
	return &Repository{participants: map[string]authority.Participant{}, approvals: map[string]authority.Approval{}}
}
func participant(value authority.Participant) authority.Participant {
	value.Grant = value.Grant.Clone()
	return value
}
func approval(value authority.Approval) authority.Approval {
	value.Workspaces = append([]authority.ApprovedWorkspace(nil), value.Workspaces...)
	for i, workspace := range value.Workspaces {
		if workspace.GitMetadata != nil {
			metadata := *workspace.GitMetadata
			value.Workspaces[i].GitMetadata = &metadata
		}
	}
	value.ExcludedPaths = append([]authority.Exclusion(nil), value.ExcludedPaths...)
	value.Capabilities = append([]authority.Capability(nil), value.Capabilities...)
	return value
}

// Put methods are privileged composition/storage operations, never wire commands.
func (r *Repository) PutParticipant(value authority.Participant) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.participants[value.ParticipantID] = participant(value)
}
func (r *Repository) PutApproval(value authority.Approval) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.approvals[value.ComputerID] = approval(value)
}
func (r *Repository) RevokeParticipant(id string) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	delete(r.participants, id)
}
func (r *Repository) RevokeApproval(id string) {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	delete(r.approvals, id)
}

func (r *Repository) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	snapshot := port.AccessSnapshot{}
	if value, ok := r.participants[id]; ok {
		copy := participant(value)
		snapshot.Participant = &copy
		if current, ok := r.approvals[value.Grant.ComputerID]; ok {
			copy := approval(current)
			snapshot.Approval = &copy
		}
	}
	return inspect(snapshot)
}
