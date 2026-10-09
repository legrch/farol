package boot

// CPU composition of the existing publication, TaskProfile and original Client.
// The existing memory journal and net.Pipe script are controlled boundaries;
// these cases prove no native storage, socket, account, app or provider behavior.
import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/contracts/selectedthread"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

type taskReadVerifier struct {
	pipe  *taskIngressTestPipe
	calls atomic.Int32
	hook  func(context.Context) error
}

func (v *taskReadVerifier) Verify(ctx context.Context, s codexclient.Selection) error {
	v.calls.Add(1)
	if v.hook != nil {
		if err := v.hook(ctx); err != nil {
			return err
		}
	}
	return v.pipe.Verify(ctx, s)
}

type taskReadSourceFixture struct {
	publication  *taskPublicationFixture
	input        PublishedCodexReadSource
	verifier     *taskReadVerifier
	factories    atomic.Int32
	clocks       atomic.Int32
	clock        atomic.Int64
	grant        func(context.Context, task.Binding) error
	dispatch     func(context.Context, task.Intent) error
	client       *codexclient.Client // Test-only access, never returned by Root.
	chatRevision uint64
	chatEntries  int
}

func newTaskReadSourceFixture(t *testing.T) *taskReadSourceFixture {
	t.Helper()
	p := newTaskPublicationFixture(t)
	if err := publishTaskReadMetadata(t, p, &p.metadata, &wire.TaskCodexReadSelection{ThreadId: "thread-exact", TurnId: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	f := &taskReadSourceFixture{publication: p, verifier: &taskReadVerifier{pipe: p.f.task.pipe}}
	f.chatRevision, f.chatEntries = p.f.chat.journal.revision, len(p.f.chat.journal.entries)
	f.clock.Store(p.f.task.pipe.selection.GrantedAt.Add(time.Minute).UnixNano())
	f.input = PublishedCodexReadSource{Current: p.ingress, HostID: p.input.HostID, ScratchRoot: p.input.ScratchRoot, Verifier: f.verifier, Now: func() time.Time {
		f.clocks.Add(1)
		return time.Unix(0, f.clock.Load()).UTC()
	}}
	// Use the existing profile factory seam and original concrete CPU client.
	factory := p.f.profile.newClient
	p.f.profile.newClient = func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		f.factories.Add(1)
		f.grant, f.dispatch = grant, dispatch
		client, err := factory(s, q, grant, dispatch)
		f.client = client
		return client, err
	}
	// Script an already stored completed turn; no Create/Continue establishes it.
	p.f.task.pipe.turns = []taskIngressTestTurn{{ID: "turn-1", Status: "completed"}}
	return f
}

func (f *taskReadSourceFixture) selectReader(t *testing.T) selectedthread.Reader {
	t.Helper()
	r, err := f.publication.f.profile.SelectPublishedCodexRead(context.Background(), f.input)
	if err != nil || r == nil {
		t.Fatal("read selection failed", err)
	}
	return r
}

func (f *taskReadSourceFixture) noAdmission(t *testing.T) {
	t.Helper()
	p := f.publication
	if p.f.chat.journal.revision != f.chatRevision || len(p.f.chat.journal.entries) != f.chatEntries {
		t.Fatal("read wrote the Chat journal")
	}
	if len(p.f.profile.tasks) != 0 || len(p.f.profile.routes) != 0 || p.f.task.store.snapshot != nil || len(p.f.task.store.ops) != 0 || len(p.selector.surface.handles) != 0 || p.store.admits != 0 || len(p.ingress.tasks) != 0 || len(p.ingress.turns) != 0 || p.f.task.pipe.count("thread/start") != 0 || p.f.task.pipe.count("turn/start") != 0 {
		t.Fatal("read adopted Task ownership, admission, journal or provider effects")
	}
}

func requireTaskReadRefusal(t *testing.T, r selectedthread.Reader) {
	t.Helper()
	out, err := r.Read(context.Background(), selectedthread.Request{IncludeResult: true})
	var failure *selectedthread.Failure
	if out != nil || !errors.As(err, &failure) {
		t.Fatal("read disclosed data after authority withdrawal", out, err)
	}
}

func TestTaskReadSourceInertOriginalLifetimeAndResultOptIn(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	p := f.publication
	// A read needs neither an accessible Chat owner nor a Task journal port.
	p.f.profile.chat, p.f.profile.journal = nil, nil
	r := f.selectReader(t)
	if f.factories.Load() != 1 || f.clocks.Load() != 0 || f.verifier.calls.Load() != 0 || p.f.task.pipe.launches.Load() != 0 || len(p.f.task.pipe.methods()) != 0 || len(p.f.profile.clients) != 1 {
		t.Fatal("construction performed clock, qualification, provider or extra-client work")
	}
	if !errors.Is(f.dispatch(context.Background(), task.Intent{}), task.ErrUnsupported) {
		t.Fatal("read client acquired Task dispatch authority")
	}
	// The original fixed grant still uses fresh authority outside the mutex.
	f.verifier.hook = func(context.Context) error {
		if !p.f.profile.mu.TryLock() {
			t.Error("authority awaited under profile mutex")
			return task.ErrUnavailable
		}
		p.f.profile.mu.Unlock()
		return nil
	}
	for _, include := range []bool{false, true, false} {
		out, err := r.Read(context.Background(), selectedthread.Request{IncludeResult: include})
		if err != nil || out == nil || out.Lifecycle != controlct.Completed || out.Retained || out.Source != "stored" || out.Snapshot != "non_atomic" || out.ResultEvidence != "provider_history" || out.Selection != p.f.profile.read.selected {
			t.Fatal("original stored read failed", out, err)
		}
		want := ""
		if include {
			want = "retained turn-1" // Existing provider fixture text, not journal evidence.
		}
		if out.Text != want {
			t.Fatal("result was not opt-in", out)
		}
	}
	if p.f.task.pipe.launches.Load() != 1 || f.factories.Load() != 1 {
		t.Fatal("stored reads replaced the original lifetime")
	}
	f.noAdmission(t)
}

func TestTaskReadSourceMissingPrerequisitesHaveNoClient(t *testing.T) {
	for _, mode := range []string{"no-publication", "no-source", "no-ref", "unknown", "withdrawn", "closed", "nil-profile", "nil-context", "cancelled", "nil-verifier", "nil-clock"} {
		t.Run(mode, func(t *testing.T) {
			f := newTaskReadSourceFixture(t)
			p, ctx, input := f.publication.f.profile, context.Background(), f.input
			switch mode {
			case "no-publication":
				f.publication.ingress.publication = nil
			case "no-source":
				f.publication.ingress.publication.taskCodex = nil
			case "no-ref":
				f.publication.ingress.publication.taskCodexRead = nil
			case "unknown":
				f.publication.ingress.poison()
			case "withdrawn":
				if _, err := f.publication.ingress.Deactivate(ctx, "read-prerequisite-withdraw"); err != nil {
					t.Fatal(err)
				}
			case "closed":
				if err := p.Close(ctx); err != nil {
					t.Fatal(err)
				}
			case "nil-profile":
				p = nil
			case "nil-context":
				ctx = nil
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "nil-verifier":
				input.Verifier = nil
			case "nil-clock":
				input.Now = nil
			}
			if r, err := p.SelectPublishedCodexRead(ctx, input); err == nil || r != nil {
				t.Fatal("missing prerequisite selected a client", mode, err)
			}
			if f.factories.Load() != 0 || len(f.publication.f.profile.clients) != 0 || f.verifier.calls.Load() != 0 || f.clocks.Load() != 0 || f.publication.f.task.pipe.launches.Load() != 0 {
				t.Fatal("rejected selection performed construction or IO")
			}
			f.noAdmission(t)
		})
	}
}

func TestTaskReadSourceConcurrentSelectionAndReadsShareOriginal(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	const count = 12
	readers := make(chan selectedthread.Reader, count)
	failures := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.publication.f.profile.SelectPublishedCodexRead(context.Background(), f.input)
			if err != nil {
				failures <- err
				return
			}
			readers <- r
		}()
	}
	wg.Wait()
	close(readers)
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	var original selectedthread.Reader
	for r := range readers {
		if original != nil && r != original {
			t.Fatal("duplicate constructed another reader")
		}
		original = r
	}
	if original == nil || f.factories.Load() != 1 || len(f.publication.f.profile.clients) != 1 || f.verifier.calls.Load() != 0 || f.clocks.Load() != 0 {
		t.Fatal("concurrent inert claim did not preserve one original")
	}
	readErrors := make(chan error, count)
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, err := original.Read(context.Background(), selectedthread.Request{})
			if err == nil && (out == nil || out.Retained || out.Text != "") {
				err = errors.New("unexpected stored response")
			}
			readErrors <- err
		}()
	}
	wg.Wait()
	close(readErrors)
	for err := range readErrors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if f.publication.f.task.pipe.launches.Load() != 1 || f.factories.Load() != 1 {
		t.Fatal("concurrent reads reconnected")
	}
	f.noAdmission(t)
}

