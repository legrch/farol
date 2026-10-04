// Command chat-responses is a controlled test peer, never an application entry.
// It composes real Go Chat policy/streaming and Root/common framing. Physical
// browser and durable storage are explicit in-memory doubles. No Electron,
// provider, workspace, native runtime or installed identity is opened.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/legrch/farol/boot"
	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/results"
	"github.com/legrch/farol/transport/desktop"
)

const fixtureBuild = "chat-responses-cpu"

type methodCount struct {
	Attempts int `json:"attempts"`
	Known    int `json:"known"`
}
type receipt struct {
	Classification       string                 `json:"classification"`
	Scenario             string                 `json:"scenario"`
	Methods              map[string]methodCount `json:"methods"`
	Commits              map[string]int         `json:"commits"`
	PhysicalSendAttempts int                    `json:"physicalSendAttempts"`
	AcceptedSubmissions  int                    `json:"acceptedSubmissions"`
	Observations         int                    `json:"observations"`
	ServerEOF            bool                   `json:"serverEOF"`
}
type state struct {
	mu       sync.Mutex
	receipt  receipt
	revision uint64
}

func newState(scenario string) *state {
	return &state{receipt: receipt{Classification: "controlled-go-chat-cpu-peer", Scenario: scenario, Methods: map[string]methodCount{}, Commits: map[string]int{}}}
}
func (s *state) snapshot() receipt {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.receipt
	r.Methods = map[string]methodCount{}
	r.Commits = map[string]int{}
	for k, v := range s.receipt.Methods {
		r.Methods[k] = v
	}
	for k, v := range s.receipt.Commits {
		r.Commits[k] = v
	}
	return r
}
func (s *state) OpenFresh(_ context.Context, scope port.JournalScope) (*port.JournalHead, error) {
	return &port.JournalHead{Scope: scope}, nil
}
func (s *state) Commit(ctx context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if w.PreviousRevision != s.revision {
		return nil, errors.New("fixture_revision_conflict")
	}
	s.revision = w.Revision
	s.receipt.Commits[w.Entry.Kind]++
	return &port.JournalReceipt{Write: w}, nil
}

type clock struct{}

