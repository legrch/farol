package boot

// CPU composition only: existing memory journal, publication, net.Pipe Client
// and scratch descriptor double. No OpenTaskProfile, native filesystem, provider,
// app, profile, build or live execution is performed by these tests.
import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	chathandoff "github.com/legrch/farol/modules/chat/app/services/handoff"
	chatlifecycle "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/results"
	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

type nativeCodexReadFixture struct {
	source *taskReadSourceFixture
	dirs   *taskScratchDouble
	owner  *nativeCodexRead
	run    *NativeRuntime
	opens  atomic.Int32
}

func newNativeCodexReadFixture(t *testing.T) *nativeCodexReadFixture {
	t.Helper()
	f := &nativeCodexReadFixture{source: newTaskReadSourceFixture(t), dirs: newTaskScratchDouble()}
	input := f.source.input
	input.HostID = "codex"
	// Script only the trusted launcher mapping and CPU scratch physical spelling.
	f.source.publication.f.task.pipe.selection.Binding.HostID = input.HostID
	f.source.publication.f.task.pipe.selection.ScratchRoot = "/app/tmp/" + f.dirs.childName
	f.owner = newNativeCodexRead(context.Background(), newTaskReadScratch("/app/tmp", f.dirs), input, func() (*TaskProfile, error) {
		f.opens.Add(1)
		return f.source.publication.f.profile, nil
	})
	f.run = &NativeRuntime{codexRead: f.owner}
	t.Cleanup(func() { _ = f.owner.close() })
	return f
}

func nativeReadCode(t *testing.T, out *selectedthread.Response, err error, code string) {
	t.Helper()
	var failure *selectedthread.Failure
	if out != nil || !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("expected nil output and %s, got %+v, %v", code, out, err)
	}
}

func nativeReadAwait(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("CPU original did not reach its expected boundary")
	}
}

func nativeReadRetention(s *TaskReadScratch) TaskReadScratchRetention {
	s.owner.mu.Lock()
	defer s.owner.mu.Unlock()
	return s.owner.retained
}

func TestNativeCodexReadTrustedSelectionAndNilRemainInert(t *testing.T) {
	for _, in := range []NativeCodexReadSelection{
		{HostID: "other", TrustedTemp: "/app/tmp"}, {HostID: "codex", TrustedTemp: "relative"},
		{HostID: "codex", TrustedTemp: "/app/../tmp"}, {HostID: "codex", TrustedTemp: "/"},
	} {
		if in.valid() {
			t.Fatal("crossed launcher selection accepted", in)
		}
		// This validation runs before ANY native runtime construction.
		if r, err := NewNativeRuntime(context.Background(), NativeLaunch{CodexRead: &in}, "generation"); r != nil || err == nil {
			t.Fatal("invalid selection reached native startup")
		}
	}
	if !(NativeCodexReadSelection{HostID: "codex", TrustedTemp: "/app/tmp"}).valid() {
		t.Fatal("explicit codex slot rejected")
	}
	r := &NativeRuntime{}
	out, err := r.ReadSelectedCodex(context.Background(), selectedthread.Request{})
	nativeReadCode(t, out, err, "TASK_UNAVAILABLE")
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNativeCodexReadLazyOnceRetainsOriginalProfileScratchAndReader(t *testing.T) {
	f := newNativeCodexReadFixture(t)
	if f.opens.Load() != 0 || f.source.factories.Load() != 0 || len(f.dirs.calls) != 0 {
		t.Fatal("construction opened a resource")
	}
	const callers = 8
	done := make(chan error, callers)
	for i := 0; i < callers; i++ {
		go func() {
			out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{IncludeResult: true})
			if err == nil && (out == nil || out.Retained || out.Source != "stored" || out.Snapshot != "non_atomic" || out.ResultEvidence != "provider_history" || out.Text != "retained turn-1") {
				err = errors.New("provider read was misclassified as retained or result opt-in was lost")
			}
			done <- err
		}()
	}
	for i := 0; i < callers; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	original := f.owner.reader
	out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
	if err != nil || out == nil || out.Text != "" || f.owner.reader != original || f.owner.profile != f.source.publication.f.profile || f.opens.Load() != 1 || f.source.factories.Load() != 1 || f.source.publication.f.task.pipe.launches.Load() != 1 {
		t.Fatal("lazy owner replaced an original or lost opt-in", out, err)
	}
	allocations := 0
	for _, call := range f.dirs.calls {
		if call == "mkdir" {
			allocations++
		}
	}
	if allocations != 1 {
		t.Fatal("scratch was replaced", allocations)
	}
	f.source.noAdmission(t)
	if err := f.owner.close(); err != nil {
		t.Fatal("original cleanup failed", err)
	}
	retained := nativeReadRetention(f.owner.scratch)
	if !retained.Created || !retained.Qualified || !retained.Released || f.dirs.entries[taskScratchEntry{2, f.dirs.childName}] != 3 || f.source.publication.f.closed.Load() != 1 {
		t.Fatal("original resources were removed, leaked or closed twice", retained)
	}
}