// Alter the real retained publication under its original lock order. This
// injects classified owner states not all representable by Publish's wire DTO.
func mutateTaskReadPublication(p *taskPublicationFixture, change func(*codexclient.AuthoritySnapshot, *wire.TaskCodexReadSelection)) {
	p.ingress.guard.mu.Lock()
	defer p.ingress.guard.mu.Unlock()
	p.ingress.mu.Lock()
	defer p.ingress.mu.Unlock()
	snapshot, read := *p.ingress.publication.taskCodex, *p.ingress.publication.taskCodexRead
	change(&snapshot, &read)
	p.ingress.publication.taskCodex, p.ingress.publication.taskCodexRead = &snapshot, &read
}

func TestTaskReadSourceCapturedAuthorityAndExactRefNeverRetarget(t *testing.T) {
	changes := map[string]func(*codexclient.AuthoritySnapshot, *wire.TaskCodexReadSelection){
		"thread": func(_ *codexclient.AuthoritySnapshot, r *wire.TaskCodexReadSelection) { r.ThreadId = "other-thread" },
		"turn":   func(_ *codexclient.AuthoritySnapshot, r *wire.TaskCodexReadSelection) { r.TurnId = "other-turn" },
		"profile": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Selection.Binding.ProfileID = "other-profile"
		},
		"project": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Selection.Binding.ProjectID = "other-project"
		},
		"writer": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Selection.Binding.Writer.Inode = "other-inode"
		},
		"model": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Selection.Binding.Model = "other-model"
		},
		"effort": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Selection.Binding.Effort = "low"
		},
		"digest": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Selection.Binding.ConfigDigest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
		},
		"grant": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Selection.ExpiresAt = a.Selection.ExpiresAt.Add(-time.Second)
		},
		"revoked":    func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) { a.Approved = false },
		"generation": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) { a.ComputerGeneration++ },
		"followup": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.Followup = codexclient.FollowupQualification{}
		},
		"unknown": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.State = codexclient.AuthorityUnknown
		},
		"refused": func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
			a.State = codexclient.AuthorityRefused
		},
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := newTaskReadSourceFixture(t)
			r := f.selectReader(t)
			mutateTaskReadPublication(f.publication, change)
			requireTaskReadRefusal(t, r)
			if replacement, err := f.publication.f.profile.SelectPublishedCodexRead(context.Background(), f.input); err == nil || replacement != nil {
				t.Fatal("changed/unknown selection acquired another reader", replacement, err)
			}
			if f.factories.Load() != 1 || f.publication.f.task.pipe.launches.Load() != 0 {
				t.Fatal("changed source reconstructed or contacted provider")
			}
			f.noAdmission(t)
		})
	}
}

