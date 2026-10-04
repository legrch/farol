package boot

// CPU aggregate: real Chat ownership, Computer policy/lease, mutation service,
// independent contracts and fingerprinting. Journals/filesystem are explicit
// injected doubles; no native root, file publication or live browser is tested.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	mutation "github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

type chatMutationJournal struct {
	records               map[mutation.Identity]mutation.State
	admits, saves, loads  int
	admitFault, saveFault string
	beforeAdmit           func()
}

func (j *chatMutationJournal) Admit(_ context.Context, input *mutation.State) (computerport.MutationAdmission, error) {
	j.admits++
	if j.beforeAdmit != nil {
		j.beforeAdmit()
	}
	if j.admitFault == "before" {
		return computerport.MutationAdmission{}, errors.New("controlled uncertain admit")
	}
	key := input.Binding().Identity
	if old, ok := j.records[key]; ok {
		copy := old.Clone()
		return computerport.MutationAdmission{Status: computerport.MutationExisting, Record: &copy}, nil
	}
	j.records[key] = input.Clone()
	if j.admitFault == "after" {
		return computerport.MutationAdmission{}, errors.New("controlled lost admit ACK")
	}
	copy := input.Clone()
	status := computerport.MutationAdmitted
	if j.admitFault == "existing" {
		status = computerport.MutationExisting
	}
	return computerport.MutationAdmission{Status: status, Record: &copy}, nil
}
func (j *chatMutationJournal) Save(_ context.Context, input *mutation.State) error {
	j.saves++
	if j.saveFault == "before" {
		return errors.New("controlled uncertain Save")
	}
	key := input.Binding().Identity
	old, ok := j.records[key]
	if !ok {
		return errors.New("missing controlled intent")
	}
	next, err := old.Apply(*input)
	if err != nil {
		return err
	}
	j.records[key] = next.Clone()
	if j.saveFault == "after" {
		return errors.New("controlled lost Save ACK")
	}
	return nil
}
func (j *chatMutationJournal) Load(_ context.Context, key mutation.Identity) (*mutation.State, error) {
	j.loads++
	old, ok := j.records[key]
	if !ok {
		return nil, nil
	}
	copy := old.Clone()
	return &copy, nil
}

type chatMutationNative struct {
	calls int
	after func()
	seen  computerport.MutationRequest
}

