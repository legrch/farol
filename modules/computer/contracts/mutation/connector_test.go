package mutation

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	app "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// All ports below are in-process values. They prove contract delegation and
// copying only, not filesystem, host, provider, wire or activation behavior.
type connectorContractGuard struct {
	identity  domain.Identity
	workspace string
	path      string
	calls     int
	err       error
	// A later authenticated lifetime is deliberately distinct from stored origin.
	currentOrigin domain.ConnectorOrigin
}

func (g *connectorContractGuard) WithMutationObservation(_ context.Context, identity domain.Identity, workspace, path string, inspect func() error) error {
	g.calls++
	g.identity, g.workspace, g.path = identity, workspace, path
	if g.err != nil {
		return g.err
	}
	return inspect()
}

type connectorContractStore struct {
	*contractStore
	saveError error
}

func (s *connectorContractStore) Save(ctx context.Context, record *domain.State) error {
	if s.saveError != nil {
		s.save++
		return s.saveError
	}
	return s.contractStore.Save(ctx, record)
}

func connectorContractFixture(t *testing.T) (*app.ConnectorService, *contractLease, *connectorContractStore, *contractNative, app.ConnectorSelection, ConnectorRequest) {
	t.Helper()
	_, lease, records, native, request := contractFixture(t)
	selected := app.ConnectorSelection{
		ConnectorOwner:     app.ConnectorOwner{OperationID: "connector-operation", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"},
		ComputerGeneration: 7,
		Origin: domain.ConnectorOrigin{
			BuildID: "original-build", BackendGeneration: "original-backend", RuntimeID: "original-runtime", ConnectorGeneration: 2,
			SessionID: lease.b.SessionID, TaskID: lease.b.TaskID, TaskEpoch: lease.b.TaskEpoch,
			ParticipantID: lease.b.ParticipantID, TurnID: lease.b.TurnID, CallID: "original-call", Generation: 90, Operation: domain.EditKind,
		},
	}
	store := &connectorContractStore{contractStore: records}
	service, err := app.NewForConnectorExecution(selected, lease, store, native, contractDigest{}, &sync.Mutex{}, contractClock{now: time.Unix(1700000000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	return service, lease, store, native, selected, ConnectorRequest{WorkspaceID: request.WorkspaceID, Operation: request.Operation}
}

func connectorContractFailure(t *testing.T, response *ConnectorResponse, err error, code, source string) {
	t.Helper()
	var failure *Failure
	if response != nil || !errors.As(err, &failure) || failure.Code != code || failure.Source != source || failure.Retry != "never" {
		t.Fatalf("response=%#v error=%v; want %s (%s), retry never", response, err, code, source)
	}
}

func TestConnectorContractExecutionAndOriginalObservation(t *testing.T) {
	service, lease, store, native, selected, request := connectorContractFixture(t)
	executor := NewConnectorExecution(service)
	response, err := executor.Execute(context.Background(), request)
	if err != nil || response == nil || response.Receipt == nil {
		t.Fatalf("response=%#v error=%v", response, err)
	}
	wantOrigin := ConnectorOrigin{
		BuildID: "original-build", BackendGeneration: "original-backend", RuntimeID: "original-runtime", ConnectorGeneration: 2,
		SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", CallID: "original-call",
		TaskEpoch: 1, Generation: 90, Operation: "edit",
	}
	if response.OperationID != selected.OperationID || response.WorkspaceID != "work" || response.RelativePath != "note.md" || response.ComputerGeneration != 7 || response.Origin != wantOrigin || response.Phase != "completed" || response.Publication != "durable" || response.Failure != nil {
		t.Fatalf("lost original metadata: %#v", response)
	}
	before := strings.Repeat("b", 64)
	if !reflect.DeepEqual(response.Receipt, &Receipt{Operation: "edit", RelativePath: "note.md", Bytes: 3, Replacements: 1, BeforeSHA256: &before, AfterSHA256: strings.Repeat("c", 64)}) {
		t.Fatalf("lost receipt: %#v", response.Receipt)
	}
	*response.Receipt.BeforeSHA256 = "caller changed hash"
	response.Receipt.AfterSHA256 = "caller changed receipt"
	response.Origin = ConnectorOrigin{CallID: "caller changed origin"}
	response.ComputerGeneration = 999
	native.receipt.AfterSHA256 = "port changed receipt"
	selected.Origin.CallID = "composition changed call"
	lease.fail = true // The retained observer must use its current read guard.
	guard := &connectorContractGuard{currentOrigin: domain.ConnectorOrigin{BuildID: "new-build", BackendGeneration: "new-backend", RuntimeID: "new-runtime", ConnectorGeneration: 3, CallID: "new-call", TurnID: "new-turn", Generation: 91}}
	observer, err := service.Observer(guard)
	if err != nil {
		t.Fatal(err)
	}
	reader := NewConnectorObservation(observer)
	for i := 0; i < 2; i++ {
		response, err = reader.Observe(context.Background(), ConnectorObservation{WorkspaceID: "work", RelativePath: "note.md"})
		if err != nil || response == nil || response.Receipt == nil || response.Origin != wantOrigin || response.ComputerGeneration != 7 || response.Phase != "completed" || response.Publication != "durable" || *response.Receipt.BeforeSHA256 != strings.Repeat("b", 64) || response.Receipt.AfterSHA256 != strings.Repeat("c", 64) {
			t.Fatalf("observation replaced original or shared caller memory: %#v %v", response, err)
		}
		response.Origin.CallID = "caller changed observation"
		*response.Receipt.BeforeSHA256 = "caller changed observation hash"
	}
	wantIdentity := domain.Identity{Scope: domain.ScopeConnector, OperationID: "connector-operation", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	if guard.identity != wantIdentity || guard.workspace != "work" || guard.path != "note.md" || guard.calls != 4 || store.record.Binding().Connector.CallID != "original-call" || native.calls != 1 || store.admit != 1 || store.save != 1 || store.load != 0 {
		t.Fatal("observer changed identity, authority or execution counters")
	}
	response, err = executor.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
	connectorContractFailure(t, response, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "operation-store")
	response, err = reader.Execute(context.Background(), request)
	connectorContractFailure(t, response, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "operation-store")
}

func TestConnectorContractColdObservationUsesOriginalJournalOrigin(t *testing.T) {
	service, _, store, native, selected, request := connectorContractFixture(t)
	expected, err := NewConnectorExecution(service).Execute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	guard := &connectorContractGuard{currentOrigin: domain.ConnectorOrigin{CallID: "current-call", Generation: 901}}
	observer, err := app.NewConnectorObserver(selected.ConnectorOwner, store, guard)
	if err != nil {
		t.Fatal(err)
	}
	response, err := NewConnectorObservation(observer).Observe(context.Background(), ConnectorObservation{"work", "note.md"})
	if err != nil || !reflect.DeepEqual(response, expected) || store.load != 1 || guard.calls != 2 || native.calls != 1 || store.admit != 1 || store.save != 1 {
		t.Fatalf("cold observation lost original metadata or repeated effect: %#v %v", response, err)
	}
}

func TestConnectorContractRetainsMemoryOnlyPublication(t *testing.T) {
	service, _, store, native, _, request := connectorContractFixture(t)
	store.saveError = errors.New("private publication diagnostic")
	expected, err := NewConnectorExecution(service).Execute(context.Background(), request)
	if err != nil || expected == nil || expected.Phase != "completed" || expected.Publication != "memory_only" {
		t.Fatalf("response=%#v error=%v", expected, err)
	}
	observer, err := service.Observer(&connectorContractGuard{})
	if err != nil {
		t.Fatal(err)
	}
	response, err := NewConnectorObservation(observer).Observe(context.Background(), ConnectorObservation{"work", "note.md"})
	if err != nil || !reflect.DeepEqual(response, expected) || store.record.Phase() != domain.Prepared || store.load != 0 || store.admit != 1 || store.save != 1 || native.calls != 1 {
		t.Fatalf("observation upgraded publication or repeated effect: %#v %v", response, err)
	}
}

func TestConnectorContractResultCopiesIndependentDTOs(t *testing.T) {
	before := strings.Repeat("b", 64)
	source := &app.ConnectorResponse{
		OperationID: "op", WorkspaceID: "work", RelativePath: "note.md", ComputerGeneration: 7,
		Origin: domain.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2, SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", CallID: "call", TaskEpoch: 3, Generation: 4, Operation: domain.EditKind},
		Phase:  "completed", Publication: "durable",
		Receipt: &app.Receipt{Operation: "edit", RelativePath: "note.md", Bytes: 3, Replacements: 1, BeforeSHA256: &before, AfterSHA256: strings.Repeat("c", 64)},
	}
	response, err := connectorResult(source)
	if err != nil || response == nil || response.Receipt == nil {
		t.Fatalf("response=%#v error=%v", response, err)
	}
	expected := *response
	expectedReceipt := *response.Receipt
	source.OperationID, source.WorkspaceID, source.RelativePath = "changed-op", "changed-work", "changed-path"
	source.Origin = domain.ConnectorOrigin{}
	source.ComputerGeneration, source.Phase, source.Publication = 999, "changed-phase", "changed-publication"
	*source.Receipt.BeforeSHA256 = "changed-before"
	source.Receipt.AfterSHA256 = "changed-after"
	if response.OperationID != expected.OperationID || response.WorkspaceID != expected.WorkspaceID || response.RelativePath != expected.RelativePath || response.ComputerGeneration != expected.ComputerGeneration || response.Origin != expected.Origin || response.Phase != expected.Phase || response.Publication != expected.Publication || *response.Receipt.BeforeSHA256 != strings.Repeat("b", 64) || response.Receipt.AfterSHA256 != expectedReceipt.AfterSHA256 {
		t.Fatal("public response aliases app fields")
	}
	response.Receipt.Bytes = 999
	*response.Receipt.BeforeSHA256 = "caller-before"
	if source.Receipt.Bytes != 3 || *source.Receipt.BeforeSHA256 != "changed-before" {
		t.Fatal("app receipt aliases public response")
	}
	source.Receipt = nil
	source.Phase, source.Publication = "outcome_unknown", "memory_only"
	source.Failure = &app.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"}
	response, err = connectorResult(source)
	if err != nil || response.Receipt != nil || response.Phase != "outcome_unknown" || response.Publication != "memory_only" || response.Failure == nil || *response.Failure != (OutcomeFailure{Code: source.Failure.Code, Source: source.Failure.Source, Retry: "never"}) {
		t.Fatalf("lost terminal failure: %#v %v", response, err)
	}
	source.Failure.Code = "app changed"
	response.Failure.Source = "caller changed"
	if response.Failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || source.Failure.Source != "native-workspace" {
		t.Fatal("failure DTO aliases app")
	}
	if reflect.TypeOf(ConnectorOrigin{}) == reflect.TypeOf(domain.ConnectorOrigin{}) || reflect.TypeOf(ConnectorResponse{}) == reflect.TypeOf(app.ConnectorResponse{}) {
		t.Fatal("contract DTO is an app/domain alias")
	}
}

func TestConnectorContractNilSelectionAndNilSuccessFailClosed(t *testing.T) {
	for _, contract := range []*ConnectorContract{nil, {}, NewConnectorExecution(nil), NewConnectorObservation(nil), NewConnectorExecution(&app.ConnectorService{}), NewConnectorObservation(&app.ConnectorObserver{})} {
		response, err := contract.Execute(context.Background(), ConnectorRequest{})
		if response != nil || err == nil {
			t.Fatal("nil/uninitialized execution accepted")
		}
		response, err = contract.Observe(context.Background(), ConnectorObservation{})
		if response != nil || err == nil {
			t.Fatal("nil/uninitialized observation accepted")
		}
	}
	response, err := connectorResult(nil)
	connectorContractFailure(t, response, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "operation-store")
}

func TestConnectorContractFullUint64ConnectorGenerationMapping(t *testing.T) {
	for _, generation := range []uint64{9007199254740993, ^uint64(0)} {
		source := &app.ConnectorResponse{Origin: domain.ConnectorOrigin{ConnectorGeneration: generation}}
		response, err := connectorResult(source)
		if err != nil || response == nil || response.Origin.ConnectorGeneration != generation {
			t.Fatalf("connector generation %d lost precision: %#v %v", generation, response, err)
		}
		source.Origin.ConnectorGeneration = 1
		if response.Origin.ConnectorGeneration != generation {
			t.Fatal("connector generation aliases app origin")
		}
	}
}

func TestConnectorContractInvalidRequestHasNoEffects(t *testing.T) {
	service, _, store, native, _, valid := connectorContractFixture(t)
	executor := NewConnectorExecution(service)
	badHash := "not-a-hash"
	for name, request := range map[string]ConnectorRequest{
		"workspace":         {Operation: valid.Operation},
		"nil-operation":     {WorkspaceID: "work"},
		"pointer-operation": {WorkspaceID: "work", Operation: &Write{RelativePath: "note.md", Content: "body"}},
		"traversal":         {WorkspaceID: "work", Operation: Write{RelativePath: "../note.md", Content: "body"}},
		"write-hash":        {WorkspaceID: "work", Operation: Write{RelativePath: "note.md", ExpectedSHA256: &badHash}},
		"empty-edit":        {WorkspaceID: "work", Operation: Edit{RelativePath: "note.md", ExpectedSHA256: strings.Repeat("b", 64)}},
		"unchanged-edit":    {WorkspaceID: "work", Operation: Edit{RelativePath: "note.md", ExpectedSHA256: strings.Repeat("b", 64), Edits: []TextEdit{{OldText: "same", NewText: "same"}}}},
	} {
		t.Run(name, func(t *testing.T) {
			connectorContractFailure(t, nil, ValidateConnectorRequest(request), "COMPUTER_INVALID_REQUEST", "contract")
			response, err := executor.Execute(context.Background(), request)
			connectorContractFailure(t, response, err, "COMPUTER_INVALID_REQUEST", "contract")
		})
	}
	for _, request := range []ConnectorRequest{valid, {WorkspaceID: "work", Operation: Write{RelativePath: "note.md", Content: "private payload"}}} {
		if err := ValidateConnectorRequest(request); err != nil {
			t.Fatal("pure shape validation rejected valid intent", err)
		}
	}
	// Shape validity does not permit a different operation than the selected origin.
	response, err := executor.Execute(context.Background(), ConnectorRequest{WorkspaceID: "work", Operation: Write{RelativePath: "note.md", Content: "body"}})
	connectorContractFailure(t, response, err, "COMPUTER_INVALID_REQUEST", "contract")
	if store.admit != 0 || store.save != 0 || store.load != 0 || native.calls != 0 {
		t.Fatal("invalid input or pure validation caused effects")
	}
}

func TestConnectorContractObservationRefusalAndInvalidInput(t *testing.T) {
	_, _, store, native, selected, _ := connectorContractFixture(t)
	guard := &connectorContractGuard{}
	observer, err := app.NewConnectorObserver(selected.ConnectorOwner, store, guard)
	if err != nil {
		t.Fatal(err)
	}
	reader := NewConnectorObservation(observer)
	for _, request := range []ConnectorObservation{{}, {"work", "../note.md"}, {"work", "/note.md"}} {
		response, err := reader.Observe(context.Background(), request)
		connectorContractFailure(t, response, err, "COMPUTER_INVALID_REQUEST", "contract")
	}
	if guard.calls != 0 || store.load != 0 {
		t.Fatal("invalid observation reached ports")
	}
	for _, failure := range []error{authority.Fail("AUTHORITY_PATH_DENIED", "computer-policy"), errors.New("private guard diagnostic"), authority.Fail("PRIVATE_CODE", "private-source")} {
		guard.err = failure
		response, err := reader.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
		code, source := "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", "operation-store"
		if classified, ok := failure.(*authority.Failure); ok && classified.Code == "AUTHORITY_PATH_DENIED" {
			code, source = classified.Code, classified.Source
		} else if _, ok := failure.(*authority.Failure); !ok {
			code, source = "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"
		}
		connectorContractFailure(t, response, err, code, source)
	}
	guard.err = nil
	response, err := reader.Observe(context.Background(), ConnectorObservation{"work", "note.md"})
	connectorContractFailure(t, response, err, "COMPUTER_MUTATION_OPERATION_NOT_FOUND", "operation-store")
	if store.load != 1 || store.admit != 0 || store.save != 0 || native.calls != 0 {
		t.Fatal("read/refusal created execution effects")
	}
}

func TestConnectorContractExecutionRefusalAndTerminalFailure(t *testing.T) {
	service, lease, store, native, _, request := connectorContractFixture(t)
	lease.a.Generation++
	response, err := NewConnectorExecution(service).Execute(context.Background(), request)
	connectorContractFailure(t, response, err, "AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	if store.admit != 0 || store.save != 0 || native.calls != 0 {
		t.Fatal("selected generation refusal caused effects")
	}
	for _, code := range []string{"WORKSPACE_MUTATION_CONFLICT", "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"} {
		t.Run(code, func(t *testing.T) {
			service, _, store, native, _, request := connectorContractFixture(t)
			native.receipt, native.err = nil, authority.Fail(code, "native-workspace")
			response, err := NewConnectorExecution(service).Execute(context.Background(), request)
			phase := "failed"
			if code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
				phase = "outcome_unknown"
			}
			if err != nil || response == nil || response.Receipt != nil || response.Phase != phase || response.Publication != "durable" || response.Failure == nil || *response.Failure != (OutcomeFailure{Code: code, Source: "native-workspace", Retry: "never"}) {
				t.Fatalf("response=%#v error=%v", response, err)
			}
			observer, err := service.Observer(&connectorContractGuard{})
			if err != nil {
				t.Fatal(err)
			}
			observed, err := NewConnectorObservation(observer).Observe(context.Background(), ConnectorObservation{"work", "note.md"})
			if err != nil || !reflect.DeepEqual(observed, response) || store.admit != 1 || store.save != 1 || native.calls != 1 {
				t.Fatalf("observation changed failure or repeated effect: %#v %v", observed, err)
			}
		})
	}
}

var _ port.CurrentMutationObservation = (*connectorContractGuard)(nil)
var _ port.MutationRepository = (*connectorContractStore)(nil)
