package boot

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type connectorEndpoint interface {
	Endpoint() wire.ComputerConnectorEndpoint
	Close(context.Context) error
}
type connectorLaunchPublisher interface {
	PublishLaunch(context.Context, []byte) (string, string, error)
}
type connectorStart func(context.Context, wire.ComputerConnectorBinding, map[string]desktop.Method) (connectorEndpoint, error)

// One slot belongs to this backend lifetime. It is not endpoint discovery or a
// second authority journal. MCP attachments never construct or replace it.
type computerConnector struct {
	effects   chan struct{}
	root      *ComputerIngress
	journal   port.ConnectorJournal
	lifetime  context.Context
	cancel    context.CancelFunc
	clock     port.Clock
	start     connectorStart
	mutations *SettingsMutationIngress
	current   *connectorSlot
	attempts  uint64
}
type connectorSlot struct {
	guard            *connectorHostGuard
	owner            *connectorsvc.Service
	route            *ComputerRoute
	endpoint         connectorEndpoint
	opened           wire.ComputerConnectorOpened
	closing          bool
	closeErr         error
	startupUncertain bool
}
type connectorHostGuard struct {
	mu          sync.Mutex
	root        *ComputerIngress
	lifetime    context.Context
	host        port.ConnectorHost
	publication wire.ComputerAuthorityPublication
	fence       uint64
	closed      bool
}

func (g *connectorHostGuard) WithConnectorCurrent(ctx context.Context, host port.ConnectorHost, inspect func(bool) error) error {
	if ctx == nil || inspect == nil {
		return computerUnavailable()
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.root.guard.mu.Lock()
	defer g.root.guard.mu.Unlock()
	g.root.mu.Lock()
	defer g.root.mu.Unlock()
	current := !g.closed && ctx.Err() == nil && g.lifetime.Err() == nil && host == g.host &&
		!g.root.unknown && !g.root.guard.exhausted && g.root.guard.revision == g.fence &&
		g.root.publication != nil && g.root.publication.receipt == g.publication
	return inspect(current)
}
func (g *connectorHostGuard) close() { g.mu.Lock(); g.closed = true; g.mu.Unlock() }

func newComputerConnector(ctx context.Context, root *ComputerIngress, journal port.ConnectorJournal, clock port.Clock, start connectorStart) (*computerConnector, error) {
	if ctx == nil || ctx.Err() != nil || root == nil || journal == nil || clock == nil || start == nil {
		return nil, computerUnavailable()
	}
	lifetime, cancel := context.WithCancel(ctx)
	return &computerConnector{root: root, journal: journal, lifetime: lifetime, cancel: cancel, clock: clock, start: start, effects: make(chan struct{}, 1)}, nil
}

func (s *computerConnector) enter(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return computerUnavailable()
	}
	select {
	case s.effects <- struct{}{}:
		return nil
	case <-ctx.Done():
		return computerUnavailable()
	}
}

// Open is reachable only on the inherited host pipe. Its caller supplies exact
// acknowledged settings provenance, never workspaces/capabilities or execution IDs.
func (s *computerConnector) Open(ctx context.Context, operation string, in wire.ComputerConnectorOpen) (*wire.ComputerConnectorOpened, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer func() { <-s.effects }()
	if ctx == nil || ctx.Err() != nil || s.lifetime.Err() != nil || validateIngress("ComputerConnectorOpen", in) != nil || s.current != nil || s.attempts >= 32 {
		return nil, computerUnavailable()
	}
	if s.mutations != nil && s.mutations.computer != s.root {
		return nil, computerUnavailable()
	}
	if in.LifecycleRoot != nil && (in.ChallengeSha256 == nil || !validProfilePath(*in.LifecycleRoot)) {
		return nil, computerUnavailable()
	}
	if err := s.root.claim(operation); err != nil {
		return nil, err
	}
	s.attempts++
	// Serialize publication IO with the existing root's host admission paths.
	s.root.effects.Lock()
	defer s.root.effects.Unlock()
	current, err := s.root.settingsAuthority(ctx, in.Publication)
	if err != nil {
		return nil, err
	}
	var approval authority.Approval
	if err = current.WithCurrent(ctx, func(value *authority.Approval) error {
		if value == nil {
			return computerUnavailable()
		}
		approval = value.Clone()
		return nil
	}); err != nil {
		return nil, err
	}
	generation, err := strconv.ParseUint(in.ConnectorGeneration, 10, 64)
	if err != nil || generation == 0 {
		return nil, computerUnavailable()
	}
	fence, _ := strconv.ParseUint(in.Publication.Fence, 10, 64)
	host := port.ConnectorHost{ProfileID: s.root.peer.ProfileId, BackendGeneration: s.root.peer.BackendGeneration, BuildID: BuildID, RuntimeID: in.RuntimeId, ConnectorGeneration: generation, LaunchDigest: in.LaunchDigest}
	guard := &connectorHostGuard{root: s.root, lifetime: s.lifetime, host: host, publication: in.Publication, fence: fence}
	slot := &connectorSlot{guard: guard, startupUncertain: true}
	s.current = slot // Any subsequent uncertain effect retains the original slot.
	ids := make([]string, 5)
	for i := range ids {
		ids[i], err = randomIngressID()
		if err != nil {
			guard.close()
			return nil, err
		}
	}
	// Only a qualified shared mutation owner can preserve approved write access.
	// Normal runtime remains read-only until that owner and its routes are wired.
	policy := authority.Policy{ExcludedPaths: approval.Clone().ExcludedPaths, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: approval.ExpiresAt}
	for _, workspace := range approval.Workspaces {
		access := authority.ReadAccess
		if s.mutations != nil {
			access = workspace.Access
		}
		policy.Workspaces = append(policy.Workspaces, authority.Scope{WorkspaceID: workspace.WorkspaceID, Root: workspace.Root, Mode: authority.Subtree, Access: access})
	}
	for _, capability := range approval.Capabilities {
		if capability == authority.List || capability == authority.Read || capability == authority.Search || capability == authority.Verify || capability == authority.Write && s.mutations != nil {
			policy.Capabilities = append(policy.Capabilities, capability)
		}
	}
	launch := port.ConnectorLaunch{Host: host, Approval: approval, TurnCorrelation: ids[4],
		Admission:   authority.Admission{Identity: authority.Identity{OwnerID: approval.OwnerID, SessionID: ids[0], TaskID: ids[1], TaskEpoch: 1}, AuthorityID: ids[2], ComputerID: approval.ComputerID, ComputerGeneration: approval.Generation, Policy: policy},
		Participant: authority.ParticipantAdmission{ParticipantID: ids[3], Role: authority.Main, MutationOwnership: authority.NoOwnership}}
	if s.mutations != nil {
		// Existing Computer write-ownership policy, not Task/Chat membership.
		launch.Participant.MutationOwnership = authority.TaskOwnership
	}
	if in.ChallengeSha256 != nil {
		value, decodeErr := hex.DecodeString(*in.ChallengeSha256)
		if decodeErr != nil || len(value) != len(launch.VerificationChallenge) {
			guard.close()
			return nil, computerUnavailable()
		}
		copy(launch.VerificationChallenge[:], value)
	}
	slot.owner, err = connectorsvc.New(&sync.Mutex{}, s.journal, guard, s.clock, launch)
	if err != nil {
		guard.close()
		return nil, err
	}
	if err = slot.owner.Publish(ctx); err != nil {
		guard.close()
		return nil, err
	}
	ceiling, err := slot.owner.ExecutionCeiling(ctx)
	if err != nil {
		guard.close()
		return nil, err
	}
	slot.route, err = computerRoute(s.journal, slot.owner, execution.Ceiling{Participant: ceiling.Participant, Approval: ceiling.Approval}, s.root.native, s.clock)
	if err != nil {
		guard.close()
		return nil, err
	}
	binding := wire.ComputerConnectorBinding{BuildId: host.BuildID, ProfileId: host.ProfileID, BackendGeneration: host.BackendGeneration, RuntimeId: host.RuntimeID, ConnectorGeneration: in.ConnectorGeneration}
	methods := slot.route.Methods(s.root.peer)
	methods["computer.connector.verify"] = s.verificationMethod(slot)
	slot.endpoint, err = s.start(s.lifetime, binding, methods)
	if err != nil || slot.endpoint == nil {
		guard.close()
		return nil, computerUnavailable()
	}
	endpoint := slot.endpoint.Endpoint()
	if endpoint.Binding != binding || validateIngress("ComputerConnectorEndpoint", endpoint) != nil {
		guard.close()
		return nil, computerUnavailable()
	}
	slot.opened = wire.ComputerConnectorOpened{Endpoint: endpoint, AdmissionOperationId: operation,
		Execution: wire.ComputerConnectorExecution{OwnerId: approval.OwnerID, SessionId: ids[0], TaskId: ids[1], TaskEpoch: "1", ParticipantId: ids[3], TurnId: ids[4], Generation: "1"}}
	if in.LifecycleRoot != nil {
		publisher, ok := slot.endpoint.(connectorLaunchPublisher)
		if !ok {
			guard.close()
			return nil, computerUnavailable()
		}
		launch := struct {
			Schema          string                       `json:"schema"`
			Opened          wire.ComputerConnectorOpened `json:"opened"`
			LifecycleRoot   string                       `json:"lifecycleRoot"`
			ChallengeSHA256 string                       `json:"challengeSha256"`
		}{"farol-go-connector/1", slot.opened, *in.LifecycleRoot, *in.ChallengeSha256}
		data, encodeErr := json.Marshal(launch)
		if encodeErr != nil {
			guard.close()
			return nil, computerUnavailable()
		}
		file, digest, publishErr := publisher.PublishLaunch(ctx, append(data, '\n'))
		if publishErr != nil {
			guard.close()
			return nil, publishErr
		}
		slot.opened.LaunchFile, slot.opened.LaunchSha256 = &file, &digest
		if validateIngress("ComputerConnectorOpened", slot.opened) != nil {
			guard.close()
			return nil, computerUnavailable()
		}
	}
	// Late settings withdrawal or request loss cannot publish a usable endpoint.
	if _, err = slot.owner.Reconnect(ctx); err != nil {
		guard.close()
		return nil, err
	}
	slot.startupUncertain = false
	result := slot.opened
	return &result, nil
}

