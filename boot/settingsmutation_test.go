package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// Real root/app/contract and framed Server with injected journal and native
// adapter. No profile/disk/process/Electron/provider effects occur here.
func settingsEditFixture(t *testing.T) (*SettingsMutationIngress, *settingsStoreFixture, *chatMutationJournal, *chatMutationNative, wire.ComputerSettingsEditRequest) {
	t.Helper()
	root, store, _, list := settingsFixture(t)
	store.approval.Capabilities = []authority.Capability{authority.Write}
	store.approval.Workspaces[0].Access = authority.WriteAccess
	root.publication.approval = store.approval.Clone()
	deps, journal, native := chatMutationDependencies()
	joined, err := settingsMutationIngress(root, deps)
	if err != nil {
		t.Fatal(err)
	}
	return joined, store, journal, native, wire.ComputerSettingsEditRequest{Publication: list.Publication, WorkspaceId: "work", RelativePath: "note.md", ExpectedSHA256: strings.Repeat("b", 64), Edits: []wire.ComputerTextEdit{{OldText: "old", NewText: "new"}}}
}
func settingsRead(operation string, in wire.ComputerSettingsEditRequest) wire.ComputerSettingsMutationRead {
	return wire.ComputerSettingsMutationRead{OperationId: operation, WorkspaceId: in.WorkspaceId, RelativePath: in.RelativePath, ComputerGeneration: in.Publication.Generation}
}
func TestSettingsMutationExactOwnerOneAttemptAndReadOnlyRejoin(t *testing.T) {
	s, store, j, n, in := settingsEditFixture(t)
	out, err := s.edit(context.Background(), "operation", in)
	if err != nil || out.Phase != "completed" || out.Publication != "durable" || out.Receipt == nil || out.Receipt.Replacements != 1 {
		t.Fatalf("%#v %v", out, err)
	}
	if n.calls != 1 || j.admits != 1 || j.saves != 1 || store.admits != 0 || s.computer.chat != nil || len(s.computer.tasks) != 0 || len(s.computer.turns) != 0 {
		t.Fatal("wrong composition or duplicate effect")
	}
	for key, record := range j.records {
		if key.Scope != state.ScopeOwnerSettings || key.ProfileID != "profile" || key.OwnerID != "owner" || key.ComputerID != "computer" || key.TaskID != "" || key.SessionID != "" || key.ParticipantID != "" || record.Binding().RelativePath != "note.md" {
			t.Fatal("synthetic Task or wrong target identity")
		}
	}
	if _, err = s.edit(context.Background(), "operation", in); err == nil {
		t.Fatal("root repeated operation")
	}
	store.approval.Capabilities = nil
	store.approval.Generation++
	_, _ = s.computer.guard.deactivate()
	for _, same := range []bool{true, false} {
		reader := s
		if !same {
			reader, err = settingsMutationIngress(s.computer, s.dependencies)
			if err != nil {
				t.Fatal(err)
			}
		}
		out, err = reader.observe(context.Background(), settingsRead("operation", in))
		if err != nil || out.Phase != "completed" || out.Receipt.AfterSHA256 == "" {
			t.Fatalf("rejoin %#v %v", out, err)
		}
		for _, change := range []func(*wire.ComputerSettingsMutationRead){func(r *wire.ComputerSettingsMutationRead) { r.RelativePath = "other" }, func(r *wire.ComputerSettingsMutationRead) { r.WorkspaceId = "other" }, func(r *wire.ComputerSettingsMutationRead) { r.ComputerGeneration = "4" }} {
			r := settingsRead("operation", in)
			change(&r)
			if _, err = reader.observe(context.Background(), r); err == nil {
				t.Fatal("crossed observer accepted")
			}
		}
	}
	if n.calls != 1 || j.admits != 1 || j.saves != 1 {
		t.Fatal("rejoin changed state")
	}
}
func TestSettingsMutationRevocationAndKnownResultRemainDistinct(t *testing.T) {
	for _, stage := range []string{"before", "after admission", "after effect"} {
		t.Run(stage, func(t *testing.T) {
			s, _, j, n, in := settingsEditFixture(t)
			withdraw := func() { _, _ = s.computer.guard.deactivate() }
			switch stage {
			case "before":
				withdraw()
			case "after admission":
				j.beforeAdmit = withdraw
			case "after effect":
				n.after = withdraw
			}
			out, err := s.edit(context.Background(), "op", in)
			if err == nil || out != nil {
				t.Fatal("withdrawal disclosed")
			}
			if stage != "after effect" && n.calls != 0 {
				t.Fatal("native after withdrawal")
			}
			observed, err := s.observe(context.Background(), settingsRead("op", in))
			if stage == "after effect" && (err != nil || observed.Phase != "completed") {
				t.Fatalf("known result lost %#v %v", observed, err)
			}
			if stage == "after admission" && (err != nil || observed.Phase != "failed") {
				t.Fatalf("retained refusal lost %#v %v", observed, err)
			}
		})
	}
}
func TestSettingsMutationUnknownPublicationAndPendingNeverReplay(t *testing.T) {
	for _, fault := range []string{"admit before", "admit after", "save before", "save after"} {
		t.Run(fault, func(t *testing.T) {
			s, _, j, n, in := settingsEditFixture(t)
			parts := strings.Split(fault, " ")
			if parts[0] == "admit" {
				j.admitFault = parts[1]
			} else {
				j.saveFault = parts[1]
			}
			out, err := s.edit(context.Background(), "op", in)
			if parts[0] == "admit" {
				if out != nil || err == nil || n.calls != 0 {
					t.Fatal("unknown admission executed")
				}
			} else if err != nil || out.Publication != "memory_only" || out.Phase != "completed" {
				t.Fatalf("%#v %v", out, err)
			}
			if _, err = s.edit(context.Background(), "op", in); err == nil {
				t.Fatal("repeat accepted")
			}
			out, err = s.observe(context.Background(), settingsRead("op", in))
			if parts[0] == "admit" {
				if err == nil || out != nil || j.loads != 0 {
					t.Fatal("unknown downgraded by later read")
				}
			} else if err != nil || out.Publication != "memory_only" {
				t.Fatal("memory-only lost")
			}
			if j.admits != 1 || n.calls > 1 || j.saves > 1 {
				t.Fatal("replayed")
			}
		})
	}
	s, _, _, n, in := settingsEditFixture(t)
	n.after = func() {
		if _, err := s.observe(context.Background(), settingsRead("op", in)); err == nil {
			t.Fatal("pending observer settled")
		}
	}
	if _, err := s.edit(context.Background(), "op", in); err != nil {
		t.Fatal(err)
	}
}
func TestSettingsMutationClosedWireAndActualServer(t *testing.T) {
	s, store, j, n, in := settingsEditFixture(t)
	now := time.Now().Truncate(time.Millisecond)
	s.computer.clock.(*computerClockFixture).now = now
	store.approval.ExpiresAt = now.Add(time.Hour)
	s.computer.publication.approval.ExpiresAt = store.approval.ExpiresAt
	p := taskWireTestConnectMethods(t, s.Methods(), s.computer.peer)
	out := taskWireTestData[wire.ComputerSettingsMutationResponse](t, p.call("computer.settings.edit", "op", chatComputerWireJSON(t, in)), "ComputerSettingsMutationResponse")
	if out.Phase != "completed" || out.OperationId != "op" {
		t.Fatal("wire effect result crossed")
	}
	observed := taskWireTestData[wire.ComputerSettingsMutationResponse](t, p.call("computer.settings.mutation.read", "", chatComputerWireJSON(t, settingsRead("op", in))), "ComputerSettingsMutationResponse")
	if observed.Receipt.AfterSHA256 != out.Receipt.AfterSHA256 || n.calls != 1 || j.saves != 1 {
		t.Fatal("wire observer repeated effect")
	}
	for _, r := range []desktop.Request{
		{RequestID: "no-op", Body: []byte(chatComputerWireJSON(t, in))},
		{RequestID: "unknown-field", OperationID: "unknown-field", Body: []byte(strings.TrimSuffix(chatComputerWireJSON(t, in), "}") + `,"ownerId":"other"}`)},
		{RequestID: "empty", OperationID: "empty", Body: []byte(`{}`)},
	} {
		result, err := s.Methods()["computer.settings.edit"].Handle(context.Background(), r)
		if err != nil || result == nil || result.Status != "refused" {
			t.Fatal("open wire accepted")
		}
	}
	raw, _ := json.Marshal(settingsRead("op", in))
	result, err := s.Methods()["computer.settings.mutation.read"].Handle(context.Background(), desktop.Request{RequestID: "effect-read", OperationID: "effect-read", Body: raw})
	if err != nil || result.Status != "refused" || n.calls != 1 || j.admits != 1 || j.saves != 1 {
		t.Fatal("observer minted permission")
	}
}

