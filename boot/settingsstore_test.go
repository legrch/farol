package boot

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
)

// In-memory reciprocal transport and canonical mapping only. Host storage,
// process termination and native application activation have separate witnesses.
func settingsStoreExchangeFixture(t *testing.T) (*SettingsStoreExchange, context.CancelFunc, delivery.Snapshot, delivery.Pending) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	s, err := NewSettingsStoreExchange(ctx, wire.Context{ProfileId: "00000000-0000-4000-8000-000000000001", BackendGeneration: "backend"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := delivery.Snapshot{Revision: 12, Current: delivery.Identity{ProfileID: s.peer.ProfileId, OwnerID: "owner", ComputerID: "00000000-0000-4000-8000-000000000002", Generation: 10}}
	pending := delivery.Pending{Backend: "go-owner-v2", OperationID: "00000000-0000-4000-8000-000000000003", ProfileID: s.peer.ProfileId, WorkspaceID: "00000000-0000-4000-8000-000000000004", RelativePath: "note.txt", ComputerGeneration: 7, BeforeSHA256: strings.Repeat("a", 64), SubmittedAt: "2026-10-04T22:00:00.123456789Z"}
	return s, cancel, snapshot, pending
}
func nextSettingsStoreCall(t *testing.T, s *SettingsStoreExchange) *wire.SettingsStoreCommand {
	t.Helper()
	c, err := s.next(context.Background(), uint64(time.Now().Add(3*time.Second).UnixMilli()))
	if err != nil || c == nil {
		t.Fatalf("missing command: %v", err)
	}
	return c
}
func finishSettingsStoreCall(t *testing.T, s *SettingsStoreExchange, c *wire.SettingsStoreCommand, value any) error {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return s.complete(wire.SettingsStoreReply{CommandId: c.CommandId, Kind: c.Kind, Body: raw})
}

type settingsSaveOutcome struct {
	value delivery.SaveResult
	err   error
}

func startSettingsSave(s *SettingsStoreExchange, ctx context.Context, change delivery.Change) <-chan settingsSaveOutcome {
	done := make(chan settingsSaveOutcome, 1)
	go func() { v, err := s.CompareAndSet(ctx, change); done <- settingsSaveOutcome{v, err} }()
	return done
}
func awaitSettingsSave(t *testing.T, done <-chan settingsSaveOutcome) settingsSaveOutcome {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(3 * time.Second):
		t.Fatal("call retained after terminal outcome")
		return settingsSaveOutcome{}
	}
}

func TestSettingsStoreExchangeExactConditionalRoundTrip(t *testing.T) {
	s, _, before, pending := settingsStoreExchangeFixture(t)
	before.Pending = &pending
	done := startSettingsSave(s, context.Background(), delivery.Change{Expected: before, Next: nil, InvalidateVerification: true})
	call := nextSettingsStoreCall(t, s)
	var command wire.SettingsStoreReplace
	if call.Kind != "replace" || wire.Validate("SettingsStoreReplace", call.Body) != nil || json.Unmarshal(call.Body, &command) != nil {
		t.Fatal("bad canonical command")
	}
	if command.Change.Expected.Pending.ComputerGeneration != "7" || command.Change.Expected.Current.Generation != "10" || command.Change.Next != nil || !command.Change.InvalidateVerification {
		t.Fatal("lost original pending or one-way request")
	}
	after := before
	after.Revision++
	after.Pending = nil
	after.VerificationInvalidated = true
	snapshot := settingsSnapshotToWire(after)
	if err := finishSettingsStoreCall(t, s, call, wire.SettingsStoreReplaceResult{Status: "committed", Snapshot: &snapshot}); err != nil {
		t.Fatal(err)
	}
	result := awaitSettingsSave(t, done)
	if result.err != nil || result.value.Publication != delivery.Committed || !reflect.DeepEqual(result.value.Readback, &after) {
		t.Fatalf("bad exact readback: %+v", result)
	}
	if finishSettingsStoreCall(t, s, call, wire.SettingsStoreReplaceResult{Status: "committed", Snapshot: &snapshot}) == nil || len(s.ready) != 0 {
		t.Fatal("completion replayed")
	}
	if err := s.QuiescePolling(); err != nil {
		t.Fatal(err)
	}
}