func TestNativeCodexReadCurrentWithdrawalAndChangedExactReferenceFenceDisclosure(t *testing.T) {
	for _, phase := range []string{"before-io", "after-io"} {
		for _, change := range []string{"withdrawal", "thread", "turn", "model", "socket", "server-home", "unknown"} {
			t.Run(phase+"/"+change, func(t *testing.T) {
				f := newNativeCodexReadFixture(t)
				p := f.source.publication
				var changed atomic.Bool
				f.source.verifier.hook = func(context.Context) error {
					if phase == "after-io" && p.f.task.pipe.count("thread/items/list") == 0 {
						return nil
					}
					if changed.Swap(true) {
						return nil
					}
					if change == "withdrawal" {
						_, err := p.ingress.Deactivate(context.Background(), "native-read-withdraw")
						return err
					}
					mutateTaskReadPublication(p, func(a *codexclient.AuthoritySnapshot, ref *wire.TaskCodexReadSelection) {
						switch change {
						case "thread":
							ref.ThreadId = "other-thread"
						case "turn":
							ref.TurnId = "other-turn"
						case "model":
							a.Selection.Binding.Model = "other-model"
						case "socket":
							a.Selection.SocketPath = "/other/socket"
						case "server-home":
							a.Selection.ExpectedCodexHome = "/other/home"
						case "unknown":
							a.State = codexclient.AuthorityUnknown
						}
					})
					return nil
				}
				out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{IncludeResult: true})
				var failure *selectedthread.Failure
				if out != nil || !errors.As(err, &failure) || !changed.Load() {
					t.Fatal("changed authority disclosed a result", out, err)
				}
				if phase == "before-io" && p.f.task.pipe.launches.Load() != 0 || phase == "after-io" && p.f.task.pipe.count("thread/items/list") == 0 {
					t.Fatal("CPU boundary did not exercise the specified phase")
				}
				if f.opens.Load() != 1 || f.source.factories.Load() != 1 {
					t.Fatal("current authority change replaced original")
				}
				f.source.noAdmission(t)
			})
		}
	}
}

func TestNativeCodexReadUnknownOpeningRetainsOriginalAndBlocksPrepareAndACK(t *testing.T) {
	f := newNativeCodexReadFixture(t)
	f.owner.openProfile = func() (*TaskProfile, error) {
		f.opens.Add(1)
		return f.source.publication.f.profile, task.ErrUnknown
	}
	for i := 0; i < 2; i++ {
		out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
		nativeReadCode(t, out, err, "TASK_OBSERVATION_UNKNOWN")
	}
	if f.opens.Load() != 1 || f.owner.profile != f.source.publication.f.profile || len(f.dirs.calls) != 0 || f.source.factories.Load() != 0 {
		t.Fatal("unknown opening replaced or lost the original")
	}
	if err := f.owner.close(); !errors.Is(err, task.ErrUnknown) || f.source.publication.f.closed.Load() != 1 {
		t.Fatal("unknown opening became known cleanup", err)
	}
	// Real retirement handlers with CPU retained state. All later Chat/repository
	// dependencies are nil: reaching one would fail, proving the cleanup gate wins.
	f.run.retirement = &nativeRetirement{publication: &chatport.HandoffPublication{HandoffID: "handoff-1", ReceiptDigest: [32]byte{1}}}
	prepared := retirementCall(t, f.run, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: "handoff-1"})
	ack := retirementCall(t, f.run, "core.retirement.ack", wire.CoreRetirementACK{HandoffId: "handoff-1", ReceiptDigest: "0100000000000000000000000000000000000000000000000000000000000000"})
	if prepared.Status != "unknown" || ack.Status != "unknown" || prepared.Code != "NATIVE_RETIREMENT_UNKNOWN" || ack.Code != "NATIVE_RETIREMENT_UNKNOWN" {
		t.Fatal("unknown original cleanup reached Chat prepare/ACK", prepared, ack)
	}
}

