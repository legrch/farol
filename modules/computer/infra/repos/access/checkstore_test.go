package access

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	check "github.com/legrch/farol/modules/computer/domain/connector"
	"golang.org/x/sys/unix"
)

// Real protected Store/files/locks with disposable state only. Receipt values
// are synthetic; no browser, installed profile or live provider is exercised.
func checkHash(value string) string {
	h := sha256.Sum256([]byte(value))
	return hex.EncodeToString(h[:])
}
func checkFixture(t *testing.T) stateFixture {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(base, "farol-state")
	root := filepath.Join(state, "go-core", "computer")
	for _, p := range []string{state, filepath.Join(state, "go-core"), root, filepath.Join(state, "secure-mcp-connector"), filepath.Join(state, "secure-mcp-connector", "computer-authority")} {
		if err = os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	f := stateFixture{root: root, home: base, clock: newClock()}
	f.store, err = Create(root, testBinding, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := f.store.Close(); err != nil {
			t.Error(err)
		}
	})
	return f
}
func checkRequest(n int) check.Request {
	return check.Request{OperationID: fmt.Sprintf("00000000-0000-4000-8000-%012d", n), Fingerprint: checkHash("command"), ProfileID: testBinding.ProfileID, OwnerID: testBinding.OwnerID, ComputerID: testBinding.ComputerID}
}
func checkScope(mode check.Mode) check.Scope {
	s := check.Scope{Mode: mode, ScopeDigest: checkHash("scope"), BuildID: checkHash("build"), BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: "1", ComputerGeneration: "1", TunnelID: "tunnel", AppName: "Farol Dev", WorkspaceID: "work", ChallengeDigest: checkHash("challenge"), Model: "temporary-instant", DocumentDigest: checkHash("document")}
	if mode == check.Status {
		s.AttachmentDigest = checkHash("proof")
	} else {
		s.Challenge = "challenge"
	}
	return s
}
func prepareCheck(t *testing.T, f stateFixture, mode check.Mode) check.Entry {
	t.Helper()
	ctx := context.Background()
	req := checkRequest(1)
	_, first, err := f.store.ClaimConnectionCheck(ctx, req)
	if err != nil || !first {
		t.Fatal("claim", err)
	}
	marked, err := f.store.disk.connectionCheckWitness(historyCheckFile)
	if err != nil || !marked {
		t.Fatal("claim returned before witness", err)
	}
	e, prompt, err := f.store.PrepareConnectionCheck(ctx, req.OperationID, checkScope(mode))
	if err != nil || e.Scope == nil {
		t.Fatal("prepare", err)
	}
	if e.Scope.PromptDigest != checkHash(prompt) || prompt != check.Prompt(*e.Scope) {
		t.Fatal("prompt not original Go document")
	}
	// The nonce stays in Go; the prompt asks for an argument-free call that a
	// cached ChatGPT tool schema can still accept.
	if mode == check.Status && (e.Scope.CheckID == "" || strings.Contains(prompt, e.Scope.CheckID)) {
		t.Fatal("Go nonce absent or leaked into prompt")
	}
	return e
}
func fusePath(f stateFixture, challenge string) string {
	return filepath.Join(filepath.Dir(filepath.Dir(f.root)), "secure-mcp-connector", "computer-authority", "app-verification-"+challenge+".json")
}