func TestSettingsStoreExchangeReadKeepsPendingAndExactNanoseconds(t *testing.T) {
	s, _, before, pending := settingsStoreExchangeFixture(t)
	before.Pending = &pending
	type read struct {
		value delivery.Snapshot
		err   error
	}
	done := make(chan read, 1)
	go func() { value, err := s.Load(context.Background()); done <- read{value, err} }()
	call := nextSettingsStoreCall(t, s)
	snapshot := settingsSnapshotToWire(before)
	if call.Kind != "read" || wire.Validate("SettingsStoreRead", call.Body) != nil {
		t.Fatal("wrong read command")
	}
	if err := finishSettingsStoreCall(t, s, call, wire.SettingsStoreReadResult{Status: "ok", Snapshot: &snapshot}); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got.err != nil || !reflect.DeepEqual(got.value, before) {
			t.Fatalf("lossy read: %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("read did not finish")
	}
}

func TestSettingsStoreExchangeNeverCorrectsMalformedCompletion(t *testing.T) {
	for _, variant := range []string{"kind", "missing-readback", "contradictory-refusal", "crossed-profile", "large-generation", "duplicate-json"} {
		t.Run(variant, func(t *testing.T) {
			s, _, before, pending := settingsStoreExchangeFixture(t)
			done := startSettingsSave(s, context.Background(), delivery.Change{Expected: before, Next: &pending})
			call := nextSettingsStoreCall(t, s)
			snapshot := settingsSnapshotToWire(before)
			result := wire.SettingsStoreReplaceResult{Status: "committed", Snapshot: &snapshot}
			switch variant {
			case "missing-readback":
				result.Snapshot = nil
			case "contradictory-refusal":
				result.Status = "not_written"
			case "crossed-profile":
				snapshot.Current.ProfileId = "foreign"
			case "large-generation":
				snapshot.Current.Generation = "9007199254740992"
			}
			raw, _ := json.Marshal(result)
			reply := wire.SettingsStoreReply{CommandId: call.CommandId, Kind: call.Kind, Body: raw}
			if variant == "kind" {
				reply.Kind = "read"
			}
			if variant == "duplicate-json" {
				reply.Body = json.RawMessage(`{"status":"not_written","status":"unknown"}`)
			}
			if s.complete(reply) == nil {
				t.Fatal("invalid reply accepted")
			}
			out := awaitSettingsSave(t, done)
			if out.err == nil || out.value.Publication != delivery.PublicationUnknown {
				t.Fatal("invalid reply became known")
			}
			if finishSettingsStoreCall(t, s, call, wire.SettingsStoreReplaceResult{Status: "not_written"}) == nil {
				t.Fatal("corrected same completion")
			}
			if _, err := s.Load(context.Background()); err == nil || s.QuiescePolling() == nil || len(s.ready) != 0 {
				t.Fatal("unknown lifetime reused")
			}
		})
	}
}

func TestSettingsStoreExchangeRefusalAndUnknownRemainDistinct(t *testing.T) {
	for _, status := range []string{"not_written", "unknown"} {
		t.Run(status, func(t *testing.T) {
			s, _, before, pending := settingsStoreExchangeFixture(t)
			done := startSettingsSave(s, context.Background(), delivery.Change{Expected: before, Next: &pending})
			call := nextSettingsStoreCall(t, s)
			if err := finishSettingsStoreCall(t, s, call, wire.SettingsStoreReplaceResult{Status: status}); err != nil {
				t.Fatal(err)
			}
			result := awaitSettingsSave(t, done)
			wanted := delivery.NotWritten
			if status == "unknown" {
				wanted = delivery.PublicationUnknown
			}
			if result.err != nil || result.value.Publication != wanted || result.value.Readback != nil {
				t.Fatal("wrong publication classification")
			}
			if (s.QuiescePolling() != nil) != (status == "unknown") {
				t.Fatal("unknown permitted retirement or refusal poisoned transport")
			}
		})
	}
}

func TestSettingsStoreExchangeLostReplyFencesLateReadback(t *testing.T) {
	for _, terminate := range []string{"caller", "root"} {
		t.Run(terminate, func(t *testing.T) {
			s, closeRoot, before, pending := settingsStoreExchangeFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := startSettingsSave(s, ctx, delivery.Change{Expected: before, Next: &pending})
			call := nextSettingsStoreCall(t, s)
			if s.QuiescePolling() == nil {
				t.Fatal("retired pending store call")
			}
			if terminate == "caller" {
				cancel()
			} else {
				closeRoot()
			}
			if out := awaitSettingsSave(t, done); out.err == nil || out.value.Publication != delivery.PublicationUnknown {
				t.Fatal("lost reply not unknown")
			}
			snapshot := settingsSnapshotToWire(before)
			if finishSettingsStoreCall(t, s, call, wire.SettingsStoreReplaceResult{Status: "committed", Snapshot: &snapshot}) == nil {
				t.Fatal("late visible bytes upgraded unknown")
			}
			if _, err := s.Load(context.Background()); err == nil || len(s.ready) != 0 {
				t.Fatal("retry after lost reply")
			}
		})
	}
}

func TestSettingsStoreExchangeBoundsAndOriginalDeadline(t *testing.T) {
	s, _, before, pending := settingsStoreExchangeFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	done := startSettingsSave(s, ctx, delivery.Change{Expected: before, Next: &pending})
	call := nextSettingsStoreCall(t, s)
	var body wire.SettingsStoreReplace
	_ = json.Unmarshal(call.Body, &body)
	if wireUint(body.DeadlineMillis) != uint64(deadline.UnixMilli()) {
		t.Fatal("extended original deadline")
	}
	if _, err := s.Load(context.Background()); err == nil {
		t.Fatal("admitted concurrent call")
	}
	if err := finishSettingsStoreCall(t, s, call, wire.SettingsStoreReplaceResult{Status: "not_written"}); err != nil {
		t.Fatal(err)
	}
	if out := awaitSettingsSave(t, done); out.err != nil {
		t.Fatal(out.err)
	}
	s.issued = 4096
	if _, err := s.Load(context.Background()); err == nil || len(s.ready) != 0 {
		t.Fatal("unbounded retention")
	}
	for _, deadline := range []uint64{0, ^uint64(0), uint64(time.Now().Add(time.Minute).UnixMilli())} {
		if _, err := s.next(context.Background(), deadline); err == nil {
			t.Fatal("unbounded poll deadline")
		}
	}
}

func TestSettingsStoreExchangeQuiescenceWakesPoll(t *testing.T) {
	s, _, _, _ := settingsStoreExchangeFixture(t)
	done := make(chan error, 1)
	go func() {
		command, err := s.next(context.Background(), uint64(time.Now().Add(10*time.Second).UnixMilli()))
		if command != nil {
			done <- errSettingsStoreExchange
		} else {
			done <- err
		}
	}()
	if err := s.QuiescePolling(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("poll retained after quiescence")
	}
	if _, err := s.Load(context.Background()); err == nil {
		t.Fatal("reopened quiesced transport")
	}
}

// Observing Done synchronizes with context.WithDeadline before next waits for
// the exchange lock. It changes no cancellation/deadline semantics.
type settingsPollContext struct {
	context.Context
	once    sync.Once
	waiting chan struct{}
}

func (c *settingsPollContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestSettingsStoreExchangeExpiredPollKeepsOriginalCommand(t *testing.T) {
	for _, variant := range []string{"deadline", "cancelled"} {
		t.Run(variant, func(t *testing.T) {
			// Repeat the competing-ready-channel case: the old select could
			// choose a command even when the poll was already cancelled.
			attempts := 32
			if variant == "deadline" {
				attempts = 4
			}
			for n := 0; n < attempts; n++ {
				s, _, before, pending := settingsStoreExchangeFixture(t)
				callCtx, cancelCall := context.WithTimeout(context.Background(), 3*time.Second)
				t.Cleanup(cancelCall)
				done := startSettingsSave(s, callCtx, delivery.Change{Expected: before, Next: &pending})
				for len(s.ready) == 0 {
					select {
					case <-callCtx.Done():
						t.Fatal("original command was not queued")
					case <-time.After(time.Millisecond):
					}
				}
				s.mu.Lock()
				original := s.pending
				pollCtx, cancelPoll := context.WithCancel(context.Background())
				observed := &settingsPollContext{Context: pollCtx, waiting: make(chan struct{})}
				until := time.Now().Add(time.Second)
				if variant == "deadline" {
					until = time.Now().Add(100 * time.Millisecond)
				}
				type pollResult struct {
					command *wire.SettingsStoreCommand
					err     error
				}
				polled := make(chan pollResult, 1)
				go func() {
					command, err := s.next(observed, uint64(until.UnixMilli()))
					polled <- pollResult{command, err}
				}()
				select {
				case <-observed.waiting:
				case result := <-polled:
					s.mu.Unlock()
					cancelPoll()
					t.Fatalf("poll did not reach exchange lock: %+v", result)
				case <-time.After(time.Second):
					s.mu.Unlock()
					cancelPoll()
					t.Fatal("poll did not start")
				}
				if variant == "deadline" {
					time.Sleep(time.Until(until) + time.Millisecond)
				} else {
					cancelPoll()
				}
				s.mu.Unlock()
				result := <-polled
				cancelPoll()
				if result.command != nil || (variant == "deadline" && result.err != nil) || (variant == "cancelled" && result.err == nil) {
					cancelCall()
					t.Fatalf("expired poll consumed original command: %+v", result)
				}
				// Only the subsequent valid poll may deliver this same original
				// command, with the original command ID, bytes and deadline.
				command := nextSettingsStoreCall(t, s)
				if command.CommandId != original.command.CommandId || string(command.Body) != string(original.command.Body) || s.issued != 1 {
					t.Fatal("expired poll replaced or renewed original command")
				}
				if err := finishSettingsStoreCall(t, s, command, wire.SettingsStoreReplaceResult{Status: "not_written"}); err != nil {
					t.Fatal(err)
				}
				if out := awaitSettingsSave(t, done); out.err != nil || out.value.Publication != delivery.NotWritten {
					t.Fatal("original result lost", out)
				}
				cancelCall()
				if err := s.QuiescePolling(); err != nil {
					t.Fatal("empty poll fenced exchange", err)
				}
			}
		})
	}
}

func TestSettingsStoreExchangeConcurrentPollsDeliverOnce(t *testing.T) {
	s, _, before, pending := settingsStoreExchangeFixture(t)
	type pollResult struct {
		command *wire.SettingsStoreCommand
		err     error
	}
	polled := make(chan pollResult, 8)
	for n := 0; n < cap(polled); n++ {
		go func() {
			command, err := s.next(context.Background(), uint64(time.Now().Add(3*time.Second).UnixMilli()))
			polled <- pollResult{command, err}
		}()
	}
	done := startSettingsSave(s, context.Background(), delivery.Change{Expected: before, Next: &pending})
	first := <-polled
	if first.err != nil || first.command == nil {
		t.Fatal("original command not delivered", first)
	}
	if err := finishSettingsStoreCall(t, s, first.command, wire.SettingsStoreReplaceResult{Status: "not_written"}); err != nil {
		t.Fatal(err)
	}
	if out := awaitSettingsSave(t, done); out.err != nil || out.value.Publication != delivery.NotWritten {
		t.Fatal("original result lost", out)
	}
	if err := s.QuiescePolling(); err != nil {
		t.Fatal(err)
	}
	for n := 1; n < cap(polled); n++ {
		select {
		case result := <-polled:
			if result.err != nil || result.command != nil {
				t.Fatal("original command delivered again", result)
			}
		case <-time.After(time.Second):
			t.Fatal("poll retained after quiescence")
		}
	}
}
