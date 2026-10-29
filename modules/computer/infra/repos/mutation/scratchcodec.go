package mutation

import (
	"bytes"
	"encoding/json"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// A separate canonical envelope leaves V1/V2/V3 byte shapes and enums intact.
// It shares the original owner key: changing format cannot mint another attempt.
const scratchVersion = 7
const scratchKind = "workspace_owner_selftest_scratch"

type scratchDirectory struct {
	Device string `json:"device"`
	Inode  string `json:"inode"`
}
type scratchSpec struct {
	RunID             string           `json:"runId"`
	Root              string           `json:"root"`
	RootIdentity      scratchDirectory `json:"rootIdentity"`
	Leaf              string           `json:"leaf"`
	ExpectedInventory []string         `json:"expectedInventory"`
}
type scratchReceipt struct {
	Kind         string           `json:"kind"`
	Operation    domain.Kind      `json:"operation"`
	RelativePath string           `json:"relativePath"`
	Directory    scratchDirectory `json:"directory"`
}
type scratchOutcome struct {
	Receipt   *scratchReceipt   `json:"receipt,omitempty"`
	Code      string            `json:"code,omitempty"`
	Source    string            `json:"source,omitempty"`
	Directory *scratchDirectory `json:"directory,omitempty"`
}
type scratchRecord struct {
	Identity           ownerIdentity   `json:"identity"`
	ComputerGeneration uint64          `json:"computerGeneration"`
	WorkspaceID        string          `json:"workspaceId"`
	RelativePath       string          `json:"relativePath"`
	RequestDigest      string          `json:"requestDigest"`
	Scratch            scratchSpec     `json:"scratch"`
	Phase              domain.Phase    `json:"phase"`
	Outcome            *scratchOutcome `json:"outcome"`
}
type scratchEnvelope struct {
	Version uint8         `json:"schemaVersion"`
	Kind    string        `json:"kind"`
	Record  scratchRecord `json:"record"`
}

func scratchDir(d domain.DirectoryIdentity) scratchDirectory {
	return scratchDirectory{Device: d.Device, Inode: d.Inode}
}
func (d scratchDirectory) domain() domain.DirectoryIdentity {
	return domain.DirectoryIdentity{Device: d.Device, Inode: d.Inode}
}
func encodeScratch(state *domain.State) ([]byte, error) {
	b := state.Binding()
	i, s := b.Identity, b.Scratch
	r := scratchRecord{Identity: ownerIdentity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, ComputerGeneration: b.ComputerGeneration, WorkspaceID: b.WorkspaceID, RelativePath: b.RelativePath, RequestDigest: b.RequestDigest, Scratch: scratchSpec{RunID: s.RunID, Root: s.Root, RootIdentity: scratchDir(s.RootIdentity), Leaf: s.Leaf, ExpectedInventory: []string{}}, Phase: state.Phase()}
	if v := state.Receipt(); v != nil {
		r.Outcome = &scratchOutcome{Receipt: &scratchReceipt{Kind: "workspace.selftest.scratch", Operation: v.Operation, RelativePath: v.RelativePath, Directory: scratchDir(v.Directory)}}
	}
	if f := state.Failure(); f != nil {
		r.Outcome = &scratchOutcome{Code: f.Code, Source: f.Source}
		if f.Directory != (domain.DirectoryIdentity{}) {
			d := scratchDir(f.Directory)
			r.Outcome.Directory = &d
		}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(scratchEnvelope{Version: scratchVersion, Kind: scratchKind, Record: r}) != nil {
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
func decodeScratch(raw []byte) (*domain.State, error) {
	corrupt := func() (*domain.State, error) { return nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT") }
	var e scratchEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != scratchVersion || e.Kind != scratchKind {
		return corrupt()
	}
	r, i, s := e.Record, e.Record.Identity, e.Record.Scratch
	if s.ExpectedInventory == nil || len(s.ExpectedInventory) != 0 || i.Scope != domain.ScopeOwnerSettings {
		return corrupt()
	}
	b := domain.Binding{Identity: domain.Identity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, ComputerGeneration: r.ComputerGeneration, WorkspaceID: r.WorkspaceID, RelativePath: r.RelativePath, RequestDigest: r.RequestDigest, Scratch: domain.ScratchBinding{RunID: s.RunID, Root: s.Root, RootIdentity: s.RootIdentity.domain(), Leaf: s.Leaf, ExpectedInventory: domain.EmptyScratchInventory}}
	var receipt *domain.Receipt
	var f *domain.Failure
	if o := r.Outcome; o != nil {
		if v := o.Receipt; v != nil {
			if v.Kind != "workspace.selftest.scratch" || v.Operation != domain.ScratchKind || o.Code != "" || o.Source != "" || o.Directory != nil {
				return corrupt()
			}
			receipt = &domain.Receipt{Operation: v.Operation, RelativePath: v.RelativePath, Directory: v.Directory.domain()}
		} else {
			f = &domain.Failure{Code: o.Code, Source: o.Source}
			if o.Directory != nil {
				f.Directory = o.Directory.domain()
			}
		}
	}
	state, err := domain.Restore(b, r.Phase, receipt, f)
	if err != nil {
		return corrupt()
	}
	canonical, err := encode(state)
	if err != nil || !bytes.Equal(canonical, raw) {
		return corrupt()
	}
	return state, nil
}