func (clock) NowMillis() uint64 { return uint64(time.Now().UnixMilli()) }
func (s *state) Exchange(ctx context.Context, c browser.Command) (browser.Reply, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	switch r := c.(type) {
	case browser.PrepareCommand:
		mode, cid := "home", ""
		if r.Target.Mode == "owned-saved" {
			mode, cid = "bound", r.Target.ConversationID
		}
		return browser.PreparedReply{Readiness: "ready", Saved: mode == "bound", Binding: browser.Binding{ProviderState: mode, Lease: r.Lease, ViewID: fmt.Sprintf("view-%d", r.Lease.SlotOrdinal), ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration, ConversationID: cid}}, nil
	case browser.VerifySendCommand:
		fact := func(v string) browser.ControlFact {
			return browser.ControlFact{Value: v, Literal: v, Source: "public-control"}
		}
		connector := browser.ControlFact{Source: "unknown"}
		if r.Requested.ToolsEnabled {
			connector = fact(r.Requested.ConnectorID)
		}
		return browser.VerifiedReply{Verification: browser.Verification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, Observed: browser.SelectionFacts{Model: fact(r.Requested.ModelID), Effort: fact(r.Requested.Effort), Mode: fact(r.Requested.Mode), Connector: connector, ObservedAtMillis: clock{}.NowMillis()}, IntentDigest: r.IntentDigest, EvidenceID: "proof-" + r.Binding.Lease.Identity.OperationID, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID}}, nil
	case browser.SendCommand:
		s.mu.Lock()
		s.receipt.PhysicalSendAttempts++
		s.receipt.AcceptedSubmissions++
		lost := s.receipt.Scenario == "lost-send-reply"
		s.mu.Unlock()
		if lost {
			return nil, errors.New("fixture_reply_lost_after_accepted_send")
		}
		return browser.SentReply{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: "submitted"}, nil
	case browser.ObserveCommand:
		s.mu.Lock()
		s.receipt.Observations++
		waitForTool := s.receipt.Scenario == "tool" && s.receipt.Commits["resolve-computer"] == 0
		s.mu.Unlock()
		e := browser.Observation{Binding: r.Binding, Sequence: r.AfterSequence + 1, ObservedAtMillis: clock{}.NowMillis(), UserTurnID: "user-" + r.Binding.Lease.Identity.TurnID, ReplyID: "reply-" + r.Binding.Lease.Identity.TurnID}
		switch r.AfterSequence {
		case 0:
			e.Kind = "accepted"
			if r.Binding.ProviderState == "home" {
				e.ProviderConversationID = "conversation-" + r.Binding.Lease.Identity.TaskID
			}
		case 1:
			e.Kind, e.SegmentID, e.Text = "answer-delta", "prefix", "Useful before tool. "
		case 2:
			if waitForTool {
				return browser.ObservedReply{}, nil
			}
			e.Kind, e.SegmentID, e.Text = "answer-delta", "suffix", "Continued after tool."
		case 3:
			e.Kind = "completed"
		case 4:
			e.Kind = "quiescent"
		default:
			return browser.ObservedReply{}, nil
		}
		return browser.ObservedReply{Events: []browser.Observation{e}}, nil
	default:
		return nil, errors.New("fixture_command_unsupported")
	}
}
func compose(ctx context.Context, scenario string) (*desktop.Server, *state, error) {
	if scenario != "tool" && scenario != "text" && scenario != "lost-send-reply" {
		return nil, nil, errors.New("fixture_scenario_invalid")
	}
	s := newState(scenario)
	scope := port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}
	adapter, err := browser.New(ctx, browser.Scope{ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration}, s, clock{})
	if err != nil {
		return nil, nil, err
	}
	retained, err := results.NewMemory(ctx, scope, results.TextLimits())
	if err != nil {
		return nil, nil, err
	}
	owner, err := lifecycle.New(ctx, scope, lifecycle.Dependencies{Gate: gate.New(), Journal: s, Browser: adapter, Results: retained, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		return nil, nil, err
	}
	ingress, err := boot.NewChatIngress(conversation.New(owner), wire.Context{ProfileId: scope.ProfileID, BackendGeneration: scope.BackendGeneration}, "owner")
	if err != nil {
		return nil, nil, err
	}
	methods := ingress.Methods()
	for name, method := range methods {
		original := method.Handle
		method.Handle = func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			s.mu.Lock()
			count := s.receipt.Methods[name]
			count.Attempts++
			s.receipt.Methods[name] = count
			s.mu.Unlock()
			out, err := original(ctx, r)
			if err == nil && out != nil && out.Status == "ok" {
				s.mu.Lock()
				count := s.receipt.Methods[name]
				count.Known++
				s.receipt.Methods[name] = count
				s.mu.Unlock()
			}
			return out, err
		}
		methods[name] = method
	}
	server, err := desktop.New(desktop.Config{BuildID: fixtureBuild, ProfileID: scope.ProfileID, Generation: scope.BackendGeneration, Methods: methods})
	return server, s, err
}
func run(args []string, in io.ReadCloser, out io.WriteCloser, diagnostic io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(diagnostic, "fixture_requires_one_scenario")
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	server, state, err := compose(ctx, args[0])
	if err != nil {
		fmt.Fprintln(diagnostic, "fixture_composition_failed")
		return 2
	}
	err = server.Serve(ctx, in, out)
	state.mu.Lock()
	state.receipt.ServerEOF = err == nil
	state.mu.Unlock()
	raw, encodeErr := json.Marshal(state.snapshot())
	if encodeErr != nil {
		return 2
	}
	fmt.Fprintf(diagnostic, "FAROL_CHAT_RESPONSES_CPU %s\n", raw)
	if err != nil {
		fmt.Fprintln(diagnostic, "fixture_server_failed")
		return 1
	}
	return 0
}
func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }
