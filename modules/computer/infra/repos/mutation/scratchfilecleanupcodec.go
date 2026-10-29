package mutation

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// This envelope is evidence, not an authorization to remove a file. Admission
// must re-read both originals under the repository's exclusive writer lock.
const scratchFileCleanupVersion = 9
const scratchFileCleanupKind = "workspace_owner_selftest_file_cleanup"

type scratchFileCleanupRecord struct {
	Creation  json.RawMessage  `json:"creation"`
	Mutation  json.RawMessage  `json:"mutation"`
	Directory scratchDirectory `json:"directory"`
	File      scratchDirectory `json:"file"`
	SHA256    string           `json:"sha256"`
	Phase     domain.Phase     `json:"phase"`
	Failure   *scratchOutcome  `json:"failure"`
}

type scratchFileCleanupEnvelope struct {
	Version uint8                    `json:"schemaVersion"`
	Kind    string                   `json:"kind"`
	Record  scratchFileCleanupRecord `json:"record"`
}

func encodeScratchFileCleanup(state *domain.ScratchFileCleanupState) ([]byte, error) {
	if state == nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	i := state.Inventory()
	if _, err := domain.RestoreScratchFileCleanup(i, state.Phase(), state.Failure()); err != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	creation, err := domain.NewPrepared(i.Creation.Creation)
	if err != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	file, err := domain.NewPrepared(i.Mutation)
	if err != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	creationRaw, err := encode(creation)
	if err != nil {
		return nil, err
	}
	fileRaw, err := encode(file)
	if err != nil {
		return nil, err
	}
	r := scratchFileCleanupRecord{Creation: bytes.TrimSpace(creationRaw), Mutation: bytes.TrimSpace(fileRaw), Directory: scratchDir(i.Creation.Directory), File: scratchDir(i.File), SHA256: i.SHA256, Phase: state.Phase()}
	if f := state.Failure(); f != nil {
		r.Failure = &scratchOutcome{Code: f.Code, Source: f.Source}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(scratchFileCleanupEnvelope{Version: scratchFileCleanupVersion, Kind: scratchFileCleanupKind, Record: r}) != nil {
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

func decodeScratchFileCleanup(raw []byte) (*domain.ScratchFileCleanupState, error) {
	corrupt := func() (*domain.ScratchFileCleanupState, error) {
		return nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT")
	}
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) {
		return corrupt()
	}
	var e scratchFileCleanupEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != scratchFileCleanupVersion || e.Kind != scratchFileCleanupKind {
		return corrupt()
	}
	creation, err := decode(append(bytes.Clone(e.Record.Creation), '\n'))
	if err != nil || creation == nil || creation.Phase() != domain.Prepared {
		return corrupt()
	}
	file, err := decode(append(bytes.Clone(e.Record.Mutation), '\n'))
	if err != nil || file == nil || file.Phase() != domain.Prepared {
		return corrupt()
	}
	var f *domain.Failure
	if o := e.Record.Failure; o != nil {
		if o.Receipt != nil || o.Directory != nil {
			return corrupt()
		}
		f = &domain.Failure{Code: o.Code, Source: o.Source}
	}
	i := domain.ScratchFileInventory{Creation: domain.ScratchCleanupBinding{Creation: creation.Binding(), Directory: e.Record.Directory.domain()}, Mutation: file.Binding(), File: e.Record.File.domain(), SHA256: e.Record.SHA256}
	state, err := domain.RestoreScratchFileCleanup(i, e.Record.Phase, f)
	if err != nil {
		return corrupt()
	}
	canonical, err := encodeScratchFileCleanup(state)
	if err != nil || !bytes.Equal(canonical, raw) {
		return corrupt()
	}
	return state, nil
}
