package task

import (
	"errors"
	"strconv"
	"testing"
)

func executionEvent(n uint64) ExecutionEvent {
	return ExecutionEvent{RunID: "run", DispatchID: "dispatch", EventID: strconv.FormatUint(n, 10), StreamID: "selected-stream", Generation: 1, SourceSequence: n, TimestampMillis: 100, Kind: ToolStarted, Source: RuntimeEvidence, Reference: Reference{ThreadID: "thread", TurnID: "turn"}, ItemID: "item"}
}
func TestBoundedEventTailDedupGapAndIndependentPage(t *testing.T) {
	var log EventLog
	for n := uint64(1); n <= 70; n++ {
		var err error
		log, err = log.Append(executionEvent(n), Codex)
		if err != nil {
			t.Fatal(err)
		}
	}
	if !log.Valid("run", "dispatch", Codex, executionEvent(1).Reference) || len(log.Events) != 64 {
		t.Fatal("invalid bounded log")
	}
	page, err := log.Page(EventCursor{}, 2)
	if err != nil || !page.Gap || !page.More || page.Events[0].Sequence != 7 {
		t.Fatal(page, err)
	}
	page.Events[0].ItemID = "mutated"
	if log.Events[0].ItemID == "mutated" {
		t.Fatal("page aliases retained events")
	}
	duplicate := executionEvent(70)
	duplicate.SourceSequence = 71
	duplicate.TimestampMillis++
	again, err := log.Append(duplicate, Codex)
	if err != nil || again.LastSequence != 70 || again.LastSource != 71 || again.SourceGap {
		t.Fatal(again, err)
	}
	duplicate.ExitCode = 7
	if _, err := log.Append(duplicate, Codex); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	conflict := executionEvent(70)
	conflict.ItemID = "different"
	if _, err := log.Append(conflict, Codex); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	replay := executionEvent(1)
	if _, err := log.Append(replay, Codex); !errors.Is(err, ErrState) {
		t.Fatal("pruned replay appended", err)
	}
	gap := executionEvent(72)
	next, err := log.Append(gap, Codex)
	if err != nil || !next.SourceGap {
		t.Fatal(next, err)
	}
	generation := executionEvent(1)
	generation.Generation = 2
	next, err = next.Append(generation, Codex)
	if err != nil || !next.SourceGap || !next.Valid("run", "dispatch", Codex, generation.Reference) {
		t.Fatal(next, err)
	}
	page, err = next.Page(EventCursor{StreamID: "selected-stream", Generation: 1, Sequence: 70}, 2)
	if err != nil || !page.Gap || len(page.Events) != 0 {
		t.Fatal(page, err)
	}
}
func TestEventFactsCannotUpgradeClaimsOrCrossRuns(t *testing.T) {
	for _, mutate := range []func(*ExecutionEvent){func(e *ExecutionEvent) { e.Source = ToolReceiptEvidence }, func(e *ExecutionEvent) { e.TimestampMillis = 0 }, func(e *ExecutionEvent) { e.Kind = "tests_passed" }, func(e *ExecutionEvent) { e.Reference.TurnID = "" }, func(e *ExecutionEvent) { e.CompletedSteps = 1 }, func(e *ExecutionEvent) { e.Sequence = 1 }} {
		e := executionEvent(1)
		mutate(&e)
		if _, err := (EventLog{}).Append(e, Codex); !errors.Is(err, ErrInvalid) {
			t.Fatal(e, err)
		}
	}
	log, _ := (EventLog{}).Append(executionEvent(1), Codex)
	e := executionEvent(2)
	e.RunID = "other"
	if _, err := log.Append(e, Codex); !errors.Is(err, ErrIdentity) {
		t.Fatal("cross-run append", err)
	}
	if _, err := log.Page(EventCursor{}, 33); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func TestStaleStreamCursorReportsGapEvenAfterSequenceReset(t *testing.T) {
	log, _ := (EventLog{}).Append(executionEvent(1), Codex)
	page, err := log.Page(EventCursor{StreamID: "old-stream", Generation: 8, Sequence: 99}, 2)
	if err != nil || !page.Gap || len(page.Events) != 0 || page.Next.Sequence != 1 {
		t.Fatal(page, err)
	}
	if _, err := log.Page(EventCursor{StreamID: log.StreamID, Generation: log.Generation, Sequence: 99}, 2); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}
