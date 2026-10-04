package boot

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Explicit synchronous port barrier: no threads/processes outside this test,
// native filesystem, clock sleeps or physical provider qualification.
type mutationBarrierNative struct {
	entered chan struct{}
	release chan struct{}
	effects atomic.Int32
}

func (n *mutationBarrierNative) Mutate(ctx context.Context, input computerport.MutationRequest) (*computerport.MutationReceipt, error) {
	close(n.entered)
	<-n.release
	if err := input.BeforePublish(ctx); err != nil {
		return nil, err
	}
	n.effects.Add(1)
	return (&chatMutationNative{}).Mutate(ctx, input)
}
func TestChatComputerMutationConcurrentInvokeAndObserverCannotTakeOwnership(t *testing.T) {
	for _, cancelOwner := range []bool{false, true} {
		t.Run(map[bool]string{false: "pending", true: "cancelled"}[cancelOwner], func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "concurrent-mutation", chatComputerInput(true))
			computer, store, _, _ := f.writableComputer(t)
			deps, journal, _ := chatMutationDependencies()
			native := &mutationBarrierNative{entered: make(chan struct{}), release: make(chan struct{})}
			deps.native = native
			relay, err := chatComputerMutationIngress(f.ingress, computer, deps)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			input := chatComputerWireInput(h)
			action := mutationct.Write{RelativePath: input.RelativePath, Content: "once"}
			type result struct {
				output *wire.ChatComputerOutput
				err    error
			}
			done := make(chan result, 1)
			go func() { output, e := relay.mutate(ctx, "original-write", input, action); done <- result{output, e} }()
			select {
			case <-native.entered:
			case <-time.After(time.Second):
				t.Fatal("controlled mutation did not enter")
			}
			// Always release this test's own goroutine, even on an assertion failure.
			released := false
			defer func() {
				if !released {
					close(native.release)
				}
			}()
			if _, err = relay.observeMutation(ctx, wire.ChatComputerMutationRead{HandleId: h.id, CallId: input.CallId}); err == nil {
				t.Fatal("pending observer acquired mutation owner")
			}
			if _, err = relay.mutate(ctx, "replacement-op", input, action); err == nil {
				t.Fatal("duplicate call admitted")
			}
			second := input
			second.CallId = "replacement-call"
			if _, err = relay.mutate(ctx, "replacement-key", second, action); err == nil {
				t.Fatal("pending call bypassed with new key")
			}
			if cancelOwner {
				if err = h.handle.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			}
			close(native.release)
			released = true
			var got result
			select {
			case got = <-done:
			case <-time.After(time.Second):
				t.Fatal("controlled mutation did not leave")
			}
			if cancelOwner {
				if got.err == nil || got.output != nil || native.effects.Load() != 0 {
					t.Fatal("cancelled owner published/received mutation", got.err)
				}
				if _, err = relay.observeMutation(ctx, wire.ChatComputerMutationRead{HandleId: h.id, CallId: input.CallId}); err == nil {
					t.Fatal("cancelled observer recovered authority")
				}
			} else if got.err != nil || got.output == nil || native.effects.Load() != 1 {
				t.Fatal("original mutation lost", got.err)
			}
			if journal.admits != 1 || journal.saves != 1 || store.admits != 1 || f.count("request-computer") != 1 || f.count("resolve-computer") != 0 || f.physical.sends != 1 {
				t.Fatal("concurrent path changed one-shot effects")
			}
		})
	}
}

type mutationReplyNative struct {
	change  func(*computerport.MutationReceipt)
	failure error
}