func TestNativeCodexReadCloseBeforeLazyOpeningAndDuringOriginalOpening(t *testing.T) {
	t.Run("unopened", func(t *testing.T) {
		f := newNativeCodexReadFixture(t)
		if err := f.owner.close(); err != nil {
			t.Fatal(err)
		}
		out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
		nativeReadCode(t, out, err, "TASK_UNAVAILABLE")
		if f.opens.Load() != 0 || f.source.factories.Load() != 0 || len(f.dirs.calls) != 0 {
			t.Fatal("closed lazy owner opened resources")
		}
	})
	t.Run("opening", func(t *testing.T) {
		f := newNativeCodexReadFixture(t)
		entered, release := make(chan struct{}), make(chan struct{})
		var released sync.Once
		t.Cleanup(func() { released.Do(func() { close(release) }) })
		f.owner.openProfile = func() (*TaskProfile, error) {
			f.opens.Add(1)
			close(entered)
			<-release
			return f.source.publication.f.profile, task.ErrUnknown
		}
		readDone := make(chan error, 1)
		go func() {
			_, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
			readDone <- err
		}()
		nativeReadAwait(t, entered)
		closed := make(chan error, 1)
		go func() { closed <- f.owner.close() }()
		nativeReadAwait(t, f.owner.lifetime.Done())
		select {
		case err := <-closed:
			t.Fatal("original opening was not joined", err)
		default:
		}
		released.Do(func() { close(release) })
		if err := <-closed; !errors.Is(err, task.ErrUnknown) {
			t.Fatal("unknown original opening became known", err)
		}
		if err := <-readDone; err == nil {
			t.Fatal("late original opening disclosed data")
		}
		if f.owner.profile != f.source.publication.f.profile || f.opens.Load() != 1 || f.source.publication.f.closed.Load() != 1 {
			t.Fatal("opening race lost original ownership")
		}
	})
}

func TestNativeCodexReadCloseJoinsHandlersBeforeScratchReleaseAndRefusesLateRead(t *testing.T) {
	f := newNativeCodexReadFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	f.source.verifier.hook = func(context.Context) error {
		once.Do(func() { close(entered); <-release })
		return nil
	}
	readDone := make(chan error, 1)
	go func() {
		out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{IncludeResult: true})
		if out != nil || err == nil {
			err = errors.New("late result was disclosed")
		}
		readDone <- err
	}()
	nativeReadAwait(t, entered)
	closeDone := make(chan error, 1)
	go func() { closeDone <- f.run.Close() }()
	nativeReadAwait(t, f.owner.lifetime.Done())
	out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
	nativeReadCode(t, out, err, "TASK_UNAVAILABLE")
	select {
	case err := <-closeDone:
		t.Fatal("cleanup completed with an original handler running", err)
	default:
	}
	if retained := nativeReadRetention(f.owner.scratch); retained.Released {
		t.Fatal("scratch released before handler drain", retained)
	}
	close(release)
	if err := <-readDone; err == nil {
		t.Fatal("late read became known")
	}
	if err := <-closeDone; err != nil {
		t.Fatal("joined cleanup failed", err)
	}
	if err := f.run.Close(); err != nil || f.source.publication.f.closed.Load() != 1 || !nativeReadRetention(f.owner.scratch).Released {
		t.Fatal("cleanup repeated or failed to release original pins", err)
	}
}

type nativeReadLateProcess struct {
	closes, waits atomic.Int32
	waited        chan struct{}
}

func (*nativeReadLateProcess) Read([]byte) (int, error)  { return 0, io.ErrClosedPipe }
func (*nativeReadLateProcess) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func (p *nativeReadLateProcess) Close() error            { p.closes.Add(1); return nil }
func (p *nativeReadLateProcess) Wait(context.Context) error {
	p.waits.Add(1)
	close(p.waited)
	return nil
}

type nativeReadLateBoundary struct {
	pipe             *taskIngressTestPipe
	started, release chan struct{}
	process          *nativeReadLateProcess
}

func (b *nativeReadLateBoundary) Verify(ctx context.Context, s codexclient.Selection) error {
	return b.pipe.Verify(ctx, s)
}
func (b *nativeReadLateBoundary) Launch(context.Context, codexclient.Selection) (codexclient.Process, error) {
	close(b.started)
	<-b.release
	return b.process, nil
}

