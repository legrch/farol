package access

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	check "github.com/legrch/farol/modules/computer/domain/connector"
)

// predecessorAccepts is a faithful copy of how the retained predecessor image
// (0.5.24, main 9de07bcf) opens the connection-check journal while it opens the
// Computer Store. Sources at that commit:
//   - modules/computer/infra/repos/access/checkstore.go restoreConnectionChecks
//   - modules/computer/infra/repos/access/checkdisk.go decodeConnectionChecks and
//     readConnectionChecks (0600 regular file, 1..128 KiB)
//   - modules/computer/domain/connector/check.go Journal.Valid: at most 48
//     entries, unique IDs, every entry valid, and at most ONE entry that is not
//     Terminal (verified or refused_before_send), so outcome_unknown counts.
//
// Any refusal here fails the predecessor's whole Store constructor, so the
// rolled-back app cannot open the Computer Store at all.
func predecessorAccepts(root string, b Binding) error {
	const (
		name       = "computer-connection-check.json"
		witness    = "computer-connection-check.present"
		maxBytes   = 128 * 1024
		maxEntries = 48
	)
	marked := false
	if raw, err := os.ReadFile(filepath.Join(root, witness)); err == nil {
		if string(raw) != "C\n" {
			return errors.New("malformed witness")
		}
		marked = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	info, err := os.Lstat(filepath.Join(root, name))
	if !marked && errors.Is(err, os.ErrNotExist) {
		return nil // empty journal
	}
	if !marked || err != nil {
		return errors.New("witness and journal disagree")
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() < 1 || info.Size() > maxBytes {
		return errors.New("journal file refused")
	}
	raw, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		return err
	}
	var doc struct {
		Schema     int           `json:"schema"`
		ProfileID  string        `json:"profileId"`
		OwnerID    string        `json:"ownerId"`
		ComputerID string        `json:"computerId"`
		Entries    []check.Entry `json:"entries"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&doc) != nil || doc.Schema != 1 || doc.ProfileID != b.ProfileID ||
		doc.OwnerID != b.OwnerID || doc.ComputerID != b.ComputerID {
		return errors.New("schema or binding refused")
	}
	if doc.Entries == nil || len(doc.Entries) > maxEntries {
		return errors.New("entry count refused")
	}
	seen, nonTerminal := map[string]bool{}, 0
	for _, e := range doc.Entries {
		// Entry.Valid is unchanged since 9de07bcf.
		if !e.Valid() || seen[e.Request.OperationID] {
			return errors.New("entry refused")
		}
		seen[e.Request.OperationID] = true
		if e.Phase != check.Verified && e.Phase != check.RefusedBeforeSend {
			nonTerminal++
		}
	}
	if nonTerminal > 1 {
		return errors.New("more than one non-terminal entry")
	}
	canonical, err := json.Marshal(doc)
	if err != nil || !bytes.Equal(append(canonical, '\n'), raw) {
		return errors.New("noncanonical bytes")
	}
	return nil
}

// supersedeAfterIntent claims n, prepares a status check and publishes its
// dispatch intent; the next claim settles it as outcome_unknown.
func supersedeAfterIntent(t *testing.T, s *Store, n int) {
	t.Helper()
	ctx := context.Background()
	req := checkRequest(n)
	if _, first, err := s.ClaimConnectionCheck(ctx, req); err != nil || !first {
		t.Fatal("claim", n, err)
	}
	if _, _, err := s.PrepareConnectionCheck(ctx, req.OperationID, checkScope(check.Status)); err != nil {
		t.Fatal("prepare", n, err)
	}
	if _, permit, err := s.AdvanceConnectionCheck(ctx, req.OperationID, check.DispatchIntent, nil); err != nil || !permit {
		t.Fatal("intent", n, err)
	}
}

// Finding 1: several retained unknown outcomes must not stop a rollback to the
// predecessor from opening the Store.
func TestConnectionCheckUnknownHistoryKeepsPredecessorStoreOpenable(t *testing.T) {
	f := checkFixture(t)
	for n := 1; n <= 3; n++ {
		supersedeAfterIntent(t, f.store, n)
	}
	if _, first, err := f.store.ClaimConnectionCheck(context.Background(), checkRequest(4)); err != nil || !first {
		t.Fatal("fourth claim", err)
	}
	for n := 1; n <= 3; n++ {
		e, ok, err := f.store.CheckStatus(context.Background(), checkRequest(n).OperationID)
		if err != nil || !ok || e.Phase != check.OutcomeUnknown {
			t.Fatal("superseded attempt not retained as unknown", n, e.Phase, err)
		}
	}
	if err := predecessorAccepts(f.root, testBinding); err != nil {
		t.Fatal("0.5.24 would refuse to open the Store:", err)
	}
}

// Finding 2: history is never forgotten. More than the predecessor's 48
// attempts are retained across restart, a replay of the very first operation
// ID is an observation (never a fresh run), and unknown outcomes survive.
func TestConnectionCheckHistoryRetainsEveryAttemptAcrossRestart(t *testing.T) {
	f := checkFixture(t)
	ctx := context.Background()
	const total = 60
	for n := 1; n <= total; n++ {
		supersedeAfterIntent(t, f.store, n)
	}
	s := restored(t, f)
	for n := 1; n < total; n++ {
		e, ok, err := s.CheckStatus(ctx, checkRequest(n).OperationID)
		if err != nil || !ok || e.Phase != check.OutcomeUnknown {
			t.Fatal("attempt forgotten or rewritten", n, ok, e.Phase, err)
		}
	}
	replayed, first, err := s.ClaimConnectionCheck(ctx, checkRequest(1))
	if err != nil || first || replayed.Phase != check.OutcomeUnknown {
		t.Fatal("replayed first operation ID was admitted as fresh", first, replayed.Phase, err)
	}
	if _, _, err := s.AdvanceConnectionCheck(ctx, checkRequest(1).OperationID, check.DispatchIntent, nil); err == nil {
		t.Fatal("replayed unknown attempt obtained a dispatch right")
	}
	if err := predecessorAccepts(f.root, testBinding); err != nil {
		t.Fatal("0.5.24 would refuse to open the Store:", err)
	}
}

// writePredecessorJournal publishes a schema-1 journal through the same disk
// path the predecessor uses, as 0.5.24 would leave it.
func writePredecessorJournal(t *testing.T, s *Store, entries ...check.Entry) []byte {
	t.Helper()
	raw, err := encodeConnectionChecks(testBinding, check.Journal{Entries: entries})
	if err != nil {
		t.Fatal(err)
	}
	marked, err := s.disk.connectionCheckWitness(legacyCheckFile)
	if err != nil {
		t.Fatal(err)
	}
	if !marked {
		if err = s.disk.markConnectionCheckWitness(legacyCheckFile); err != nil {
			t.Fatal(err)
		}
		err = s.disk.beginConnectionChecks(legacyCheckFile, raw)
	} else {
		var current []byte
		if current, err = s.disk.readConnectionChecks(legacyCheckFile); err == nil {
			err = s.disk.updateConnectionChecks(legacyCheckFile, raw, digest(current))
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func verifiedEntry(n int) check.Entry {
	s := checkScope(check.Status)
	s.CheckID = checkRequest(1000 + n).OperationID
	s.PromptDigest = checkHash(check.Prompt(s))
	return check.Entry{Request: checkRequest(n), Phase: check.Verified, Scope: &s,
		Receipt: &check.Receipt{CheckID: s.CheckID, Kind: "status", Digest: checkHash("receipt")}}
}
func intentEntry(n int) check.Entry {
	e := verifiedEntry(n)
	e.Phase, e.Receipt = check.DispatchIntent, nil
	return e
}
func legacyBytes(t *testing.T, f stateFixture) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.root, connectionCheckName))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func phaseOf(t *testing.T, s *Store, n int) check.Phase {
	t.Helper()
	e, ok, err := s.CheckStatus(context.Background(), checkRequest(n).OperationID)
	if err != nil || !ok {
		t.Fatal("attempt missing", n, err)
	}
	return e.Phase
}

// An upgrade from 0.5.24 reads its journal, absorbs it into the full history
// on the first write and never writes it again, so a rollback still opens.
func TestConnectionCheckUpgradeAbsorbsPredecessorJournalWithoutWritingIt(t *testing.T) {
	f := checkFixture(t)
	before := writePredecessorJournal(t, f.store, verifiedEntry(1), intentEntry(2))
	f.store = restored(t, f)
	if phaseOf(t, f.store, 1) != check.Verified || phaseOf(t, f.store, 2) != check.DispatchIntent {
		t.Fatal("predecessor attempts not visible after upgrade")
	}
	if _, permit, err := f.store.AdvanceConnectionCheck(context.Background(), checkRequest(2).OperationID, check.DispatchIntent, nil); err == nil || permit {
		t.Fatal("predecessor intent obtained a dispatch right")
	}
	for n := 3; n <= 5; n++ {
		supersedeAfterIntent(t, f.store, n)
	}
	f.store = restored(t, f)
	if phaseOf(t, f.store, 1) != check.Verified || phaseOf(t, f.store, 2) != check.OutcomeUnknown ||
		phaseOf(t, f.store, 3) != check.OutcomeUnknown || phaseOf(t, f.store, 4) != check.OutcomeUnknown {
		t.Fatal("history lost or rewrote an attempt")
	}
	if !bytes.Equal(before, legacyBytes(t, f)) {
		t.Fatal("the predecessor journal was written")
	}
	if err := predecessorAccepts(f.root, testBinding); err != nil {
		t.Fatal("0.5.24 would refuse to open the Store:", err)
	}
}

// A rollback that ran checks, then a roll-forward: the predecessor's own new
// attempts are imported and kept; nothing either build recorded is lost.
func TestConnectionCheckRollForwardImportsPredecessorAttempts(t *testing.T) {
	f := checkFixture(t)
	writePredecessorJournal(t, f.store, verifiedEntry(1))
	f.store = restored(t, f)
	supersedeAfterIntent(t, f.store, 2)
	supersedeAfterIntent(t, f.store, 3)
	// Rolled back: the predecessor sees only its own journal and appends.
	writePredecessorJournal(t, f.store, verifiedEntry(1), verifiedEntry(4), intentEntry(5))
	f.store = restored(t, f)
	want := map[int]check.Phase{1: check.Verified, 2: check.OutcomeUnknown, 3: check.DispatchIntent, 4: check.Verified, 5: check.OutcomeUnknown}
	for n, phase := range want {
		if got := phaseOf(t, f.store, n); got != phase {
			t.Fatal("after roll-forward", n, got, "want", phase)
		}
	}
	if _, first, err := f.store.ClaimConnectionCheck(context.Background(), checkRequest(5)); err != nil || first {
		t.Fatal("imported predecessor attempt became fresh", err)
	}
	// The next write persists the import; a later restart is unchanged.
	if _, first, err := f.store.ClaimConnectionCheck(context.Background(), checkRequest(6)); err != nil || !first {
		t.Fatal(err)
	}
	f.store = restored(t, f)
	want[3], want[6] = check.OutcomeUnknown, check.Claimed
	for n, phase := range want {
		if got := phaseOf(t, f.store, n); got != phase {
			t.Fatal("after persisting the import", n, got, "want", phase)
		}
	}
	if err := predecessorAccepts(f.root, testBinding); err != nil {
		t.Fatal("0.5.24 would refuse to open the Store:", err)
	}
}

// The two journals never disagree silently: a different attempt under a known
// ID, or a predecessor journal changed during this lifetime, fails closed.
func TestConnectionCheckPredecessorConflictFailsClosed(t *testing.T) {
	t.Run("same-id-different-attempt", func(t *testing.T) {
		f := checkFixture(t)
		supersedeAfterIntent(t, f.store, 1)
		history, err := f.store.disk.readConnectionChecks(historyCheckFile)
		if err != nil {
			t.Fatal(err)
		}
		writePredecessorJournal(t, f.store, verifiedEntry(1))
		if err := f.store.Close(); err != nil {
			t.Fatal(err)
		}
		if s, err := Open(f.root, testBinding, f.clock); err == nil {
			s.Close()
			t.Fatal("conflicting predecessor attempt was merged")
		}
		after, err := os.ReadFile(filepath.Join(f.root, historyCheckFile.name))
		if err != nil || !bytes.Equal(after, history) {
			t.Fatal("refused open changed the history", err)
		}
	})
	t.Run("changed-during-lifetime", func(t *testing.T) {
		f := checkFixture(t)
		writePredecessorJournal(t, f.store, verifiedEntry(1))
		if _, _, err := f.store.CheckStatus(context.Background(), checkRequest(1).OperationID); err == nil {
			t.Fatal("a predecessor journal written behind the owner was accepted")
		}
	})
}