func (n mutationReplyNative) Mutate(ctx context.Context, input computerport.MutationRequest) (*computerport.MutationReceipt, error) {
	if n.failure != nil {
		return nil, n.failure
	}
	result, err := (&chatMutationNative{}).Mutate(ctx, input)
	if err == nil && n.change != nil {
		n.change(result)
	}
	return result, err
}
func TestChatComputerMutationCrossedNativeResultNeverMintsRelayReceipt(t *testing.T) {
	changes := map[string]func(*computerport.MutationReceipt){
		"path":         func(r *computerport.MutationReceipt) { r.RelativePath = "other.md" },
		"operation":    func(r *computerport.MutationReceipt) { r.Operation = "edit" },
		"preimage":     func(r *computerport.MutationReceipt) { v := strings.Repeat("c", 64); r.BeforeSHA256 = &v },
		"bytes":        func(r *computerport.MutationReceipt) { r.Bytes = 8*1024*1024 + 1 },
		"hash":         func(r *computerport.MutationReceipt) { r.AfterSHA256 = "bad" },
		"replacements": func(r *computerport.MutationReceipt) { r.Replacements = 1 },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "crossed-mutation", chatComputerInput(true))
			computer, store, _, _ := f.writableComputer(t)
			deps, journal, _ := chatMutationDependencies()
			deps.native = mutationReplyNative{change: change}
			relay, err := chatComputerMutationIngress(f.ingress, computer, deps)
			if err != nil {
				t.Fatal(err)
			}
			input := chatComputerWireInput(h)
			ctx := context.Background()
			if output, err := relay.mutate(ctx, "crossed-op", input, mutationct.Write{RelativePath: input.RelativePath, Content: "once"}); err == nil || output != nil {
				t.Fatal("crossed native receipt was returned")
			}
			observed, err := relay.observeMutation(ctx, wire.ChatComputerMutationRead{HandleId: h.id, CallId: input.CallId})
			if err != nil || observed.Result.Phase != "outcome_unknown" || observed.Result.Receipt != nil || observed.Result.Failure == nil {
				t.Fatal("crossed outcome lost", observed, err)
			}
			input.CallId = "another-key"
			if _, err = relay.mutate(ctx, "another-op", input, mutationct.Write{RelativePath: input.RelativePath, Content: "no"}); err == nil {
				t.Fatal("unknown result allowed next mutation")
			}
			if journal.admits != 1 || journal.saves != 1 || store.admits != 1 || f.count("resolve-computer") != 0 {
				t.Fatal("crossed result changed effects")
			}
		})
	}
}
func TestChatComputerMutationKnownRefusalIsSeparateFromUnknown(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "known-conflict", true: "unclassified"}[unknown], func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "failed-mutation", chatComputerInput(true))
			computer, _, _, _ := f.writableComputer(t)
			deps, journal, _ := chatMutationDependencies()
			var failure error = authority.Fail("WORKSPACE_MUTATION_CONFLICT", "native-workspace")
			if unknown {
				failure = errors.New("unclassified native failure")
			}
			deps.native = mutationReplyNative{failure: failure}
			relay, err := chatComputerMutationIngress(f.ingress, computer, deps)
			if err != nil {
				t.Fatal(err)
			}
			input := chatComputerWireInput(h)
			ctx := context.Background()
			output, err := relay.mutate(ctx, "failed-op", input, mutationct.Write{RelativePath: input.RelativePath, Content: "once"})
			if unknown {
				if err == nil || output != nil {
					t.Fatal("unknown became known refusal")
				}
			} else {
				if err != nil || output == nil {
					t.Fatal("known refusal lost exact return", err)
				}
				if err = relay.returned(ctx, output.Receipt); err != nil {
					t.Fatal(err)
				}
			}
			if journal.admits != 1 || journal.saves != 1 || f.physical.sends != 1 {
				t.Fatal("failure replayed")
			}
			if unknown && f.count("resolve-computer") != 0 || !unknown && f.count("resolve-computer") != 1 {
				t.Fatal("failure classification crossed settlement")
			}
		})
	}
}

func TestChatComputerMutationWireLostOrCrossedReturnKeepsOriginalChain(t *testing.T) {
	for _, reason := range []string{"lost-ack", "crossed-receipt", "cancelled-owner"} {
		t.Run(reason, func(t *testing.T) {
			f, h, store, journal, native, p := chatMutationWireFixture(t)
			input := chatMutationWireWrite(h, "original-call")
			output := chatMutationWireOutput(t, p.call("chat.computer.write", "original-op", chatComputerWireJSON(t, input)), "original-op", input.CallId)
			receipt := output.Receipt
			switch reason {
			case "lost-ack":
				f.journal.fail = "resolve-computer"
			case "crossed-receipt":
				receipt.OutputSHA256 = strings.Repeat("e", 64)
			case "cancelled-owner":
				if err := h.handle.Cancel(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			chatComputerWireNotOK(t, p.call("chat.computer.return", "return-attempt", chatComputerWireJSON(t, receipt)))
			if reason != "crossed-receipt" {
				chatComputerWireNotOK(t, p.call("chat.computer.return", "return-again", chatComputerWireJSON(t, output.Receipt)))
			}
			input.CallId = "fresh-call"
			chatComputerWireNotOK(t, p.call("chat.computer.write", "fresh-op", chatComputerWireJSON(t, input)))
			if native.calls != 1 || journal.admits != 1 || journal.saves != 1 || store.admits != 1 || f.physical.sends != 1 {
				t.Fatal("failed return replayed mutation/Send")
			}
			expected := 0
			if reason == "lost-ack" {
				expected = 1
			}
			if f.count("resolve-computer") != expected {
				t.Fatal("return ACK repeated or fabricated")
			}
		})
	}
}
