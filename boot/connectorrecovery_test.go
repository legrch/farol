package boot

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	processct "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/transport/desktop"
)

// Real existing root, connector and ledger owners; injected journals, endpoint,
// workspace and process doubles only. No native/host/client closure qualification.
type recoveryClosingEndpoint struct {
	connectorEndpoint
	after func()
}

func (e recoveryClosingEndpoint) Close(ctx context.Context) error {
	err := e.connectorEndpoint.Close(ctx)
	e.after()
	return err
}

func closeRecoveryFixture(t *testing.T, s *computerConnector, in wire.ComputerConnectorOpen) (wire.ComputerConnectorOpen, string) {
	t.Helper()
	closed, err := s.Close(context.Background(), "recovery-close", wire.ComputerConnectorClose{Binding: s.current.opened.Endpoint.Binding})
	if err != nil || closed == nil || !closed.Closed || closed.Recovery == nil || validateIngress("ComputerConnectorClosed", closed) != nil {
		t.Fatal("missing successful Close disposition", closed, err)
	}
	in.RecoveryFrom = &closed.Binding
	in.RuntimeId = "recovery-runtime"
	in.ConnectorGeneration = closed.Binding.ConnectorGeneration
	return in, *closed.Recovery
}

func TestConnectorRecoverySettledExactReopenRetainsOriginal(t *testing.T) {
	s, access, journal, native, in := connectorMutationFixture(t)
	originalSlot := s.current
	first, err := s.mutate(context.Background(), originalSlot, "original", "original-call", connectorWriteFixture())
	if err != nil {
		t.Fatal(err)
	}
	record := s.mutations.operations["original"]
	in, disposition := closeRecoveryFixture(t, s, in)
	if disposition != "settled" || s.mutations.frozen || s.closed.publication != in.Publication || s.closed.binding != originalSlot.opened.Endpoint.Binding {
		t.Fatal("Close changed owner provenance or froze ledger", disposition)
	}
	out, err := s.Open(context.Background(), "recovery-open", in)
	if err != nil || out == nil || out.Endpoint.Binding.RuntimeId != in.RuntimeId || out.Endpoint.Binding.ConnectorGeneration != originalSlot.opened.Endpoint.Binding.ConnectorGeneration ||
		in.Publication != s.closed.publication || access.publications != 2 || s.mutations.recoveryReserved {
		t.Fatal("exact settled recovery failed", out, err)
	}
	observed, err := s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
	if err != nil || observed == nil || observed.Origin != first.Origin || observed.Receipt.AfterSHA256 != first.Receipt.AfterSHA256 ||
		s.mutations.operations["original"] != record || journal.admits != 1 || native.calls != 1 {
		t.Fatal("recovery replaced or replayed original result", observed, err)
	}
	if err := s.closeSlot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(context.Background(), "recovery-replay", in); err == nil || access.publications != 2 {
		t.Fatal("same origin replayed")
	}
}