func (s *computerConnector) closeSlot(ctx context.Context) error {
	slot := s.current
	if slot == nil {
		return nil
	}
	if slot.closing {
		return slot.closeErr
	}
	slot.closing = true
	slot.guard.close() // Negative authority precedes all shutdown IO.
	var failures []error
	if slot.startupUncertain {
		failures = append(failures, computerUnavailable())
	}
	if slot.endpoint != nil {
		failures = append(failures, slot.endpoint.Close(ctx))
	}
	if slot.owner != nil {
		failures = append(failures, slot.owner.Withdraw(ctx))
	}
	slot.closeErr = errors.Join(failures...)
	if slot.closeErr == nil {
		s.current = nil
	}
	return slot.closeErr
}
func (s *computerConnector) Close(ctx context.Context, operation string, in wire.ComputerConnectorClose) (*wire.ComputerConnectorClosed, error) {
	if err := s.enter(ctx); err != nil {
		return nil, err
	}
	defer func() { <-s.effects }()
	if ctx == nil || ctx.Err() != nil || validateIngress("ComputerConnectorClose", in) != nil || s.current == nil || s.current.opened.Endpoint.Binding != in.Binding {
		return nil, computerUnavailable()
	}
	if err := s.root.claim(operation); err != nil {
		return nil, err
	}
	if err := s.closeSlot(ctx); err != nil {
		return nil, err
	}
	return &wire.ComputerConnectorClosed{Binding: in.Binding, Closed: true}, nil
}
func (s *computerConnector) Shutdown() error {
	if s == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.shutdown(ctx)
}
func (s *computerConnector) shutdown(ctx context.Context) error {
	s.cancel() // Negative liveness precedes even waiting for another effect.
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer func() { <-s.effects }()
	return s.closeSlot(ctx)
}
func (s *computerConnector) Methods() map[string]desktop.Method {
	if s == nil {
		return nil
	}
	return map[string]desktop.Method{
		"computer.connector.verification": s.verificationObservationMethod(),
		"computer.connector.open": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerConnectorOpen", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.ComputerConnectorOpen
			if json.Unmarshal(r.Body, &body) != nil {
				return invalidIngress()
			}
			value, err := s.Open(ctx, r.OperationID, body)
			return ingressOutcome(value, err)
		}},
		"computer.connector.close": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerConnectorClose", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.ComputerConnectorClose
			if json.Unmarshal(r.Body, &body) != nil {
				return invalidIngress()
			}
			value, err := s.Close(ctx, r.OperationID, body)
			return ingressOutcome(value, err)
		}},
	}
}
