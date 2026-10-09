package boot

import (
	"reflect"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// Exercise the registered retained-result route as the first request after
// expiry. Storage, clock, endpoint and native effects are controlled fixtures;
// this does not qualify Mac sleep, durable storage or an external MCP call.
func TestComputerRenewalRetainedMutationFirstAfterExpiry(t *testing.T) {
	for _, mode := range []string{"current", "bounded", "withdrawn", "policy-changed", "already-unknown", "renewal-lost-ack"} {
		t.Run(mode, func(t *testing.T) {
			s, access, journal, native, _ := connectorMutationFixture(t)
			t.Cleanup(func() { _ = s.Shutdown() })
			store := &renewalStoreFixture{settingsStoreFixture: access.settingsStoreFixture}
			s.root.store = store
			s.root.publication.renewable = mode != "bounded"
			in := connectorWireWrite(s)
			original := connectorWireResult(t, connectorMutationInvoke(t, s, "computer.workspace.write", "original-write", in))
			publication, binding := s.root.publication.receipt, s.current.opened.Endpoint.Binding
			approval := s.root.publication.approval.Clone()
			access.clock.now = access.approval.ExpiresAt.Add(72*time.Hour + time.Millisecond)
			switch mode {
			case "withdrawn":
				_, _ = s.root.guard.deactivate()
			case "policy-changed":
				store.approval.Workspaces[0].RootIdentity.Inode = "changed"
			case "already-unknown":
				s.root.unknown = true
			case "renewal-lost-ack":
				store.commitFailure = &accessrepo.CommitFailure{Unknown: true}
			}
			read := wire.ComputerConnectorMutationRead{Execution: in.Execution, CallId: "first-after-expiry", OperationId: "original-write", WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath}
			out := connectorMutationInvoke(t, s, "computer.workspace.mutation.read", "", read)
			expectedUpdates := 0
			if mode == "current" {
				expectedUpdates = 1
				result := connectorWireResult(t, out)
				if result.Origin != original.Origin || !reflect.DeepEqual(result.Receipt, original.Receipt) || result.Phase != original.Phase || result.Publication != original.Publication || result.CallId != read.CallId || result.Execution != read.Execution {
					t.Fatal("observation replaced original result or current correlation", result)
				}
			} else if out == nil || out.Status == "ok" || len(out.Data) != 0 {
				t.Fatal("unavailable consent disclosed retained result", out)
			}
			if mode == "renewal-lost-ack" {
				expectedUpdates = 1
				if !s.root.unknown {
					t.Fatal("uncertain renewal became known")
				}
				// Observation can neither repair nor repeat an uncertain renewal.
				if again := connectorMutationInvoke(t, s, "computer.workspace.mutation.read", "", read); again.Status == "ok" || len(again.Data) != 0 {
					t.Fatal("uncertain renewal disclosed on a second observation", again)
				}
			}
			if duplicate := connectorMutationInvoke(t, s, "computer.workspace.write", "original-write", in); duplicate.Status != "unknown" {
				t.Fatal("observation authorized duplicate mutation", duplicate)
			}
			if native.calls != 1 || journal.admits != 1 || journal.saves != 1 || journal.loads != 0 || store.updates != expectedUpdates || access.publications != 1 || s.root.publication.receipt != publication || s.current.opened.Endpoint.Binding != binding || !reflect.DeepEqual(s.root.publication.approval, approval) {
				t.Fatal("observation replayed an effect, renewed twice or replaced original owner", native.calls, journal.admits, journal.saves, journal.loads, store.updates)
			}
		})
	}
}