func TestConnectorRecoveryUnknownMutationRetainsManualObservation(t *testing.T) {
	s, access, journal, native, in := connectorMutationFixture(t)
	journal.saveFault = "after"
	if out, err := s.mutate(context.Background(), s.current, "original", "call", connectorWriteFixture()); err != nil || out == nil || out.Publication != "memory_only" {
		t.Fatal("fixture did not lose durable publication ACK", out, err)
	}
	record := s.mutations.operations["original"]
	in, disposition := closeRecoveryFixture(t, s, in)
	if disposition != "operation_unknown" {
		t.Fatal("saved bytes upgraded original uncertainty", disposition)
	}
	if out, err := s.Open(context.Background(), "automatic", in); out != nil || err == nil || access.publications != 1 {
		t.Fatal("unknown mutation admitted automatic recovery")
	}
	in.RecoveryFrom = nil
	if _, err := s.Open(context.Background(), "manual", in); err != nil {
		t.Fatal(err)
	}
	out, err := s.observeMutation(context.Background(), s.current, "original", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
	if err != nil || out == nil || out.Publication != "memory_only" || s.mutations.operations["original"] != record || record.settled || journal.admits != 1 || native.calls != 1 || journal.loads != 0 {
		t.Fatal("manual observation reset unknown mutation", out, err)
	}
}

func TestConnectorRecoverySettledProcessRetainsResultAndBlocksControl(t *testing.T) {
	s, journal, child, in := processWireFixture(t)
	publisher := &connectorProcessPublisherDouble{connectorProcessJournalDouble: journal, s: s, digest: strings.Repeat("a", 64)}
	s.mutations.dependencies.repository = publisher
	started := processWireStarted(t, s)
	originalSlot := s.current
	child.terminal = true
	close(child.completed)
	awaitProcessCollection(t, s, started.OperationId)
	record := s.mutations.operations[started.OperationId]
	original := record.process
	in, disposition := closeRecoveryFixture(t, s, in)
	if disposition != "settled" || original.publication != publisher.digest {
		t.Fatal("known process result did not settle Close", disposition)
	}
	start := s.start
	entered, release := make(chan struct{}), make(chan struct{})
	s.start = func(ctx context.Context, binding wire.ComputerConnectorBinding, methods map[string]desktop.Method) (connectorEndpoint, error) {
		close(entered)
		<-release
		return start(ctx, binding, methods)
	}
	done := make(chan error, 1)
	go func() { _, err := s.Open(context.Background(), "automatic", in); done <- err }()
	<-entered
	if out, err := s.cancelProcess(context.Background(), originalSlot, "reserved-cancel", started.OperationId, started.Handle); out != nil || err == nil ||
		original.cancelDone != nil || original.cancelling || s.root.used["reserved-cancel"] {
		t.Error("control entered during recovery reservation", out, err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	out, err := s.observeProcess(context.Background(), s.current, started.OperationId, processct.ReadRequest{Handle: started.Handle})
	if err != nil || out == nil || out.State != processct.Terminal || out.StdoutBase64 != "c2F2ZWQ=" ||
		s.mutations.operations[started.OperationId] != record || record.process != original || publisher.publishes != 1 || journal.reserves != 1 || child.spawns != 1 || child.cancels != 0 {
		t.Fatal("recovery changed original process result/control", out, err)
	}
}

func TestConnectorRecoveryBlockedLedgerConsumesAttempt(t *testing.T) {
	for _, mode := range []string{"pending", "unknown", "running", "cancelling", "cancel-unknown", "collection-error", "capturing", "publication-unknown", "collector-missing", "frozen", "draining", "unqualified", "shared-authority-unknown"} {
		t.Run(mode, func(t *testing.T) {
			s, access, _, _, in := connectorMutationFixture(t)
			done := make(chan struct{})
			close(done)
			record := &settingsMutationOperation{settled: true}
			want := "pending_operation"
			switch mode {
			case "pending":
				record.pending = true
			case "unknown":
				record.settled, want = false, "operation_unknown"
			case "running":
				record.process = &connectorProcessOperation{collectionDone: make(chan struct{})}
			case "cancelling":
				record.process = &connectorProcessOperation{collectionDone: done, cancelling: true}
			case "cancel-unknown":
				record.process = &connectorProcessOperation{collectionDone: done, cancelUnknown: true}
				want = "operation_unknown"
			case "collection-error":
				record.process = &connectorProcessOperation{collectionDone: done, collectionErr: errors.New("lost collection")}
				want = "operation_unknown"
			case "capturing":
				record.process = &connectorProcessOperation{collectionDone: done, capturing: true}
			case "publication-unknown":
				record.process = &connectorProcessOperation{collectionDone: done, publishAttempted: true}
				want = "operation_unknown"
			case "collector-missing":
				record.process = &connectorProcessOperation{}
				want = "operation_unknown"
			case "frozen":
				s.mutations.frozen, want = true, "unavailable"
			case "draining":
				s.mutations.processDraining, want = true, "unavailable"
			case "unqualified":
				s.mutations.dependencies.digester, want = nil, "unavailable"
			case "shared-authority-unknown":
				s.current.endpoint = recoveryClosingEndpoint{connectorEndpoint: s.current.endpoint, after: func() { s.root.unknown = true }}
				want = "authority_unknown"
			}
			s.mutations.operations["original"] = record
			in, disposition := closeRecoveryFixture(t, s, in)
			if disposition != want {
				t.Fatalf("disposition %s, want %s", disposition, want)
			}
			if out, err := s.Open(context.Background(), "recovery-refused", in); err == nil || out != nil || access.publications != 1 || s.current != nil || s.mutations.recoveryReserved {
				t.Fatal("unsettled recovery admitted or leaked reservation", out, err)
			}
			if !s.closed.consumed || s.mutations.operations["original"] != record {
				t.Fatal("refusal lost original state or consumption")
			}
			// Test-only repaired facts cannot restore the consumed automatic attempt.
			record.pending, record.settled, record.process = false, true, nil
			s.root.unknown = false
			if out, err := s.Open(context.Background(), "recovery-retry", in); err == nil || out != nil || access.publications != 1 {
				t.Fatal("refused recovery retried")
			}
		})
	}
}

func TestConnectorRecoveryExactOriginAndCurrentConsent(t *testing.T) {
	for _, mode := range []string{"profile", "backend", "build", "runtime", "origin-generation", "changed-generation", "same-runtime", "publication", "current-generation", "current-owner", "current-computer", "current-profile", "current-backend", "revoke", "replaced-ledger"} {
		t.Run(mode, func(t *testing.T) {
			s, access, _, _, in := connectorMutationFixture(t)
			in, _ = closeRecoveryFixture(t, s, in)
			switch mode {
			case "profile":
				in.RecoveryFrom.ProfileId = "foreign"
			case "backend":
				in.RecoveryFrom.BackendGeneration = "foreign"
			case "build":
				in.RecoveryFrom.BuildId = "foreign"
			case "runtime":
				in.RecoveryFrom.RuntimeId = "foreign"
			case "origin-generation":
				in.RecoveryFrom.ConnectorGeneration = "9007199254740992"
			case "changed-generation":
				in.ConnectorGeneration = "9007199254740994"
			case "same-runtime":
				in.RuntimeId = in.RecoveryFrom.RuntimeId
			case "publication":
				in.Publication.SettingsRevision = "9"
			case "current-generation":
				access.approval.Generation++
			case "current-owner":
				s.root.ownerID = "foreign"
			case "current-computer":
				s.root.computerID = "foreign"
			case "current-profile":
				s.root.peer.ProfileId = "foreign"
			case "current-backend":
				s.root.peer.BackendGeneration = "foreign"
			case "revoke":
				_, _ = s.root.guard.deactivate()
			case "replaced-ledger":
				deps, _, _ := chatMutationDependencies()
				s.mutations, _ = settingsMutationIngress(s.root, deps)
			}
			if out, err := s.Open(context.Background(), "recovery-refused", in); out != nil || err == nil || access.publications != 1 || !s.closed.consumed {
				t.Fatal("crossed recovery admitted or left reusable", out, err)
			}
		})
	}
}

func TestConnectorRecoveryRechecksLedgerAfterClose(t *testing.T) {
	s, access, _, _, in := connectorMutationFixture(t)
	in, disposition := closeRecoveryFixture(t, s, in)
	if disposition != "settled" {
		t.Fatal(disposition)
	}
	// An actual Settings admission follows Close; its effect is held in flight.
	depsNative := s.mutations.dependencies.native.(*chatMutationNative)
	entered, release := make(chan struct{}), make(chan struct{})
	depsNative.after = func() { close(entered); <-release }
	edit := recoverySettingsEdit(in)
	done := make(chan error, 1)
	go func() { _, err := s.mutations.edit(context.Background(), "raced-settings", edit); done <- err }()
	<-entered
	out, err := s.Open(context.Background(), "recovery-refused", in)
	close(release)
	mutationErr := <-done
	if out != nil || err == nil || mutationErr != nil || access.publications != 1 || s.mutations.frozen {
		t.Fatal("Close snapshot authorized a later pending ledger", out, err, mutationErr)
	}
}

func recoverySettingsEdit(in wire.ComputerConnectorOpen) wire.ComputerSettingsEditRequest {
	return wire.ComputerSettingsEditRequest{Publication: in.Publication, WorkspaceId: "work", RelativePath: "note.md", ExpectedSHA256: strings.Repeat("b", 64), Edits: []wire.ComputerTextEdit{{OldText: "old", NewText: "new"}}}
}

func TestConnectorRecoveryReservationRefusesConcurrentAdmissions(t *testing.T) {
	s, journal, child, in := processWireFixture(t)
	originalSlot := s.current
	in, disposition := closeRecoveryFixture(t, s, in)
	if disposition != "settled" {
		t.Fatal(disposition)
	}
	start := s.start
	entered, release := make(chan struct{}), make(chan struct{})
	s.start = func(ctx context.Context, binding wire.ComputerConnectorBinding, methods map[string]desktop.Method) (connectorEndpoint, error) {
		if !s.mutations.mu.TryLock() {
			return nil, errors.New("endpoint IO under ledger mutex")
		}
		s.mutations.mu.Unlock()
		close(entered)
		<-release
		return start(ctx, binding, methods)
	}
	done := make(chan error, 1)
	go func() { _, err := s.Open(context.Background(), "recovery-open", in); done <- err }()
	<-entered
	// Both original and newly constructing slots must honor the same ledger gate.
	for _, slot := range []*connectorSlot{originalSlot, s.current} {
		if out, err := s.mutate(context.Background(), slot, "raced-mutation", "call", connectorWriteFixture()); out != nil || err == nil {
			t.Error("mutation crossed recovery reservation")
		}
		if out, err := s.startProcess(context.Background(), slot, "raced-process", "call", child.selectLaunch); out != nil || err == nil {
			t.Error("process crossed recovery reservation")
		}
	}
	editDone := make(chan error, 1)
	go func() {
		_, err := s.mutations.edit(context.Background(), "raced-settings", recoverySettingsEdit(in))
		editDone <- err
	}()
	select {
	case err := <-editDone:
		if err == nil {
			t.Error("Settings crossed recovery reservation")
		}
	case <-time.After(time.Second):
		t.Error("Settings waited on publication IO instead of refusing reservation")
	}
	close(release)
	if err := <-done; err != nil || s.mutations.recoveryReserved || len(s.mutations.operations) != 0 || journal.reserves != 0 || child.spawns != 0 {
		t.Fatal("reservation leaked or racing effect admitted", err)
	}
}

func TestConnectorRecoveryRevokeRaceNeverDisclosesEndpoint(t *testing.T) {
	for _, stage := range []string{"before-endpoint", "during-endpoint"} {
		t.Run(stage, func(t *testing.T) {
			s, access, _, _, in := connectorMutationFixture(t)
			in, _ = closeRecoveryFixture(t, s, in)
			starts := 0
			start := s.start
			s.start = func(ctx context.Context, binding wire.ComputerConnectorBinding, methods map[string]desktop.Method) (connectorEndpoint, error) {
				starts++
				_, _ = s.root.guard.deactivate()
				return start(ctx, binding, methods)
			}
			if stage == "before-endpoint" {
				access.afterAdmit = func() { _, _ = s.root.guard.deactivate() }
			}
			out, err := s.Open(context.Background(), "recovery-open", in)
			if out != nil || err == nil || s.mutations.recoveryReserved || !s.closed.consumed || s.current == nil || !s.current.startupUncertain ||
				(stage == "before-endpoint" && starts != 0) {
				t.Fatal("late revoke disclosed or reset publication uncertainty", out, err)
			}
			if _, err := s.Open(context.Background(), "recovery-retry", in); err == nil || access.publications != 2 {
				t.Fatal("revoked recovery retried")
			}
		})
	}
}

func TestConnectorRecoveryMissingLedgerKeepsManualReadRejoin(t *testing.T) {
	s, access, _, _, in := newConnectorFixture(t)
	if _, err := s.Open(context.Background(), "open", in); err != nil {
		t.Fatal(err)
	}
	in, disposition := closeRecoveryFixture(t, s, in)
	if disposition != "unavailable" {
		t.Fatal("missing ledger treated as settled", disposition)
	}
	if out, err := s.Open(context.Background(), "automatic", in); out != nil || err == nil || access.publications != 1 {
		t.Fatal("missing ledger admitted automatic recovery")
	}
	in.RecoveryFrom = nil
	out, err := s.Open(context.Background(), "manual", in)
	if err != nil || out == nil || connectorListFixture(t, s, out).Status != "ok" || access.publications != 2 {
		t.Fatal("missing ledger blocked ordinary manual read rejoin", out, err)
	}
}

func TestConnectorRecoveryRunningAndCancelUnknownOriginalOwners(t *testing.T) {
	for _, unknownCancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "running", true: "cancel-unknown"}[unknownCancel], func(t *testing.T) {
			s, journal, child, in := processWireFixture(t)
			started := processWireStarted(t, s)
			if unknownCancel {
				child.cancelErr = errors.New("lost original control ACK")
				if out, err := s.cancelProcess(context.Background(), s.current, "cancel-original", started.OperationId, started.Handle); out != nil || err == nil {
					t.Fatal("fixture did not retain cancel UNKNOWN")
				}
			}
			record := s.mutations.operations[started.OperationId]
			in, disposition := closeRecoveryFixture(t, s, in)
			want := "pending_operation"
			if unknownCancel {
				want = "operation_unknown"
			}
			if disposition != want {
				t.Fatal("actual original process disposition", disposition)
			}
			if out, err := s.Open(context.Background(), "automatic", in); out != nil || err == nil || s.mutations.operations[started.OperationId] != record || child.spawns != 1 || journal.reserves != 1 || child.cancels != map[bool]int{false: 0, true: 1}[unknownCancel] {
				t.Fatal("blocked recovery changed original child/control")
			}
			in.RecoveryFrom = nil
			if _, err := s.Open(context.Background(), "manual", in); err != nil {
				t.Fatal("manual retained observation blocked", err)
			}
			out, err := s.observeProcess(context.Background(), s.current, started.OperationId, processct.ReadRequest{Handle: started.Handle})
			if unknownCancel && (out != nil || err == nil) || !unknownCancel && (err != nil || out == nil || out.State != processct.Running) {
				t.Fatal("manual rejoin lost original observation classification", out, err)
			}
		})
	}
}
