package boot

import (
	"context"
	"encoding/json"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Real root/connector policy with injected stores, endpoint and native ports.
// These cases do not start an app, backend process, socket or provider.
func TestComputerConnectorReadOnlyProfileWithMutationOwner(t *testing.T) {
	s, access, reads, _, in := newConnectorFixture(t)
	deps, records, writes := chatMutationDependencies()
	var err error
	s.mutations, err = settingsMutationIngress(s.root, deps)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.Open(context.Background(), "read-only-open", in)
	if err != nil {
		t.Fatal("read-only connector failed with installed mutation owner", err)
	}
	ceiling, err := s.current.owner.ExecutionCeiling(context.Background())
	if err != nil || ceiling.Participant.MutationOwnership != authority.NoOwnership {
		t.Fatal("read-only participant gained mutation ownership", err)
	}
	if result := connectorListFixture(t, s, out); result.Status != "ok" || reads.calls != 1 || access.publications != 1 {
		t.Fatal("read-only connector did not list its approved workspace", result)
	}
	if result, err := s.mutate(context.Background(), s.current, "denied-write", "call", connectorWriteFixture()); err == nil || result != nil || records.admits != 0 || writes.calls != 0 {
		t.Fatal("read-only connector gained write authority", result, err)
	}
	if s.mutations.freezeForRetirement() != nil || s.Shutdown() != nil {
		t.Fatal("settled read-only connector did not retire")
	}
}

type connectorRefusedReadFixture struct {
	*settingsNativeFixture
	reads int
}

func (n *connectorRefusedReadFixture) Read(ctx context.Context, in port.ReadRequest) (*port.ReadResponse, error) {
	n.reads++
	return n.settingsNativeFixture.Read(ctx, in)
}

func TestComputerConnectorWithdrawnReadKeepsWireRefusal(t *testing.T) {
	s, access, native, endpoint, in := newConnectorFixture(t)
	spy := &connectorRefusedReadFixture{settingsNativeFixture: native}
	s.root.native = spy
	access.approval.Capabilities = []authority.Capability{authority.List, authority.Read}
	access.PutApproval(access.approval)
	s.root.publication.approval = access.approval.Clone()
	out, err := s.Open(context.Background(), "open", in)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.root.Deactivate(context.Background(), "withdraw"); err != nil {
		t.Fatal(err)
	}
	e := out.Execution
	request := wire.ComputerReadRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "withdrawn-read", WorkspaceId: "work", RelativePath: "note.md"}
	result := computerInvoke(t, endpoint.methods["computer.workspace.read"], request)
	if result.Status != "refused" || wire.Validate("ComputerReadRefusal", result.Data) != nil {
		t.Fatal("withdrawal lost its known wire refusal", result)
	}
	var refusal wire.ComputerReadRefusal
	if err := json.Unmarshal(result.Data, &refusal); err != nil {
		t.Fatal(err)
	}
	if refusal.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || refusal.Source != "authority-store" || refusal.Retry != "never" || refusal.Request == nil || *refusal.Request != request || native.calls != 0 || spy.reads != 0 {
		t.Fatal("withdrawal changed classification, identity or reached native IO", refusal)
	}
}
