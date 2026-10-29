package mutation

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Separate envelope leaves all existing mutation and process bytes unchanged.
// Repository admission must still compare the original durable creation under
// its exclusive lock; decoding this record never grants deletion authority.
const scratchCleanupVersion = 8
const scratchCleanupKind = "workspace_owner_selftest_cleanup"

type scratchCleanupRecord struct {
	Identity           ownerIdentity    `json:"creationIdentity"`
	ComputerGeneration uint64           `json:"computerGeneration"`
	WorkspaceID        string           `json:"workspaceId"`
	RelativePath       string           `json:"relativePath"`
	RequestDigest      string           `json:"creationDigest"`
	Scratch            scratchSpec      `json:"scratch"`
	Directory          scratchDirectory `json:"directory"`
	Phase              domain.Phase     `json:"phase"`
	Failure            *scratchOutcome  `json:"failure"`
}
type scratchCleanupEnvelope struct {
	Version uint8                `json:"schemaVersion"`
	Kind    string               `json:"kind"`
	Record  scratchCleanupRecord `json:"record"`
}

func encodeScratchCleanup(state *domain.ScratchCleanupState) ([]byte, error) {
	if state == nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	b := state.Binding()
	if _, err := domain.RestoreScratchCleanup(b, state.Phase(), state.Failure()); err != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	c, i, s := b.Creation, b.Creation.Identity, b.Creation.Scratch
	r := scratchCleanupRecord{Identity: ownerIdentity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, ComputerGeneration: c.ComputerGeneration, WorkspaceID: c.WorkspaceID, RelativePath: c.RelativePath, RequestDigest: c.RequestDigest, Scratch: scratchSpec{RunID: s.RunID, Root: s.Root, RootIdentity: scratchDir(s.RootIdentity), Leaf: s.Leaf, ExpectedInventory: []string{}}, Directory: scratchDir(b.Directory), Phase: state.Phase()}
	if f := state.Failure(); f != nil {
		r.Failure = &scratchOutcome{Code: f.Code, Source: f.Source}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(scratchCleanupEnvelope{Version: scratchCleanupVersion, Kind: scratchCleanupKind, Record: r}) != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	raw, err := jsSeparators(buf.Bytes())
	if err != nil {
		return nil, err
	}
	if len(raw) > maxRecordBytes {
		return nil, failure("WORKSPACE_MUTATION_STATE_OVERSIZED")
	}
	return raw, nil
}

func decodeScratchCleanup(raw []byte) (*domain.ScratchCleanupState, error) {
	corrupt := func() (*domain.ScratchCleanupState, error) { return nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT") }
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) {
		return corrupt()
	}
	var e scratchCleanupEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != scratchCleanupVersion || e.Kind != scratchCleanupKind {
		return corrupt()
	}
	r, i, s := e.Record, e.Record.Identity, e.Record.Scratch
	if s.ExpectedInventory == nil || len(s.ExpectedInventory) != 0 || i.Scope != domain.ScopeOwnerSettings {
		return corrupt()
	}
	creation := domain.Binding{Identity: domain.Identity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, ComputerGeneration: r.ComputerGeneration, WorkspaceID: r.WorkspaceID, RelativePath: r.RelativePath, RequestDigest: r.RequestDigest, Scratch: domain.ScratchBinding{RunID: s.RunID, Root: s.Root, RootIdentity: s.RootIdentity.domain(), Leaf: s.Leaf, ExpectedInventory: domain.EmptyScratchInventory}}
	var f *domain.Failure
	if r.Failure != nil {
		if r.Failure.Receipt != nil || r.Failure.Directory != nil {
			return corrupt()
		}
		f = &domain.Failure{Code: r.Failure.Code, Source: r.Failure.Source}
	}
	state, err := domain.RestoreScratchCleanup(domain.ScratchCleanupBinding{Creation: creation, Directory: r.Directory.domain()}, r.Phase, f)
	if err != nil {
		return corrupt()
	}
	canonical, err := encodeScratchCleanup(state)
	if err != nil || !bytes.Equal(canonical, raw) {
		return corrupt()
	}
	return state, nil
}
