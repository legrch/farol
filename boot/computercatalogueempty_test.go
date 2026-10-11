package boot

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Real policy, execution and wire adapters with explicit in-memory owner/native
// doubles. This does not qualify a live connector or an installed application.
func TestComputerEmptyCatalogueKeepsFileAccessDenied(t *testing.T) {
	route, _, _, native, _, read := computerFixtureWithScopes(t, true)
	methods := route.Methods(wire.Context{ProfileId: "profile", BackendGeneration: "backend"})
	request := wire.ComputerCatalogueRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: read.CallId}
	out := computerInvoke(t, methods["computer.workspace.catalogue"], request)
	if out.Status != "ok" || native.calls != 0 {
		t.Fatalf("empty catalogue reached native access or failed: %+v", out)
	}
	var result struct {
		Workspaces []json.RawMessage `json:"workspaces"`
	}
	if err := json.Unmarshal(out.Data, &result); err != nil || result.Workspaces == nil || len(result.Workspaces) != 0 {
		t.Fatalf("expected explicit empty catalogue: %s", out.Data)
	}
	for _, kind := range []authority.Capability{authority.List, authority.Read, authority.Search, authority.Verify, authority.Write, authority.Shell, authority.NetworkUse} {
		if lease, err := route.admit(context.Background(), kind); err == nil || lease != nil {
			t.Fatalf("catalogue granted %s", kind)
		}
	}
	if out := computerInvoke(t, methods["computer.workspace.read"], read); out.Status != "refused" || out.Code != "AUTHORITY_CAPABILITY_DENIED" || native.calls != 0 {
		t.Fatalf("empty catalogue granted file access: %+v", out)
	}
}

func TestComputerEmptyCatalogueRetainsAdmissionGates(t *testing.T) {
	for _, mode := range []string{"revoked", "approval withdrawn", "expired", "wrong turn", "refresh refused"} {
		t.Run(mode, func(t *testing.T) {
			route, access, current, native, clock, read := computerFixtureWithScopes(t, true)
			request := wire.ComputerCatalogueRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: read.CallId}
			switch mode {
			case "revoked":
				current.binding = nil
			case "approval withdrawn":
				access.RevokeApproval("computer")
			case "expired":
				clock.now = clock.now.Add(time.Hour)
			case "wrong turn":
				request.TurnId = "other"
			case "refresh refused":
				route.beforeAdmission = func(context.Context) error { return computerUnavailable() }
			}
			out := computerInvoke(t, route.Methods(wire.Context{ProfileId: "profile", BackendGeneration: "backend"})["computer.workspace.catalogue"], request)
			if out.Status != "refused" || native.calls != 0 {
				t.Fatalf("invalid empty approval accepted: %+v", out)
			}
		})
	}
	// A nonempty scope without List must not use the empty observation exception.
	route, _, _, native, _, read := computerFixture(t, authority.Read)
	request := wire.ComputerCatalogueRequest{OwnerId: read.OwnerId, SessionId: read.SessionId, TaskId: read.TaskId, TaskEpoch: read.TaskEpoch, ParticipantId: read.ParticipantId, TurnId: read.TurnId, Generation: read.Generation, CallId: read.CallId}
	out := computerInvoke(t, route.Methods(wire.Context{ProfileId: "profile", BackendGeneration: "backend"})["computer.workspace.catalogue"], request)
	if out.Status != "refused" || out.Code != "AUTHORITY_CAPABILITY_DENIED" || native.calls != 0 {
		t.Fatalf("nonempty catalogue bypassed List: %+v", out)
	}
}
