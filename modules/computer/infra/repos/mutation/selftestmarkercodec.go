package mutation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"unicode/utf8"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const selfTestMarkerVersion = 11
const selfTestMarkerKind = "workspace_owner_selftest_marker"

type selfTestMarkerRecord struct {
	Identity           ownerIdentity              `json:"identity"`
	WorkspaceID        string                     `json:"workspaceId"`
	ComputerGeneration uint64                     `json:"computerGeneration"`
	PlanVersion        uint8                      `json:"planVersion"`
	Phase              domain.SelfTestMarkerPhase `json:"phase"`
}
type selfTestMarkerEnvelope struct {
	Version uint8                `json:"schemaVersion"`
	Kind    string               `json:"kind"`
	Record  selfTestMarkerRecord `json:"record"`
}

func selfTestMarkerKey(b domain.SelfTestBinding) (string, error) {
	if !b.Valid() {
		return "", failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	i := b.Identity
	raw := `["owner-selftest-marker-v1",` + quoteJS(i.OperationID) + "," + quoteJS(i.OwnerID) + "," + quoteJS(i.ProfileID) + "," + quoteJS(i.ComputerID) + "]"
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:]) + ".json", nil
}

func encodeSelfTestMarker(marker *domain.SelfTestMarker) ([]byte, error) {
	if marker == nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	b := marker.Binding()
	if _, err := domain.RestoreSelfTestMarker(b, marker.Phase()); err != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	i := b.Identity
	r := selfTestMarkerRecord{Identity: ownerIdentity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, WorkspaceID: b.WorkspaceID, ComputerGeneration: b.ComputerGeneration, PlanVersion: b.Version, Phase: marker.Phase()}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(selfTestMarkerEnvelope{Version: selfTestMarkerVersion, Kind: selfTestMarkerKind, Record: r}) != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	raw, err := jsSeparators(buf.Bytes())
	if err != nil || len(raw) > maxRecordBytes {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	return raw, nil
}

func decodeSelfTestMarker(raw []byte) (*domain.SelfTestMarker, error) {
	corrupt := func() (*domain.SelfTestMarker, error) { return nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT") }
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) {
		return corrupt()
	}
	var e selfTestMarkerEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != selfTestMarkerVersion || e.Kind != selfTestMarkerKind {
		return corrupt()
	}
	r, i := e.Record, e.Record.Identity
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, WorkspaceID: r.WorkspaceID, ComputerGeneration: r.ComputerGeneration, Version: r.PlanVersion}
	marker, err := domain.RestoreSelfTestMarker(b, r.Phase)
	if err != nil {
		return corrupt()
	}
	canonical, err := encodeSelfTestMarker(marker)
	if err != nil || !bytes.Equal(raw, canonical) {
		return corrupt()
	}
	return marker, nil
}
