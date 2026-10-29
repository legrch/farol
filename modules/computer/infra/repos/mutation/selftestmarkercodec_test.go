package mutation

import (
	"bytes"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestMarkerCodecPreservesOriginalAndRejectsCorruption(t *testing.T) {
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	marker, err := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSettling)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encodeSelfTestMarker(marker)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeSelfTestMarker(raw)
	if err != nil || decoded.Binding() != b || decoded.Phase() != domain.SelfTestMarkerSettling {
		t.Fatal("marker lost", decoded, err)
	}
	key, err := selfTestMarkerKey(b)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := selfTestKey(b.Identity)
	if err != nil || parent == key {
		t.Fatal("marker collides with parent", err)
	}
	for _, invalid := range [][]byte{append(bytes.Clone(raw), ' '), bytes.Replace(raw, []byte(`"settling"`), []byte(`"unknown"`), 1), bytes.Replace(raw, []byte(`"schemaVersion":11`), []byte(`"schemaVersion":12`), 1), []byte("{")} {
		if _, err := decodeSelfTestMarker(invalid); err == nil {
			t.Fatal("corrupt marker accepted", string(invalid))
		}
	}
}