func TestTaskReadSourceOriginalPublicationAndHostInputsRemainSealed(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	r := f.selectReader(t)
	p := f.publication
	for _, field := range []string{"host", "scratch", "owner", "source"} {
		input := f.input
		switch field {
		case "host":
			input.HostID = "other-host"
		case "scratch":
			input.ScratchRoot = "/other/scratch"
		case "owner":
			input.Current = nil
		case "source":
			other := newTaskReadSourceFixture(t)
			input.Current = other.input.Current
		}
		if got, err := p.f.profile.SelectPublishedCodexRead(context.Background(), input); err == nil || got != nil {
			t.Fatal("crossed Root source accepted", field, err)
		}
	}
	// Identical republishing and duplicate callbacks cannot rebind the client.
	if err := publishTaskReadMetadata(t, p, &p.metadata, &wire.TaskCodexReadSelection{ThreadId: "thread-exact", TurnId: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	duplicate := f.input
	duplicate.Now = func() time.Time { t.Error("duplicate rebound clock"); return time.Time{} }
	duplicate.Verifier = &taskReadVerifier{pipe: p.f.task.pipe, hook: func(context.Context) error { t.Error("duplicate rebound verifier"); return task.ErrUnavailable }}
	if got, err := p.f.profile.SelectPublishedCodexRead(context.Background(), duplicate); err != nil || got != r {
		t.Fatal("identical publication replaced reader", err)
	}
	if out, err := r.Read(context.Background(), selectedthread.Request{}); err != nil || out == nil {
		t.Fatal("identical republishing invalidated original", err)
	}
	if f.factories.Load() != 1 {
		t.Fatal("duplicate replaced client")
	}
	f.noAdmission(t)
}

func TestTaskReadSourceLateChangesAndExpiryFenceDisclosure(t *testing.T) {
	for _, phase := range []string{"before-io", "after-io"} {
		for _, mode := range []string{"ref", "snapshot", "expiry", "withdrawn", "unknown", "close"} {
			t.Run(phase+"/"+mode, func(t *testing.T) {
				f := newTaskReadSourceFixture(t)
				r := f.selectReader(t)
				p := f.publication
				var changed atomic.Bool
				f.verifier.hook = func(context.Context) error {
					if phase == "after-io" && p.f.task.pipe.count("thread/items/list") == 0 {
						return nil
					}
					if changed.Swap(true) {
						return nil
					}
					switch mode {
					case "ref":
						mutateTaskReadPublication(p, func(_ *codexclient.AuthoritySnapshot, read *wire.TaskCodexReadSelection) { read.TurnId = "other-turn" })
					case "snapshot":
						mutateTaskReadPublication(p, func(a *codexclient.AuthoritySnapshot, _ *wire.TaskCodexReadSelection) {
							a.Selection.Binding.Model = "other-model"
						})
					case "expiry":
						f.clock.Store(p.f.task.pipe.selection.ExpiresAt.UnixNano())
					case "withdrawn":
						_, err := p.ingress.Deactivate(context.Background(), "late-read-withdraw")
						return err
					case "unknown":
						p.ingress.poison()
					case "close":
						return p.f.profile.Close(context.Background())
					}
					return nil
				}
				requireTaskReadRefusal(t, r)
				if !changed.Load() {
					t.Fatal("late authority hook was not exercised")
				}
				if phase == "before-io" && p.f.task.pipe.launches.Load() != 0 {
					t.Fatal("authority changed before IO but provider was contacted")
				}
				if phase == "after-io" && p.f.task.pipe.count("thread/items/list") == 0 {
					t.Fatal("test did not reach stored result IO")
				}
				if f.factories.Load() != 1 {
					t.Fatal("late change reconstructed client")
				}
				f.noAdmission(t)
			})
		}
	}
}

func TestTaskReadSourceLostClientStaysSticky(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	r := f.selectReader(t)
	pipe := f.publication.f.task.pipe
	// Invalid history makes the original proxy unknown; it is never replaced.
	pipe.notifications = func(req taskIngressTestRPC) [][]byte {
		if req.Method == "thread/read" {
			return [][]byte{[]byte("{")}
		}
		return nil
	}
	requireTaskReadRefusal(t, r)
	before := len(pipe.methods())
	for i := 0; i < 3; i++ {
		if duplicate := f.selectReader(t); duplicate != r {
			t.Fatal("unknown connection selected a replacement reader")
		}
		requireTaskReadRefusal(t, r)
	}
	if pipe.launches.Load() != 1 || f.factories.Load() != 1 || len(pipe.methods()) != before {
		t.Fatal("lost original reconnected or issued fresh history IO")
	}
	f.noAdmission(t)
}

func TestTaskReadSourceCloseOwnsClaimAndFencesReader(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	p := f.publication.f.profile
	factory := p.newClient
	claimed, release := make(chan struct{}), make(chan struct{})
	p.newClient = func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		client, err := factory(s, q, grant, dispatch)
		close(claimed)
		<-release // Test-only hold inside the otherwise inert production factory.
		return client, err
	}
	type selectionResult struct {
		reader selectedthread.Reader
		err    error
	}
	selected := make(chan selectionResult, 1)
	go func() {
		r, err := p.SelectPublishedCodexRead(context.Background(), f.input)
		selected <- selectionResult{r, err}
	}()
	<-claimed
	closing, closed := make(chan struct{}), make(chan error, 1)
	go func() { close(closing); closed <- p.Close(context.Background()) }()
	<-closing
	close(release)
	result := <-selected
	if result.err != nil || result.reader == nil {
		t.Fatal("claimed selection failed", result.err)
	}
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if len(p.clients) != 1 || p.clients[f.client] == "" || f.publication.f.closed.Load() != 1 {
		t.Fatal("Close lost an original client or journal lifetime")
	}
	requireTaskReadRefusal(t, result.reader)
	if _, err := f.client.Observe(context.Background(), f.publication.f.task.pipe.selection.Binding, task.Reference{ThreadID: "thread-exact", TurnID: "turn-1"}); err == nil {
		t.Fatal("original client survived profile Close")
	}
	if r, err := p.SelectPublishedCodexRead(context.Background(), f.input); err == nil || r != nil {
		t.Fatal("Close allowed replacement selection")
	}
	if f.factories.Load() != 1 || f.publication.f.task.pipe.launches.Load() != 0 {
		t.Fatal("Close raced into unowned provider work")
	}
	f.noAdmission(t)
}

func TestTaskReadSourceFailedFactoryRetainsAndClosesOriginal(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	p := f.publication.f.profile
	factory := p.newClient
	p.newClient = func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		client, _ := factory(s, q, grant, dispatch)
		return client, task.ErrUnknown
	}
	for i := 0; i < 2; i++ {
		if r, err := p.SelectPublishedCodexRead(context.Background(), f.input); r != nil || !errors.Is(err, task.ErrUnknown) {
			t.Fatal("failed original factory was adopted", r, err)
		}
	}
	if f.factories.Load() != 1 || len(p.clients) != 1 || p.clients[f.client] == "" {
		t.Fatal("failed claim lost ownership or reconstructed original")
	}
	if err := p.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := f.client.Observe(context.Background(), f.publication.f.task.pipe.selection.Binding, task.Reference{ThreadID: "thread-exact", TurnID: "turn-1"}); err == nil {
		t.Fatal("failed original was not closed")
	}
	f.noAdmission(t)
}