func TestConnectionCheckBootstrapFuseAndIntentAreDurableBeforeOnePermit(t *testing.T) {
	f := checkFixture(t)
	e := prepareCheck(t, f, check.Bootstrap)
	ctx := context.Background()
	sent, first, err := f.store.AdvanceConnectionCheck(ctx, e.Request.OperationID, check.DispatchIntent, nil)
	if err != nil || !first || sent.Phase != check.DispatchIntent {
		t.Fatal("dispatch", err)
	}
	raw, err := os.ReadFile(fusePath(f, e.Scope.ChallengeDigest))
	if err != nil {
		t.Fatal(err)
	}
	var fuse struct {
		Schema         int           `json:"schema"`
		OperationID    string        `json:"operationId"`
		Request        check.Request `json:"request"`
		ScopeDigest    string        `json:"scopeDigest"`
		DocumentDigest string        `json:"documentDigest"`
		PromptDigest   string        `json:"promptDigest"`
	}
	if json.Unmarshal(raw, &fuse) != nil || fuse.Schema != 3 || fuse.OperationID != e.Request.OperationID || fuse.Request != e.Request || fuse.ScopeDigest != e.Scope.ScopeDigest || fuse.DocumentDigest != e.Scope.DocumentDigest || fuse.PromptDigest != e.Scope.PromptDigest {
		t.Fatal("unbound original fuse", string(raw))
	}
	journalRaw, err := f.store.disk.readConnectionChecks(historyCheckFile)
	if err != nil {
		t.Fatal(err)
	}
	decoded, _, err := decodeConnectionCheckHistory(testBinding, journalRaw)
	if err != nil || decoded.Entries[0].Phase != check.DispatchIntent {
		t.Fatal("permit without intent bytes", err)
	}
	if _, again, err := f.store.AdvanceConnectionCheck(ctx, e.Request.OperationID, check.DispatchIntent, nil); err == nil || again {
		t.Fatal("second permit")
	}
	after, _ := os.ReadFile(fusePath(f, e.Scope.ChallengeDigest))
	if !bytes.Equal(raw, after) {
		t.Fatal("duplicate modified fuse")
	}
	reopened := restored(t, f)
	observed, first, err := reopened.ClaimConnectionCheck(ctx, e.Request)
	if err != nil || first || observed.Phase != check.DispatchIntent {
		t.Fatal("reopen did not observe original", err)
	}
	if _, again, err := reopened.AdvanceConnectionCheck(ctx, e.Request.OperationID, check.DispatchIntent, nil); err == nil || again {
		t.Fatal("restart dispatched")
	}
	// A new owner click is allowed; the original is retained as unknown and
	// can never be dispatched again.
	if _, first, err := reopened.ClaimConnectionCheck(ctx, checkRequest(2)); err != nil || !first {
		t.Fatal("new owner check was blocked after restart", err)
	}
	if prior, ok, err := reopened.CheckStatus(ctx, e.Request.OperationID); err != nil || !ok || prior.Phase != check.OutcomeUnknown {
		t.Fatal("superseded original was not retained as unknown", prior.Phase, err)
	}
	if _, again, err := reopened.AdvanceConnectionCheck(ctx, e.Request.OperationID, check.DispatchIntent, nil); err == nil || again {
		t.Fatal("superseded original dispatched")
	}
}
func TestConnectionCheckLegacyAndPartialFusesAreImmutableConsumedFences(t *testing.T) {
	for _, raw := range []string{`{"schema":1}`, `{"schema":2,"predecessorOutcome":"unknown"}`, `{"schema":`, ""} {
		t.Run(fmt.Sprintf("bytes-%d", len(raw)), func(t *testing.T) {
			f := checkFixture(t)
			e := prepareCheck(t, f, check.Bootstrap)
			p := fusePath(f, e.Scope.ChallengeDigest)
			if err := os.WriteFile(p, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			if _, permit, err := f.store.AdvanceConnectionCheck(context.Background(), e.Request.OperationID, check.DispatchIntent, nil); !errors.Is(err, check.ErrUnknown) || permit {
				t.Fatal("old/partial fence reused", err)
			}
			after, err := os.ReadFile(p)
			if err != nil || string(after) != raw {
				t.Fatal("legacy custody modified", err)
			}
			reopened := restored(t, f)
			seen, ok, err := reopened.CheckStatus(context.Background(), e.Request.OperationID)
			if err != nil || !ok || seen.Phase != check.Prepared || reopened.activeCheckID != "" {
				t.Fatal("lost original blocked attempt", err)
			}
		})
	}
}
func TestConnectionCheckFuseDirectorySyncUncertaintyNeverPermitsDispatchOrReclaim(t *testing.T) {
	f := checkFixture(t)
	e := prepareCheck(t, f, check.Bootstrap)
	p := fusePath(f, e.Scope.ChallengeDigest)
	var attempts unix.Stat_t
	if err := unix.Stat(filepath.Dir(p), &attempts); err != nil {
		t.Fatal(err)
	}
	f.store.disk.syncDirectory = func(fd int) error {
		var st unix.Stat_t
		if err := unix.Fstat(fd, &st); err != nil {
			return err
		}
		if st.Ino == attempts.Ino && st.Dev == attempts.Dev {
			return unix.EIO
		}
		return unix.Fsync(fd)
	}
	if _, permit, err := f.store.AdvanceConnectionCheck(context.Background(), e.Request.OperationID, check.DispatchIntent, nil); !errors.Is(err, check.ErrUnknown) || permit {
		t.Fatal("uncertain fuse allowed send", err)
	}
	before, err := os.ReadFile(p)
	if err != nil || len(before) == 0 {
		t.Fatal("failed publication did not preserve fuse", err)
	}
	reopened := restored(t, f)
	if _, permit, err := reopened.AdvanceConnectionCheck(context.Background(), e.Request.OperationID, check.DispatchIntent, nil); err == nil || permit {
		t.Fatal("reopened fuse was reclaimed")
	}
	after, _ := os.ReadFile(p)
	if !bytes.Equal(before, after) {
		t.Fatal("uncertain original erased")
	}
}
func TestConnectionCheckStatusNeverClaimsBootstrapAndRequiresExactOriginalReceipt(t *testing.T) {
	f := checkFixture(t)
	e := prepareCheck(t, f, check.Status)
	ctx := context.Background()
	if _, first, err := f.store.AdvanceConnectionCheck(ctx, e.Request.OperationID, check.DispatchIntent, nil); err != nil || !first {
		t.Fatal(err)
	}
	if _, err := os.Stat(fusePath(f, e.Scope.ChallengeDigest)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("status consumed bootstrap fuse", err)
	}
	wrong := &check.Receipt{Kind: "status", CheckID: checkRequest(2).OperationID, Digest: checkHash("receipt")}
	if _, _, err := f.store.AdvanceConnectionCheck(ctx, e.Request.OperationID, check.Verified, wrong); err == nil {
		t.Fatal("wrong nonce accepted")
	}
	right := &check.Receipt{Kind: "status", CheckID: e.Scope.CheckID, Digest: checkHash("receipt")}
	if _, _, err := f.store.AdvanceConnectionCheck(ctx, e.Request.OperationID, check.Verified, right); err != nil {
		t.Fatal(err)
	}
	reopened := restored(t, f)
	observed, first, err := reopened.ClaimConnectionCheck(ctx, e.Request)
	if err != nil || first || observed.Phase != check.Verified || observed.Receipt == nil || *observed.Receipt != *right {
		t.Fatal("terminal original lost", err)
	}
	if _, first, err := reopened.ClaimConnectionCheck(ctx, checkRequest(2)); err != nil || !first {
		t.Fatal("known terminal blocked independent check", err)
	}
}
func TestConnectionCheckIntentSyncFailureRetainsOriginalAcrossReopen(t *testing.T) {
	f := checkFixture(t)
	e := prepareCheck(t, f, check.Status)
	f.store.disk.syncDirectory = func(int) error { return unix.EIO }
	if _, permit, err := f.store.AdvanceConnectionCheck(context.Background(), e.Request.OperationID, check.DispatchIntent, nil); !OutcomeUnknown(err) || permit {
		t.Fatal("uncertain intent permitted Send", err)
	}
	reopened := restored(t, f)
	seen, ok, err := reopened.CheckStatus(context.Background(), e.Request.OperationID)
	if err != nil || !ok || seen.Phase != check.DispatchIntent || reopened.activeCheckID != "" {
		t.Fatal("restart lost uncertain intent", err)
	}
	if _, _, err := reopened.AdvanceConnectionCheck(context.Background(), e.Request.OperationID, check.RefusedBeforeSend, nil); err == nil {
		t.Fatal("restart invented no-send certainty")
	}
}
func TestConnectionCheckFirstPresenceOrphanAndNoncanonicalBytesFailClosed(t *testing.T) {
	for _, file := range []checkJournalFile{legacyCheckFile, historyCheckFile} {
		t.Run("witness-without-ledger-"+file.name, func(t *testing.T) {
			f := checkFixture(t)
			if err := f.store.disk.markConnectionCheckWitness(file); err != nil {
				t.Fatal(err)
			}
			if err := f.store.Close(); err != nil {
				t.Fatal(err)
			}
			s, err := Open(f.root, testBinding, f.clock)
			if s != nil {
				s.Close()
			}
			if err == nil {
				t.Fatal("missing first ledger became empty")
			}
		})
	}
	j := check.Journal{Entries: []check.Entry{{Request: checkRequest(1), Phase: check.Claimed}}}
	raw, err := encodeConnectionChecks(testBinding, j)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{append(append([]byte{}, raw...), '\n'), bytes.Replace(raw, []byte(`"schema":1`), []byte(`"schema":1,"schema":1`), 1), bytes.Replace(raw, []byte(`"schema":1`), []byte(`"schema":1,"extra":true`), 1)} {
		if _, err := decodeConnectionChecks(testBinding, bad); err == nil {
			t.Fatal("noncanonical bytes accepted")
		}
	}
	raw, err = encodeConnectionCheckHistory(testBinding, j, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{append(append([]byte{}, raw...), '\n'), bytes.Replace(raw, []byte(`"schema":2`), []byte(`"schema":2,"schema":2`), 1), bytes.Replace(raw, []byte(`"schema":2`), []byte(`"schema":2,"extra":true`), 1), bytes.Replace(raw, []byte(`"schema":2`), []byte(`"schema":1`), 1), bytes.Replace(raw, []byte(`"legacyDigest":""`), []byte(`"legacyDigest":"ABC"`), 1)} {
		if _, _, err := decodeConnectionCheckHistory(testBinding, bad); err == nil {
			t.Fatal("noncanonical history bytes accepted", string(bad))
		}
	}
}
