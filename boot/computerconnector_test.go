package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/transport/desktop"
)

// Aggregate source fixture: real connector/execution/workspace policy, injected
// journal publication, endpoint and filesystem. No native/socket/MCP acceptance.
type connectorJournalFixture struct {
	*settingsStoreFixture
	publications, withdrawals int
	lost                      bool
}

func (j *connectorJournalFixture) PublishConnector(ctx context.Context, in port.ConnectorLaunch) (port.ConnectorPublication, error) {
	j.publications++
	p, err := j.Admit(ctx, j.revision, in.Admission, in.Participant)
	if err != nil {
		return port.ConnectorPublication{}, err
	}
	if j.lost {
		return port.ConnectorPublication{}, errors.New("lost publication response")
	}
	return port.ConnectorPublication{Revision: j.revision, OriginalPublished: true, Participant: p.Clone(), Approval: j.approval.Clone()}, nil
}
func (j *connectorJournalFixture) WithdrawConnector(_ context.Context, id string) error {
	j.withdrawals++
	j.RevokeParticipant(id)
	return nil
}

type connectorEndpointFixture struct {
	value   wire.ComputerConnectorEndpoint
	closes  int
	fail    bool
	closing chan struct{}
	release chan struct{}
}

func (e *connectorEndpointFixture) Endpoint() wire.ComputerConnectorEndpoint { return e.value }
func (e *connectorEndpointFixture) Close(context.Context) error {
	e.closes++
	if e.closing != nil {
		close(e.closing)
		<-e.release
	}
	if e.fail {
		return errors.New("unsettled endpoint")
	}
	return nil
}
func newConnectorFixture(t *testing.T) (*computerConnector, *connectorJournalFixture, *settingsNativeFixture, *connectorEndpointFixture, wire.ComputerConnectorOpen) {
	t.Helper()
	root, store, native, request := settingsFixture(t)
	store.PutApproval(store.approval)
	j := &connectorJournalFixture{settingsStoreFixture: store}
	e := &connectorEndpointFixture{}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s, err := newComputerConnector(ctx, root, j, store.clock, func(_ context.Context, b wire.ComputerConnectorBinding, _ map[string]desktop.Method) (connectorEndpoint, error) {
		e.value = wire.ComputerConnectorEndpoint{Binding: b, SocketPath: "/private/tmp/fixture.sock", Token: strings.Repeat("a", 64)}
		return e, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return s, j, native, e, wire.ComputerConnectorOpen{Publication: request.Publication, RuntimeId: "runtime", ConnectorGeneration: "9007199254740993", LaunchDigest: strings.Repeat("b", 64)}
}
func connectorListFixture(t *testing.T, s *computerConnector, out *wire.ComputerConnectorOpened) *desktop.Outcome {
	t.Helper()
	e := out.Execution
	in := wire.ComputerListRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "list", WorkspaceId: "work", RelativePath: "."}
	return computerInvoke(t, s.current.route.Methods(s.root.peer)["computer.workspace.list"], in)
}
func TestComputerConnectorUsesSameOwnerWithoutChat(t *testing.T) {
	s, j, native, endpoint, in := newConnectorFixture(t)
	out, err := s.Open(context.Background(), "open", in)
	if err != nil {
		t.Fatal(err)
	}
	if out.Endpoint.Binding.ConnectorGeneration != in.ConnectorGeneration || out.AdmissionOperationId != "open" || j.publications != 1 {
		t.Fatal("crossed admission")
	}
	route := s.current.route
	if value := connectorListFixture(t, s, out); value.Status != "ok" || native.calls != 1 {
		t.Fatal("list did not reach selected owner", value)
	}
	if _, err := s.current.owner.Reconnect(context.Background()); err != nil || s.current.route != route {
		t.Fatal("reconnect replaced route", err)
	}
	if _, err := s.Open(context.Background(), "duplicate", in); err == nil || j.publications != 1 {
		t.Fatal("second owner admitted")
	}
	if s.root.chat != nil || s.root.readFacade != nil || len(s.root.tasks) != 0 || len(s.root.turns) != 0 {
		t.Fatal("fabricated Chat/Task")
	}
	closed, err := s.Close(context.Background(), "close", wire.ComputerConnectorClose{Binding: out.Endpoint.Binding})
	if err != nil || !closed.Closed || endpoint.closes != 1 || j.withdrawals != 1 || s.current != nil {
		t.Fatal("unsettled close", err)
	}
	if err := s.Shutdown(); err != nil || endpoint.closes != 1 || j.withdrawals != 1 {
		t.Fatal("shutdown replayed")
	}
}
func TestComputerConnectorRejectsLateAuthorityAndLostPublication(t *testing.T) {
	for _, mode := range []string{"before", "during", "disclosure", "lost", "foreign"} {
		t.Run(mode, func(t *testing.T) {
			s, j, native, _, in := newConnectorFixture(t)
			switch mode {
			case "before":
				s.root.guard.deactivate()
			case "during":
				j.afterAdmit = func() { s.root.guard.deactivate() }
			case "disclosure":
				native.after = func() { s.root.guard.deactivate() }
			case "lost":
				j.lost = true
			case "foreign":
				in.Publication.ApprovalDigest = strings.Repeat("c", 64)
			}
			out, err := s.Open(context.Background(), "open", in)
			if mode == "disclosure" {
				if err != nil {
					t.Fatal(err)
				}
				if value := connectorListFixture(t, s, out); value.Status == "ok" {
					t.Fatal("stale disclosure")
				}
				return
			}
			if err == nil || out != nil {
				t.Fatal("invalid publication exposed endpoint")
			}
			if (mode == "before" || mode == "foreign") && j.publications != 0 {
				t.Fatal("invalid publication caused IO")
			}
			if mode == "lost" {
				if _, err = s.Open(context.Background(), "retry", in); err == nil || j.publications != 1 {
					t.Fatal("lost publication retried")
				}
				if err = s.Shutdown(); err == nil {
					t.Fatal("unknown startup promoted to clean shutdown")
				}
			}
		})
	}
}
func TestComputerConnectorCloseFailureRetainsFenceAndNeverRetries(t *testing.T) {
	s, j, _, endpoint, in := newConnectorFixture(t)
	out, err := s.Open(context.Background(), "open", in)
	if err != nil {
		t.Fatal(err)
	}
	endpoint.fail = true
	if _, err = s.Close(context.Background(), "close", wire.ComputerConnectorClose{Binding: out.Endpoint.Binding}); err == nil {
		t.Fatal("unknown close accepted")
	}
	if _, err = s.current.owner.Reconnect(context.Background()); err == nil {
		t.Fatal("close retained positive authority")
	}
	if err = s.Shutdown(); err == nil || endpoint.closes != 1 || j.withdrawals != 1 {
		t.Fatal("shutdown replayed unknown close")
	}
	if _, err = s.Open(context.Background(), "new", in); err == nil {
		t.Fatal("unknown slot replaced")
	}
}

func TestComputerConnectorShutdownBoundsBusyStart(t *testing.T) {
	s, _, _, endpoint, in := newConnectorFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	s.start = func(_ context.Context, b wire.ComputerConnectorBinding, _ map[string]desktop.Method) (connectorEndpoint, error) {
		endpoint.value = wire.ComputerConnectorEndpoint{Binding: b, SocketPath: "/private/tmp/fixture.sock", Token: strings.Repeat("a", 64)}
		close(entered)
		<-release
		return endpoint, nil
	}
	done := make(chan error, 1)
	go func() {
		out, err := s.Open(context.Background(), "open", in)
		if out != nil {
			err = errors.New("late endpoint exposed")
		}
		done <- err
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := s.shutdown(ctx); err == nil {
		t.Fatal("busy startup reported settled")
	}
	close(release)
	if err := <-done; err == nil || err.Error() == "late endpoint exposed" {
		t.Fatal("late start regained positive authority", err)
	}
	if err := s.Shutdown(); err == nil {
		t.Fatal("late unknown startup promoted to clean")
	}
}
func TestComputerConnectorRuntimeWithdrawsIngressBeforeDrain(t *testing.T) {
	s, _, _, endpoint, in := newConnectorFixture(t)
	out, err := s.Open(context.Background(), "open", in)
	if err != nil {
		t.Fatal(err)
	}
	s.root.guard.mu.Lock()
	s.root.guard.active = true
	previous := s.root.guard.revision
	s.root.guard.mu.Unlock()
	endpoint.closing = make(chan struct{})
	endpoint.release = make(chan struct{})
	runtime := &NativeRuntime{ingress: s.root, connector: s, cancel: s.cancel}
	done := make(chan error, 1)
	go func() { done <- runtime.Close() }()
	<-endpoint.closing
	s.root.guard.mu.Lock()
	negative := !s.root.guard.active && s.root.guard.revision > previous
	s.root.guard.mu.Unlock()
	if !negative {
		close(endpoint.release)
		<-done
		t.Fatal("ingress retained positive fence during drain")
	}
	e := out.Execution
	body, _ := json.Marshal(wire.ComputerListRequest{OwnerId: e.OwnerId, SessionId: e.SessionId, TaskId: e.TaskId, TaskEpoch: e.TaskEpoch, ParticipantId: e.ParticipantId, TurnId: e.TurnId, Generation: e.Generation, CallId: "during-close", WorkspaceId: "work", RelativePath: "."})
	value, requestErr := s.current.route.Methods(s.root.peer)["computer.workspace.list"].Handle(context.Background(), desktop.Request{RequestID: "during-close", Body: body})
	if requestErr == nil && value != nil && value.Status == "ok" {
		close(endpoint.release)
		<-done
		t.Fatal("draining runtime disclosed data")
	}
	close(endpoint.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