func TestTaskReadSourceReaderCompositionFailureKeepsClaimOwned(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	p := f.publication.f.profile
	factory := p.newClient
	p.newClient = func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		// An invalid factory result must not escape or get orphaned when the
		// existing reader constructor rejects its crossed immutable binding.
		s.Binding.Effort = "low"
		q.Selection = s
		return factory(s, q, grant, dispatch)
	}
	for i := 0; i < 2; i++ {
		if r, err := p.SelectPublishedCodexRead(context.Background(), f.input); r != nil || err == nil {
			t.Fatal("crossed original client escaped failed reader composition", r, err)
		}
	}
	if f.factories.Load() != 1 || len(p.clients) != 1 || p.clients[f.client] == "" || p.read.reader != nil {
		t.Fatal("reader composition failure lost ownership or reconstructed client")
	}
	if err := p.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !p.closed.Load() || f.publication.f.closed.Load() != 1 || f.publication.f.task.pipe.launches.Load() != 0 {
		t.Fatal("failed reader escaped original inert cleanup")
	}
	f.noAdmission(t)
}

type taskReadClosingProcess struct {
	closes atomic.Int32
	waits  atomic.Int32
}

func (*taskReadClosingProcess) Read([]byte) (int, error)  { return 0, io.ErrClosedPipe }
func (*taskReadClosingProcess) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func (p *taskReadClosingProcess) Close() error {
	p.closes.Add(1)
	return task.ErrUnknown
}
func (p *taskReadClosingProcess) Wait(context.Context) error {
	p.waits.Add(1)
	return task.ErrUnknown // Controlled missing exit proof, never a real process.
}