func TestNativeCodexReadFirstCleanupBudgetNeverRearmsAfterLateKnownExit(t *testing.T) {
	f := newNativeCodexReadFixture(t)
	b := &nativeReadLateBoundary{pipe: f.source.publication.f.task.pipe, started: make(chan struct{}), release: make(chan struct{}), process: &nativeReadLateProcess{waited: make(chan struct{})}}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(b.release) }) })
	f.source.publication.f.profile.newClient = func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		f.source.factories.Add(1)
		client, err := codexclient.New(codexclient.Options{Selection: s, Followup: q, Boundary: b, Now: f.source.input.Now, Recheck: grant, RecheckDispatch: dispatch})
		f.source.client = client
		return client, err
	}
	readDone := make(chan error, 1)
	go func() {
		out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{IncludeResult: true})
		if out != nil || err == nil {
			err = errors.New("late launch disclosed output")
		}
		readDone <- err
	}()
	nativeReadAwait(t, b.started)
	started := time.Now()
	if err := f.owner.close(); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("missing original registration/exit proof became known cleanup", err)
	}
	if time.Since(started) > nativeCodexReadCleanupBudget+time.Second {
		t.Fatal("first bounded cleanup exceeded its budget")
	}
	deadline, _ := f.owner.closeContext.Deadline()
	release.Do(func() { close(b.release) })
	if err := <-readDone; err == nil {
		t.Fatal("late read became known")
	}
	nativeReadAwait(t, f.owner.closeDone)
	if err := f.owner.close(); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("late known exit erased the original unknown outcome", err)
	}
	if next, _ := f.owner.closeContext.Deadline(); next != deadline || f.opens.Load() != 1 || f.source.factories.Load() != 1 {
		t.Fatal("cleanup renewed its deadline or original")
	}
	// Observe the ORIGINAL CPU Wait completion, without reissuing cleanup.
	nativeReadAwait(t, b.process.waited)
	if err := f.source.client.Close(context.Background()); !errors.Is(err, task.ErrUnknown) {
		t.Fatal("original client lost sticky unknown", err)
	}
	if b.process.closes.Load() != 1 || b.process.waits.Load() != 1 || nativeReadRetention(f.owner.scratch).Released {
		t.Fatal("original late proxy was signalled twice or scratch released without proof", b.process.closes.Load(), b.process.waits.Load())
	}
}

func TestNativeCodexReadRefusedACKDoesNotCloseActiveRead(t *testing.T) {
	for _, reason := range []string{"before-prepare", "stale-handoff", "zero-digest", "crossed-digest"} {
		t.Run(reason, func(t *testing.T) {
			f := newNativeCodexReadFixture(t)
			if out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{}); out == nil || err != nil {
				t.Fatal("CPU original reader did not become active", out, err)
			}
			publication := &chatport.HandoffPublication{HandoffID: "handoff-exact", ReceiptDigest: [32]byte{1}}
			input := wire.CoreRetirementACK{HandoffId: publication.HandoffID, ReceiptDigest: hex.EncodeToString(publication.ReceiptDigest[:])}
			f.run.retirement = &nativeRetirement{publication: publication}
			switch reason {
			case "before-prepare":
				f.run.retirement.publication = nil
			case "stale-handoff":
				input.HandoffId = "handoff-stale"
			case "zero-digest":
				input.ReceiptDigest = hex.EncodeToString(make([]byte, 32))
			case "crossed-digest":
				digest := [32]byte{2}
				input.ReceiptDigest = hex.EncodeToString(digest[:])
			}
			outcome := retirementCall(t, f.run, "core.retirement.ack", input)
			if outcome.Status != "refused" || outcome.Code != string(chathandoff.Refused) {
				t.Fatal("unselected ACK was not refused", outcome)
			}
			f.owner.mu.Lock()
			closing := f.owner.closing
			f.owner.mu.Unlock()
			if closing || f.owner.lifetime.Err() != nil || nativeReadRetention(f.owner.scratch).Released {
				t.Fatal("refused ACK closed the unrelated active T0 owner")
			}
			if out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{IncludeResult: true}); out == nil || err != nil || out.Text != "retained turn-1" {
				t.Fatal("refused ACK disabled the original reader", out, err)
			}
			if f.opens.Load() != 1 || f.source.factories.Load() != 1 {
				t.Fatal("refused ACK replaced the original")
			}
		})
	}
}

// These memory ports supply labelled CPU persistence for a real empty Chat
// lifecycle and handoff service. They establish no native journal/host proof.
type nativeReadRetirementJournal struct {
	chatComputerJournal
	root        chatport.JournalRoot
	retireCalls int
}