type settingsHeldMutation struct {
	entered, release chan struct{}
	effects          int
}

func (n *settingsHeldMutation) Mutate(ctx context.Context, r computerport.MutationRequest) (*computerport.MutationReceipt, error) {
	close(n.entered)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-n.release:
	}
	if err := r.BeforePublish(ctx); err != nil {
		return nil, err
	}
	n.effects++
	return nil, errors.New("fixture must be withdrawn before effect")
}
func TestSettingsMutationWireWithdrawsWhileNativeGuardWaits(t *testing.T) {
	s, store, j, _, in := settingsEditFixture(t)
	now := time.Now().Truncate(time.Millisecond)
	s.computer.clock.(*computerClockFixture).now = now
	store.approval.ExpiresAt = now.Add(time.Hour)
	s.computer.publication.approval.ExpiresAt = store.approval.ExpiresAt
	held := &settingsHeldMutation{entered: make(chan struct{}), release: make(chan struct{})}
	defer func() {
		select {
		case <-held.release:
		default:
			close(held.release)
		}
	}()
	s.dependencies.native = held
	methods := s.computer.Methods()
	for name, method := range s.Methods() {
		methods[name] = method
	}
	p := taskWireTestConnectMethods(t, methods, s.computer.peer)
	frame := func(id, method, operation string, body any) []byte {
		raw, _ := json.Marshal(body)
		v, err := json.Marshal(wire.Request{Jsonrpc: "2.0", Id: id, Method: method, Params: wire.Call{Context: &p.scope, OperationId: taskWireOptional(operation), Body: raw}})
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	if err := ipc.WriteFrame(p.in, frame("held-edit", "computer.settings.edit", "op", in)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-held.entered:
	case <-time.After(time.Second):
		t.Fatal("mutation never reached controlled native")
	}
	type result struct {
		raw []byte
		err error
	}
	ack := make(chan result, 1)
	go func() {
		if err := ipc.WriteFrame(p.in, frame("withdraw", "computer.authority.deactivate", "withdraw", wire.Empty{})); err != nil {
			ack <- result{err: err}
			return
		}
		raw, err := ipc.ReadFrame(p.out)
		ack <- result{raw, err}
	}()
	select {
	case got := <-ack:
		var response wire.Response
		if got.err != nil || json.Unmarshal(got.raw, &response) != nil || response.Id == nil || *response.Id != "withdraw" || response.Result == nil || response.Result.Status != "ok" {
			t.Fatalf("withdrawal blocked %#v %v", response, got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("withdrawal waited behind native mutation")
	}
	close(held.release)
	raw, err := ipc.ReadFrame(p.out)
	if err != nil {
		t.Fatal(err)
	}
	var response wire.Response
	if json.Unmarshal(raw, &response) != nil || response.Result == nil || response.Result.Status == "ok" {
		t.Fatal("late mutation disclosed success")
	}
	out, err := s.observe(context.Background(), settingsRead("op", in))
	if err != nil || out.Phase != "failed" || held.effects != 0 || j.admits != 1 || j.saves != 1 {
		t.Fatalf("guard lost %#v %v effects=%d", out, err, held.effects)
	}
}

func TestSettingsMutationRetirementRequiresKnownDurableSettlement(t *testing.T) {
	for _, fault := range []string{"empty", "completed", "before authority", "after effect observed", "after effect unobserved", "admit before", "admit after", "save before", "save after", "pending"} {
		t.Run(fault, func(t *testing.T) {
			s, _, j, n, in := settingsEditFixture(t)
			known := fault == "empty" || fault == "completed" || fault == "before authority" || fault == "after effect observed"
			switch fault {
			case "before authority":
				_, _ = s.computer.guard.deactivate()
			case "after effect observed", "after effect unobserved":
				n.after = func() { _, _ = s.computer.guard.deactivate() }
			case "admit before":
				j.admitFault = "before"
			case "admit after":
				j.admitFault = "after"
			case "save before":
				j.saveFault = "before"
			case "save after":
				j.saveFault = "after"
			case "pending":
				n.after = func() {
					if s.freezeForRetirement() == nil {
						t.Fatal("retired pending effect")
					}
				}
			}
			if fault != "empty" {
				_, _ = s.edit(context.Background(), "op", in)
			}
			if fault == "after effect observed" {
				if _, err := s.observe(context.Background(), settingsRead("op", in)); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.freezeForRetirement(); (err == nil) != known {
				t.Fatalf("known=%v retirement=%v", known, err)
			}
			before := n.calls
			if _, err := s.edit(context.Background(), "new-op", in); err == nil || n.calls != before {
				t.Fatal("new effect after freeze")
			}
			// A failed freeze stays failed even when a pending effect later finishes.
			if err := s.freezeForRetirement(); (err == nil) != known {
				t.Fatal("retirement outcome changed")
			}
		})
	}
}