type taskReadClosingBoundary struct {
	pipe                         *taskIngressTestPipe
	started, cancelled, released chan struct{}
	process                      *taskReadClosingProcess
}

func (b *taskReadClosingBoundary) Verify(ctx context.Context, s codexclient.Selection) error {
	return b.pipe.Verify(ctx, s)
}
func (b *taskReadClosingBoundary) Launch(ctx context.Context, _ codexclient.Selection) (codexclient.Process, error) {
	close(b.started)
	<-ctx.Done()
	close(b.cancelled)
	<-b.released
	return b.process, nil // Model a launch already past its cancellation check.
}

func TestTaskReadSourceProfileCloseRetainsLateOriginalLaunchUncertainty(t *testing.T) {
	f := newTaskReadSourceFixture(t)
	p := f.publication.f.profile
	b := &taskReadClosingBoundary{pipe: f.publication.f.task.pipe, started: make(chan struct{}), cancelled: make(chan struct{}), released: make(chan struct{}), process: &taskReadClosingProcess{}}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(b.released) }) })
	p.newClient = func(s codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		f.factories.Add(1)
		return codexclient.New(codexclient.Options{Selection: s, Followup: q, Boundary: b, Now: f.input.Now, Recheck: grant, RecheckDispatch: dispatch})
	}
	r := f.selectReader(t)
	readCtx, stopRead := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopRead()
	readDone := make(chan error, 1)
	go func() {
		out, err := r.Read(readCtx, selectedthread.Request{IncludeResult: true})
		if out != nil || err == nil {
			err = errors.New("closed original launch disclosed a result")
		}
		readDone <- err
	}()
	select {
	case <-b.started:
	case <-readCtx.Done():
		t.Fatal("controlled original launch did not start")
	}
	closeCtx, stopClose := context.WithTimeout(context.Background(), time.Second)
	defer stopClose()
	closed := make(chan error, 1)
	go func() { closed <- p.Close(closeCtx) }()
	select {
	case <-b.cancelled:
	case <-closeCtx.Done():
		t.Fatal("profile Close did not cancel the original lifetime")
	}
	select {
	case err := <-closed:
		t.Fatal("profile cleanup settled before original launch registration", err)
	default:
	}
	release.Do(func() { close(b.released) })
	select {
	case err := <-closed:
		if !errors.Is(err, task.ErrUnknown) {
			t.Fatal("missing original exit proof became successful cleanup", err)
		}
	case <-closeCtx.Done():
		t.Fatal("profile Close did not settle inside its budget")
	}
	select {
	case err := <-readDone:
		var failure *selectedthread.Failure
		if !errors.As(err, &failure) {
			t.Fatal("closed original read was not refused", err)
		}
	case <-readCtx.Done():
		t.Fatal("controlled original read did not finish")
	}
	if err := p.Close(context.Background()); !errors.Is(err, task.ErrUnknown) || b.process.closes.Load() != 1 || b.process.waits.Load() != 1 || f.publication.f.closed.Load() != 1 || f.factories.Load() != 1 {
		t.Fatal("profile lost or repeated its original cleanup", err, b.process.closes.Load(), b.process.waits.Load())
	}
	f.noAdmission(t)
}