func (j *nativeReadRetirementJournal) OpenFresh(_ context.Context, scope chatport.JournalScope) (*chatport.JournalHead, error) {
	return &chatport.JournalHead{Scope: scope, Root: j.root}, nil
}

func (j *nativeReadRetirementJournal) Retire(_ context.Context, write chatport.RetirementWrite) (*chatport.RetirementReceipt, error) {
	j.retireCalls++
	return &chatport.RetirementReceipt{Write: chatport.CopyRetirement(write), PublicationDigest: [32]byte{1}}, nil
}

type nativeReadHandoffStore struct {
	guard     sync.Mutex
	head      chatport.HandoffHead
	publishes int
}

func (s *nativeReadHandoffStore) Guard() chatport.Gate        { return &s.guard }
func (s *nativeReadHandoffStore) Fence(context.Context) error { return nil }
func (s *nativeReadHandoffStore) Digest(record chatport.HandoffRecord) ([32]byte, error) {
	if err := chathandoff.ValidateRecord(record); err != nil {
		return [32]byte{}, err
	}
	raw, err := json.Marshal(record)
	return sha256.Sum256(raw), err
}
func (s *nativeReadHandoffStore) Load(context.Context) (*chatport.HandoffHead, error) {
	if s.head.Record == nil {
		return &chatport.HandoffHead{}, nil
	}
	record := chathandoff.Copy(*s.head.Record)
	return &chatport.HandoffHead{Record: &record, Digest: s.head.Digest, EmptyRetirementChain: s.head.EmptyRetirementChain}, nil
}
func (s *nativeReadHandoffStore) Publish(ctx context.Context, expected [32]byte, record chatport.HandoffRecord) (*chatport.HandoffHead, error) {
	if ctx.Err() != nil || expected != s.head.Digest {
		return nil, chathandoff.Refused
	}
	if err := chathandoff.ValidateTransition(s.head.Record, expected, record); err != nil {
		return nil, err
	}
	digest, err := s.Digest(record)
	if err != nil {
		return nil, err
	}
	copy := chathandoff.Copy(record)
	emptyChain := (s.head.Record == nil || s.head.EmptyRetirementChain) && len(record.Receipt.Write.Turns) == 0
	s.head = chatport.HandoffHead{Record: &copy, Digest: digest, EmptyRetirementChain: emptyChain}
	s.publishes++
	return s.Load(ctx)
}

