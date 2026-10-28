package boot

import (
	"context"
	"testing"
)

// This exercises the common foreground entry point with the real connector
// authority owners and synthetic native process, not a live Shell process.
func TestForegroundShellUsesCurrentConnectorOnce(t *testing.T) {
	s, journal, native, _ := processWireFixture(t)
	request := connectorShellRequest{WorkspaceID: "work", RelativeCwd: ".", Command: "synthetic command"}
	current := s.current.opened.Execution
	wrong := current
	wrong.Generation = "999"
	if _, err := s.startQualifiedShell(context.Background(), s.current, wrong, "foreground-wrong", "call-wrong", request, native.selectShell); err == nil {
		t.Fatal("foreign connector execution admitted")
	}
	if native.spawns != 0 || journal.reserves != 0 || len(native.requests) != 0 {
		t.Fatal("wrong owner reached the producer")
	}
	if _, err := s.startQualifiedShell(context.Background(), s.current, current, "foreground-no-producer", "call-no-producer", request, nil); err == nil {
		t.Fatal("unqualified producer admitted")
	}
	if native.spawns != 0 || journal.reserves != 0 {
		t.Fatal("missing producer caused an effect")
	}
	result, err := s.startQualifiedShell(context.Background(), s.current, current, "foreground-process", "foreground-call", request, native.selectShell)
	if err != nil || result == nil || result.OperationID != "foreground-process" || result.Handle != native.Handle() {
		t.Fatalf("unexpected foreground result: %#v %v", result, err)
	}
	if native.spawns != 1 || journal.reserves != 1 || len(native.requests) != 1 {
		t.Fatal("foreground did not use exactly one original owner")
	}
	if _, err := s.startQualifiedShell(context.Background(), s.current, current, "foreground-process", "foreground-call", request, native.selectShell); err == nil {
		t.Fatal("reused foreground operation admitted")
	}
	if native.spawns != 1 || journal.reserves != 1 {
		t.Fatal("foreground operation was replayed")
	}
}