func (n *chatMutationNative) Mutate(ctx context.Context, input computerport.MutationRequest) (*computerport.MutationReceipt, error) {
	n.calls++
	n.seen = input
	if input.BeforePublish == nil {
		return nil, errors.New("missing original lease check")
	}
	if err := input.BeforePublish(ctx); err != nil {
		return nil, err
	}
	receipt := &computerport.MutationReceipt{Operation: string(input.Operation.Kind()), RelativePath: input.Operation.Path()}
	var text string
	switch value := input.Operation.(type) {
	case mutation.Write:
		receipt.BeforeSHA256 = value.ExpectedSHA256
		text = value.Content
	case mutation.Edit:
		hash := value.ExpectedSHA256
		receipt.BeforeSHA256 = &hash
		receipt.Replacements = uint32(len(value.Edits))
		for _, edit := range value.Edits {
			text += edit.NewText
		}
	default:
		return nil, errors.New("unexpected controlled operation")
	}
	receipt.Bytes = uint64(len(text))
	digest := sha256.Sum256([]byte(text))
	receipt.AfterSHA256 = hex.EncodeToString(digest[:])
	if n.after != nil {
		n.after()
	}
	return receipt, nil
}
func chatMutationDependencies() (computerMutationDependencies, *chatMutationJournal, *chatMutationNative) {
	journal := &chatMutationJournal{records: map[mutation.Identity]mutation.State{}}
	native := &chatMutationNative{}
	return computerMutationDependencies{repository: journal, native: native, digester: filesystem.Digester{}}, journal, native
}
func (f *chatComputerFixture) writableComputer(t *testing.T) (*ComputerIngress, *chatComputerStore, *computerWorkspaceFixture, *computerClockFixture) {
	t.Helper()
	ingress, store, read, clock := f.computer(t)
	// A deliberately write-approved fixture before the first attachment. Never
	// mutate the ceiling of a route already selected by the production join.
	store.approval.Workspaces[0].Access = authority.WriteAccess
	store.approval.Capabilities = append(store.approval.Capabilities, authority.Write)
	store.PutApproval(store.approval)
	ingress.publication.approval = store.approval.Clone()
	return ingress, store, read, clock
}
func chatMutationContext(t *testing.T, h chatHandle) conversation.ComputerContext {
	t.Helper()
	value, err := h.handle.ComputerContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return *value
}
func TestChatComputerMutationWriteAndEditRetainTurnAndSeparateReturn(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "mutable-chat", chatComputerInput(true))
	ingress, store, reads, _ := f.writableComputer(t)
	deps, journal, native := chatMutationDependencies()
	journal.beforeAdmit = func() {
		if f.count("request-computer") != journal.admits || store.admits != 1 {
			t.Error("mutation intent preceded Chat request or original authority")
		}
	}
	ctx := context.Background()
	correlation := chatMutationContext(t, h)
	first, err := ingress.mutateConversationOnRoute(ctx, h.handle, correlation, "write", "write-call", "work", mutationct.Write{RelativePath: "note.md", Content: "First text"}, deps, nil)
	if err != nil || first.response == nil || first.response.Phase != "completed" || first.response.Publication != "durable" || first.response.Receipt.Operation != "write" {
		t.Fatal(first, err)
	}
	if first.response.TurnID != h.binding.TurnID || first.response.Generation != h.binding.TurnGeneration || first.response.CallID != "write-call" {
		t.Fatal("crossed mutation correlation")
	}
	if native.calls != 1 || journal.admits != 1 || journal.saves != 1 || store.admits != 1 || reads.calls != 0 || f.count("resolve-computer") != 0 {
		t.Fatal("effect/return boundaries changed")
	}
	if _, err = first.operation.execute(ctx); err == nil {
		t.Fatal("same operation repeated execution")
	}
	read, err := first.operation.read(ctx)
	if err != nil || read.Receipt.AfterSHA256 != first.response.Receipt.AfterSHA256 || native.calls != 1 || journal.loads != 0 {
		t.Fatal("retained read redispatched", err)
	}
	if _, err = ingress.mutateConversationOnRoute(ctx, h.handle, correlation, "fresh-before-ack", "fresh-call", "work", mutationct.Write{RelativePath: "other.md", Content: "no"}, deps, first.route); err == nil {
		t.Fatal("unreturned call admitted another mutation")
	}
	if err = first.call.AcknowledgeReturn(ctx, &conversation.ComputerReturn{Context: correlation, CallID: "write-call", Returned: true}); err != nil {
		t.Fatal(err)
	}
	nextContext := chatMutationContext(t, h)
	edits := []mutationct.TextEdit{{OldText: "First", NewText: "Second"}}
	second, err := ingress.mutateConversationOnRoute(ctx, h.handle, nextContext, "edit", "edit-call", "work", mutationct.Edit{RelativePath: "note.md", ExpectedSHA256: read.Receipt.AfterSHA256, Edits: edits}, deps, first.route)
	if err != nil || second.response.Phase != "completed" || second.response.Receipt.Operation != "edit" || second.route != first.route {
		t.Fatal("same route edit", second, err)
	}
	edits[0].NewText = "changed after selection"
	if _, err = second.operation.read(ctx); err != nil {
		t.Fatal("caller alias changed retained input", err)
	}
	if err = second.call.AcknowledgeReturn(ctx, &conversation.ComputerReturn{Context: nextContext, CallID: "edit-call", Returned: true}); err != nil {
		t.Fatal(err)
	}
	_ = f.finish(t, h)
	if native.calls != 2 || journal.admits != 2 || journal.saves != 2 || store.admits != 1 || f.count("resolve-computer") != 2 || f.physical.sends != 1 {
		t.Fatal("write/edit caused readmission or duplicate Send")
	}
}
func TestChatComputerMutationReadCeilingCannotUpgrade(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "read-before-write", chatComputerInput(true))
	ingress, store, nativeRead, _ := f.writableComputer(t)
	ctx := context.Background()
	correlation := chatMutationContext(t, h)
	_, call, route, err := ingress.readConversationOnRoute(ctx, h.handle, correlation, "read", "read-call", "work", "note.md", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = call.AcknowledgeReturn(ctx, &conversation.ComputerReturn{Context: correlation, CallID: "read-call", Returned: true}); err != nil {
		t.Fatal(err)
	}
	deps, journal, native := chatMutationDependencies()
	joined, err := ingress.mutateConversationOnRoute(ctx, h.handle, chatMutationContext(t, h), "attempt-write", "write-call", "work", mutationct.Write{RelativePath: "note.md", Content: "no"}, deps, route)
	if err == nil || joined.route != route || native.calls != 0 || journal.admits != 0 || store.admits != 1 || nativeRead.calls != 1 {
		t.Fatal("old read route widened", err)
	}
}
func TestChatComputerMutationPublicationFaultsNeverReplay(t *testing.T) {
	for _, fault := range []string{"admit-before", "admit-after", "existing", "save-before", "save-after"} {
		t.Run(fault, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "fault-chat", chatComputerInput(true))
			ingress, store, _, _ := f.writableComputer(t)
			deps, journal, native := chatMutationDependencies()
			switch fault {
			case "admit-before":
				journal.admitFault = "before"
			case "admit-after":
				journal.admitFault = "after"
			case "existing":
				journal.admitFault = "existing"
			case "save-before":
				journal.saveFault = "before"
			case "save-after":
				journal.saveFault = "after"
			}
			ctx := context.Background()
			correlation := chatMutationContext(t, h)
			joined, err := ingress.mutateConversationOnRoute(ctx, h.handle, correlation, "fault-write", "call", "work", mutationct.Write{RelativePath: "note.md", Content: "once"}, deps, nil)
			if joined == nil || joined.operation == nil {
				t.Fatal("lost retained owner", err)
			}
			if strings.HasPrefix(fault, "admit-") {
				if err == nil || native.calls != 0 || journal.saves != 0 {
					t.Fatal("uncertain intent dispatched", err)
				}
			} else if fault == "existing" {
				if err != nil || joined.response.Phase != "outcome_unknown" || native.calls != 0 || journal.saves != 0 {
					t.Fatal("existing Prepared became permission", err)
				}
				if _, err = joined.operation.read(ctx); err != nil || native.calls != 0 || journal.saves != 0 {
					t.Fatal("observation dispatched", err)
				}
			} else {
				if err != nil || joined.response.Phase != "completed" || joined.response.Publication != "memory_only" || native.calls != 1 || journal.saves != 1 {
					t.Fatal("lost terminal ACK lost known result", err)
				}
				result, err := joined.operation.read(ctx)
				if err != nil || result.Publication != "memory_only" || result.Receipt.AfterSHA256 != joined.response.Receipt.AfterSHA256 || journal.loads != 0 {
					t.Fatal("memory result replaced or promoted", err)
				}
			}
			if _, err = joined.operation.execute(ctx); err == nil {
				t.Fatal("repeated original execution")
			}
			if _, err = ingress.mutateConversationOnRoute(ctx, h.handle, correlation, "replacement", "replacement-call", "work", mutationct.Write{RelativePath: "other.md", Content: "no"}, deps, joined.route); err == nil {
				t.Fatal("uncertain/unreturned work replayed with a new key")
			}
			if store.admits != 1 || journal.admits != 1 || f.physical.sends != 1 || f.count("resolve-computer") != 0 {
				t.Fatal("fault changed one-shot ownership")
			}
		})
	}
}
func TestChatComputerMutationRetainedReadNeverRenewsLease(t *testing.T) {
	for _, reason := range []string{"expired", "revoked"} {
		t.Run(reason, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "disclosure-chat", chatComputerInput(true))
			ingress, store, _, clock := f.writableComputer(t)
			deps, journal, native := chatMutationDependencies()
			native.after = func() {
				if reason == "expired" {
					clock.now = clock.now.Add(authority.OrdinaryExecutionLifetime)
				} else {
					store.RevokeParticipant(h.binding.ParticipantID)
				}
			}
			joined, err := ingress.mutateConversationOnRoute(context.Background(), h.handle, chatMutationContext(t, h), "late-write", "call", "work", mutationct.Write{RelativePath: "note.md", Content: "once"}, deps, nil)
			if err == nil || joined.response != nil || native.calls != 1 || journal.saves != 1 {
				t.Fatal("late result disclosed", err)
			}
			if _, err = joined.operation.read(context.Background()); err == nil {
				t.Fatal("retained observation renewed original authority")
			}
			if native.calls != 1 || journal.admits != 1 || journal.saves != 1 || store.admits != 1 {
				t.Fatal("read renewed effect")
			}
		})
	}
}
func TestChatComputerMutationInvalidOrOversizeStopsBeforeIntent(t *testing.T) {
	for _, input := range []mutationct.Operation{nil, mutationct.Write{RelativePath: "../escape", Content: "no"}, mutationct.Write{RelativePath: "note.md", Content: strings.Repeat("x", 512*1024)}, mutationct.Edit{RelativePath: "note.md", ExpectedSHA256: "bad"}} {
		f := newChatComputerFixture(t)
		h := f.start(t, "invalid-chat", chatComputerInput(true))
		ingress, store, _, _ := f.writableComputer(t)
		deps, journal, native := chatMutationDependencies()
		if _, err := ingress.mutateConversationOnRoute(context.Background(), h.handle, chatMutationContext(t, h), "invalid-write", "call", "work", input, deps, nil); err == nil {
			t.Fatal("invalid input allowed")
		}
		if f.count("request-computer") != 0 || store.admits != 0 || journal.admits != 0 || native.calls != 0 {
			t.Fatal("invalid input made durable intent")
		}
	}
}
func TestChatComputerMutationNeedsInitialWriteApproval(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "no-write-chat", chatComputerInput(true))
	ingress, store, _, _ := f.computer(t)
	deps, journal, native := chatMutationDependencies()
	if _, err := ingress.mutateConversationOnRoute(context.Background(), h.handle, chatMutationContext(t, h), "not-approved", "call", "work", mutationct.Write{RelativePath: "note.md", Content: "no"}, deps, nil); err == nil {
		t.Fatal("read approval became write permission")
	}
	if store.admits != 0 || journal.admits != 0 || native.calls != 0 {
		t.Fatal("unapproved write touched Computer")
	}
}