func nativeReadEmptyRetirement(t *testing.T, f *nativeCodexReadFixture) (*nativeReadRetirementJournal, *nativeReadHandoffStore) {
	t.Helper()
	ctx := context.Background()
	peer := f.source.publication.ingress.peer
	scope := chatport.JournalScope{ProfileID: peer.ProfileId, BackendGeneration: peer.BackendGeneration}
	root := chatport.JournalRoot{Device: 1, Inode: 3, OwnerUID: 501}
	journal := &nativeReadRetirementJournal{root: root}
	physical, err := browser.New(ctx, browser.Scope{ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration}, &chatComputerPhysical{}, chatComputerClock{})
	if err != nil {
		t.Fatal(err)
	}
	retained, err := results.NewMemory(ctx, scope, results.TextLimits())
	if err != nil {
		t.Fatal(err)
	}
	f.run.chat, err = chatlifecycle.New(ctx, scope, chatlifecycle.Dependencies{Gate: gate.New(), Journal: journal, Browser: physical, Results: retained, ResultBytesLimit: chatlifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	f.run.browser, err = NewBrowserExchange(ctx, peer)
	if err != nil {
		t.Fatal(err)
	}
	store := &nativeReadHandoffStore{}
	service, err := chathandoff.New(store)
	if err != nil {
		t.Fatal(err)
	}
	f.run.ingress = f.source.publication.ingress
	f.run.retirement = &nativeRetirement{service: service, binding: chatport.HandoffBinding{ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration, BuildID: "cpu-build", HostLifetimeID: "cpu-host", ChildLaunchID: "cpu-child", ParentRoot: chatport.JournalRoot{Device: 1, Inode: 2, OwnerUID: 501}, ChatRoot: root}}
	return journal, store
}

func TestNativeCodexReadKnownPreClientRefusalAllowsQuitAndRetirement(t *testing.T) {
	for _, finish := range []string{"quit", "retirement"} {
		t.Run(finish, func(t *testing.T) {
			f := newNativeCodexReadFixture(t)
			p := f.source.publication
			p.ingress.guard.mu.Lock()
			p.ingress.mu.Lock()
			p.ingress.publication.taskCodexRead = nil
			p.ingress.mu.Unlock()
			p.ingress.guard.mu.Unlock()
			out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
			nativeReadCode(t, out, err, "TASK_UNAVAILABLE")
			if f.owner.initErr != task.ErrUnavailable || f.owner.profile != p.f.profile || p.f.profile.read != nil || len(p.f.profile.clients) != 0 || f.source.factories.Load() != 0 || !nativeReadRetention(f.owner.scratch).Qualified {
				t.Fatal("fixture did not prove successful opening with a pre-client metadata refusal", f.owner.initErr)
			}
			// Restoration does not retry initialization or give this failed owner a reader.
			if err := publishTaskReadMetadata(t, p, &p.metadata, &wire.TaskCodexReadSelection{ThreadId: "thread-exact", TurnId: "turn-1"}); err != nil {
				t.Fatal(err)
			}
			out, err = f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
			nativeReadCode(t, out, err, "TASK_UNAVAILABLE")
			if finish == "quit" {
				if err := f.run.Close(); err != nil {
					t.Fatal("known pre-client refusal poisoned normal Quit", err)
				}
			} else {
				journal, store := nativeReadEmptyRetirement(t, f)
				prepared := retirementCall(t, f.run, "core.retirement.prepare", wire.CoreRetirementPrepare{HandoffId: "cpu-handoff"})
				if prepared.Status != "ok" {
					t.Fatal("known pre-client refusal poisoned retirement prepare", prepared)
				}
				var publication wire.CoreRetirementPrepared
				if err := json.Unmarshal(prepared.Data, &publication); err != nil {
					t.Fatal(err)
				}
				ack := retirementCall(t, f.run, "core.retirement.ack", wire.CoreRetirementACK{HandoffId: publication.HandoffId, ReceiptDigest: publication.ReceiptDigest})
				if ack.Status != "ok" || journal.retireCalls != 1 || store.publishes != 2 {
					t.Fatal("known pre-client refusal poisoned retirement ACK", ack)
				}
			}
			if f.owner.initErr != task.ErrUnavailable || f.opens.Load() != 1 || f.source.factories.Load() != 0 || !nativeReadRetention(f.owner.scratch).Released || p.f.closed.Load() != 1 {
				t.Fatal("cleanup erased sticky selection failure, replaced a resource or lacked known release")
			}
		})
	}
}

func TestNativeCodexReadKnownRefusalNeverErasesOpeningClaimOrReleaseFailure(t *testing.T) {
	for _, boundary := range []string{"opening", "claimed-client", "physical-release"} {
		t.Run(boundary, func(t *testing.T) {
			f := newNativeCodexReadFixture(t)
			profile := f.source.publication.f.profile
			switch boundary {
			case "opening":
				f.owner.openProfile = func() (*TaskProfile, error) {
					f.opens.Add(1)
					return profile, task.ErrUnavailable
				}
			case "claimed-client":
				factory := profile.newClient
				profile.newClient = func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
					client, err := factory(s, q, grant, dispatch)
					if err != nil {
						return client, err
					}
					return client, task.ErrUnavailable
				}
			case "physical-release":
				p := f.source.publication.ingress
				p.guard.mu.Lock()
				p.mu.Lock()
				p.publication.taskCodexRead = nil
				p.mu.Unlock()
				p.guard.mu.Unlock()
				f.dirs.closeErrors[3] = true
			}
			out, err := f.run.ReadSelectedCodex(context.Background(), selectedthread.Request{})
			nativeReadCode(t, out, err, "TASK_UNAVAILABLE")
			closeErr := f.owner.close()
			if boundary == "physical-release" {
				if !errors.Is(closeErr, TaskReadScratchCloseUnknown) || nativeReadRetention(f.owner.scratch).Released {
					t.Fatal("known pre-client refusal erased physical release uncertainty", closeErr)
				}
			} else if !errors.Is(closeErr, task.ErrUnavailable) || f.owner.knownPreClientRefusal {
				t.Fatal("opening or claimed-client failure was misclassified as a proved pre-client refusal", closeErr)
			}
			if f.opens.Load() != 1 || f.source.publication.f.closed.Load() != 1 {
				t.Fatal("cleanup replaced or lost the original owner")
			}
		})
	}
}
