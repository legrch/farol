package records

import (
	"encoding/json"

	release "github.com/legrch/farol/modules/release/domain"
)

type Build struct {
	Digest  string `json:"digest"`
	Version string `json:"version"`
	BuildID string `json:"buildId"`
}

type Operation struct {
	ID     string `json:"operationId"`
	Source Build  `json:"source"`
	Target Build  `json:"target"`
}

func build(v any) (Build, bool) {
	m, ok := object(v, []string{"digest", "version", "buildId"}, nil)
	if !ok {
		return Build{}, false
	}
	digest, a := hex(m["digest"], 64)
	version, b := text(m["version"], 0, 128)
	id, c := hex(m["buildId"], 64)
	// The persisted TS AcceptedBuild schema has no minimum version length.
	// This is parsing parity only; the verified native build must be nonempty.
	return Build{digest, version, id}, a && b && c
}

func operation(m map[string]any) (Operation, bool) {
	id, a := hex(m["operationId"], 32)
	source, b := build(m["source"])
	target, c := build(m["target"])
	return Operation{id, source, target}, a && b && c
}

func nestedOperation(v any) (Operation, bool) {
	m, ok := object(v, []string{"operationId", "source", "target"}, nil)
	if !ok {
		return Operation{}, false
	}
	return operation(m)
}

func phase(v any) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	switch s {
	case "prepared", "predecessor_saved", "new_installed", "verified", "rollback_started", "rolled_back", "launch_requested", "completed", "cancelled", "cancel_launch_requested", "cancel_completed", "rollback_launch_requested", "rollback_completed":
		return s, true
	default:
		return "", false
	}
}

type Journal struct {
	Schema string `json:"schema"`
	Operation
	Phase string `json:"phase"`
	Note  string `json:"note,omitempty"`
}

func DecodeJournal(data []byte, expected Operation) (*Journal, error) {
	m, err := decode(data)
	if err != nil {
		return nil, err
	}
	m, ok := object(m, []string{"schema", "operationId", "source", "target", "phase"}, []string{"note"})
	if !ok || m["schema"] != "farol.installed-update-journal/1" {
		return nil, Invalid
	}
	op, a := operation(m)
	p, b := phase(m["phase"])
	note, _ := m["note"].(string)
	if raw, exists := m["note"]; exists && (raw != "predecessor_drain_unconfirmed") {
		return nil, Invalid
	}
	if !a || !b {
		return nil, Invalid
	}
	if op != expected {
		return nil, BindingMismatch
	}
	return &Journal{Schema: "farol.installed-update-journal/1", Operation: op, Phase: p, Note: note}, nil
}

// EncodeJournal emits the existing helper schema, not a new canonical ledger.
// Successful encoding is not a persisted intent or permission to dispatch.
func EncodeJournal(j Journal) ([]byte, error) {
	data, err := json.Marshal(j)
	if err != nil {
		return nil, Invalid
	}
	if len(data)+1 > MaxHelperRecordBytes {
		return nil, Oversized
	}
	if _, err := DecodeJournal(data, j.Operation); err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func (j Journal) Domain() release.Journal {
	mapBuild := func(b Build) release.Build {
		return release.Build{Digest: b.Digest, Version: b.Version, BuildID: b.BuildID}
	}
	return release.Journal{Operation: release.Operation{ID: j.ID, Source: mapBuild(j.Source), Target: mapBuild(j.Target)}, Phase: j.Phase, Note: j.Note}
}
