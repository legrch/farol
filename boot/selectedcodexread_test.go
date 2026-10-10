package boot

// Real admitted connector, TaskProfile/original Codex reader, registered desktop
// transport and canonical DTOs. Persistence, clock, endpoint and provider proxy
// are controlled in-memory boundaries. No native/account/provider qualification.
import (
	"context"
	"encoding/json"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type readConnectorJournal struct{ *taskPublicationStore }

func (j readConnectorJournal) WithOwnerApproval(_ context.Context, inspect func(accessrepo.Status, *authority.Approval) error) error {
	a := j.approval.Clone()
	return inspect(accessrepo.Status{Revision: j.revision, Generation: a.Generation, ApprovalPresent: true}, &a)
}

func (j readConnectorJournal) PublishConnector(ctx context.Context, in port.ConnectorLaunch) (port.ConnectorPublication, error) {
	p, err := j.Admit(ctx, j.revision, in.Admission, in.Participant)
	if err != nil {
		return port.ConnectorPublication{}, err
	}
	return port.ConnectorPublication{Revision: j.revision, OriginalPublished: true, Participant: p.Clone(), Approval: j.approval.Clone()}, nil
}
func (j readConnectorJournal) WithdrawConnector(_ context.Context, id string) error {
	j.RevokeParticipant(id)
	return nil
}

func selectedReadConnectorFixture(t *testing.T, selected bool, afterRead ...func(*computerConnector, *taskReadSourceFixture, *selectedthread.Response) error) (*computerConnector, *taskReadSourceFixture, *connectorEndpointFixture, *wire.ComputerConnectorOpened) {
	t.Helper()
	f := newTaskReadSourceFixture(t)
	p := f.publication
	p.ingress.store = readConnectorJournal{p.store}
	f.input.HostID, p.f.task.pipe.selection.Binding.HostID = "codex", "codex"
	endpoint := &connectorEndpointFixture{}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s, err := newComputerConnector(ctx, p.ingress, readConnectorJournal{p.store}, p.store.clock, func(_ context.Context, binding wire.ComputerConnectorBinding, methods map[string]desktop.Method) (connectorEndpoint, error) {
		endpoint.value = wire.ComputerConnectorEndpoint{Binding: binding, SocketPath: "/fixture/connector.sock", Token: strings.Repeat("a", 64)}
		endpoint.methods = methods
		return endpoint, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if selected {
		reader := f.selectReader(t)
		if len(afterRead) != 0 {
			original := reader
			reader = selectedCodexReadFunc(func(ctx context.Context, in selectedthread.Request) (*selectedthread.Response, error) {
				out, err := original.Read(ctx, in)
				if err == nil {
					err = afterRead[0](s, f, out)
				}
				return out, err
			})
		}
		s.codexRead = &connectorCodexRead{hostID: "codex", reader: reader}
	}
	in := wire.ComputerConnectorOpen{Publication: p.ingress.publication.receipt, RuntimeId: "runtime", ConnectorGeneration: "1", LaunchDigest: strings.Repeat("b", 64)}
	opened, err := s.Open(ctx, "connector-open", in)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Shutdown(); err != nil {
			t.Error(err)
		}
	})
	return s, f, endpoint, opened
}

func selectedReadTransport(t *testing.T, endpoint *connectorEndpointFixture) func(string, json.RawMessage) wire.Outcome {
	t.Helper()
	server, err := desktop.New(desktop.Config{BuildID: BuildID, ProfileID: endpoint.value.Binding.ProfileId, Generation: endpoint.value.Binding.BackendGeneration, Methods: endpoint.methods})
	if err != nil {
		t.Fatal(err)
	}
	host, backend := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- server.Serve(ctx, backend, backend) }()
	t.Cleanup(func() { cancel(); _ = host.Close(); <-done })
	sequence := 0
	call := func(method string, body json.RawMessage) wire.Outcome {
		sequence++
		in := wire.Request{Jsonrpc: "2.0", Id: "request-" + decimal(uint64(sequence)), Method: method}
		in.Params.Body = body
		if method != "core.handshake" {
			in.Params.Context = &wire.Context{ProfileId: endpoint.value.Binding.ProfileId, BackendGeneration: endpoint.value.Binding.BackendGeneration}
		}
		data, err := json.Marshal(in)
		if err != nil || ipc.WriteFrame(host, data) != nil {
			t.Fatal("transport request failed", err)
		}
		raw, err := ipc.ReadFrame(host)
		var response wire.Response
		if err != nil || json.Unmarshal(raw, &response) != nil || response.Result == nil {
			t.Fatal("transport response failed", string(raw), err)
		}
		return *response.Result
	}
	hello, _ := json.Marshal(wire.Handshake{ProtocolMajor: wire.ProtocolMajor, ProtocolMinor: wire.ProtocolMinor, BuildId: BuildID, ProfileId: endpoint.value.Binding.ProfileId})
	identity := call("core.handshake", hello)
	var value wire.Identity
	if identity.Status != "ok" || json.Unmarshal(identity.Data, &value) != nil || slices.Contains(value.Capabilities, selectedCodexReadMethod) != (endpoint.methods[selectedCodexReadMethod].Handle != nil) {
		t.Fatal("crossed read capability")
	}
	return call
}

func TestSelectedCodexReadWireOriginalReaderAndCapability(t *testing.T) {
	for _, selected := range []bool{false, true} {
		t.Run(map[bool]string{false: "old-backend", true: "selected"}[selected], func(t *testing.T) {
			_, f, endpoint, opened := selectedReadConnectorFixture(t, selected)
			call := selectedReadTransport(t, endpoint)
			if !selected {
				if opened.CodexRead != nil || endpoint.methods[selectedCodexReadMethod].Handle != nil || f.factories.Load() != 0 {
					t.Fatal("normal connector exposed read")
				}
				return
			}
			if opened.CodexRead == nil || f.publication.f.task.pipe.launches.Load() != 0 {
				t.Fatal("missing inert selection")
			}
			for _, include := range []bool{false, true} {
				body, _ := json.Marshal(wire.TaskSelectedCodexReadRequest{IncludeResult: &include})
				out := call(selectedCodexReadMethod, body)
				var data wire.TaskSelectedCodexReadResponse
				if out.Status != "ok" || wire.Validate("TaskSelectedCodexReadResponse", out.Data) != nil || json.Unmarshal(out.Data, &data) != nil || data.Selection != *opened.CodexRead || data.Retained || data.ResultEvidence != "provider_history" {
					t.Fatal("read failed", out, string(out.Data))
				}
				if include != (data.Text == "retained turn-1") {
					t.Fatal("result opt-in crossed", data)
				}
			}
			p := f.publication
			if f.factories.Load() != 1 || p.f.task.pipe.launches.Load() != 1 || len(p.f.profile.tasks) != 0 || len(p.f.task.store.ops) != 0 || p.f.task.pipe.count("thread/start") != 0 || p.f.task.pipe.count("turn/start") != 0 || p.f.chat.journal.revision != f.chatRevision || p.store.admits != 1 {
				t.Fatal("read created Task/Chat admission, replay or replacement")
			}
		})
	}
}

func TestSelectedCodexReadWireRejectsTargetAndMalformedBeforeProvider(t *testing.T) {
	_, f, endpoint, _ := selectedReadConnectorFixture(t, true)
	for _, raw := range []string{`{"threadId":"other"}`, `{"turnId":"other"}`, `{"includeResult":null}`, `{"includeResult":true,"includeResult":false}`, `{"includeResult":"true"}`} {
		out, err := endpoint.methods[selectedCodexReadMethod].Handle(context.Background(), desktop.Request{Body: []byte(raw)})
		if err != nil || out.Status != "refused" || len(out.Data) != 0 || f.publication.f.task.pipe.launches.Load() != 0 {
			t.Fatal("malformed request reached provider", raw, out, err)
		}
	}
	out, err := endpoint.methods[selectedCodexReadMethod].Handle(context.Background(), desktop.Request{OperationID: "effect", Body: []byte(`{}`)})
	if err != nil || out.Status != "refused" || f.publication.f.task.pipe.launches.Load() != 0 {
		t.Fatal("read accepted effect identity", out, err)
	}
}

func TestSelectedCodexReadWireSealsOriginalReaderAndRefusesWithdrawnOwnerBeforeIO(t *testing.T) {
	for _, withdraw := range []bool{false, true} {
		t.Run(map[bool]string{false: "original-reader", true: "withdrawn"}[withdraw], func(t *testing.T) {
			s, f, endpoint, _ := selectedReadConnectorFixture(t, true)
			s.codexRead.reader = selectedCodexReadFunc(func(context.Context, selectedthread.Request) (*selectedthread.Response, error) {
				t.Fatal("registered route replaced original reader")
				return nil, task.ErrUnknown
			})
			if withdraw {
				_, _ = s.root.guard.deactivate()
			}
			out, err := endpoint.methods[selectedCodexReadMethod].Handle(context.Background(), desktop.Request{Body: []byte(`{}`)})
			if err != nil || withdraw && (out.Status == "ok" || f.publication.f.task.pipe.launches.Load() != 0) || !withdraw && out.Status != "ok" {
				t.Fatal("reader/owner fence failed", out, err)
			}
		})
	}
}

func TestSelectedCodexReadWireFencesLatePublicationAndInvalidResult(t *testing.T) {
	for _, mode := range []string{"withdraw", "reference", "crossed", "retained", "oversize", "lost", "private-error", "lease-expired"} {
		t.Run(mode, func(t *testing.T) {
			_, f, endpoint, _ := selectedReadConnectorFixture(t, true, func(s *computerConnector, f *taskReadSourceFixture, out *selectedthread.Response) error {
				switch mode {
				case "withdraw":
					_, _ = s.root.guard.deactivate()
				case "reference":
					s.root.mu.Lock()
					s.root.publication.taskCodexRead.TurnId = "other"
					s.root.mu.Unlock()
				case "crossed":
					out.Selection.Reference.TurnID = "other"
				case "retained":
					out.Retained = true
				case "oversize":
					out.Text = strings.Repeat("x", 65537)
				case "lost":
					return task.ErrUnknown
				case "private-error":
					return &selectedthread.Failure{Code: "private provider detail"}
				case "lease-expired":
					f.publication.store.clock.now = f.publication.store.clock.now.Add(time.Minute)
				}
				return nil
			})
			out, err := endpoint.methods[selectedCodexReadMethod].Handle(context.Background(), desktop.Request{Body: []byte(`{"includeResult":true}`)})
			if err != nil || out.Status == "ok" || len(out.Data) != 0 || strings.Contains(out.Code, "private") || f.factories.Load() != 1 || f.publication.f.task.pipe.launches.Load() != 1 {
				t.Fatal("late failure disclosed or replaced", out, err)
			}
		})
	}
}
