package boot

// CPU publication metadata join only. Store, Chat and provider boundaries use
// the existing fixture; no native qualification, provider read or Task admission.
import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

func publishTaskReadMetadata(t *testing.T, p *taskPublicationFixture, source *wire.TaskCodexSource, read *wire.TaskCodexReadSelection) error {
	t.Helper()
	p.sequence++
	d, err := p.ingress.Deactivate(context.Background(), fmt.Sprintf("read-withdraw-%d", p.sequence))
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.ingress.Publish(context.Background(), fmt.Sprintf("read-publish-%d", p.sequence), wire.ComputerAuthorityPublishRequest{
		Fence: d.Fence, ExpectedStoreRevision: d.StoreRevision, SettingsRevision: fmt.Sprint(p.sequence),
		Approval: p.approval, TaskCodex: source, TaskCodexRead: read,
	})
	return err
}

func assertTaskReadMetadataHasNoEffects(t *testing.T, p *taskPublicationFixture) {
	t.Helper()
	p.f.task.pipe.mu.Lock()
	requests := len(p.f.task.pipe.requests)
	p.f.task.pipe.mu.Unlock()
	if requests != 0 || p.f.task.pipe.launches.Load() != 0 || p.f.task.store.snapshot != nil || len(p.f.task.store.ops) != 0 || len(p.f.profile.tasks) != 0 || len(p.f.profile.clients) != 0 || len(p.selector.surface.handles) != 0 || p.store.admits != 0 || len(p.ingress.tasks) != 0 || len(p.ingress.turns) != 0 {
		t.Fatal("metadata join performed provider, process or admission effects")
	}
}

func TestTaskReadPublicationLegacyAbsence(t *testing.T) {
	p := newTaskPublicationFixture(t)
	for _, source := range []*wire.TaskCodexSource{nil, &p.metadata} {
		if read, err := p.ingress.parsePublishedCodexRead(nil, nil); err != nil || read != nil {
			t.Fatal("legacy absence rejected", read, err)
		}
		if err := publishTaskReadMetadata(t, p, source, nil); err != nil {
			t.Fatal("legacy publication rejected", err)
		}
		a, err := p.read()
		if source != nil && (err != nil || a.State != codexclient.AuthorityReady) {
			t.Fatal("ordinary Task source lost legacy validity", err)
		}
		a, ref, err := p.ingress.currentCodexReadAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot)
		if !errors.Is(err, task.ErrUnavailable) || a != (codexclient.AuthoritySnapshot{}) || ref != (controlct.Reference{}) {
			t.Fatal("legacy absence invented an exact read", a, ref, err)
		}
	}
	assertTaskReadMetadataHasNoEffects(t, p)
}

func TestTaskReadPublicationExactPairCopies(t *testing.T) {
	p := newTaskPublicationFixture(t)
	selected := wire.TaskCodexReadSelection{ThreadId: "019a106c-42a2-7a82-9540-58482fa9618b", TurnId: "Turn_09-Az"}
	want := controlct.Reference{ThreadID: selected.ThreadId, TurnID: selected.TurnId}
	parsed, err := p.ingress.parsePublishedCodexRead(&selected, &codexclient.AuthoritySnapshot{})
	if err != nil || parsed == &selected || *parsed != selected {
		t.Fatal("parser did not value-copy exact metadata", parsed, err)
	}
	parsed.TurnId = "changed-parser-copy"
	if selected.TurnId != want.TurnID {
		t.Fatal("parser copy aliases input")
	}
	if err := publishTaskReadMetadata(t, p, &p.metadata, &selected); err != nil {
		t.Fatal(err)
	}
	original, err := p.read()
	if err != nil {
		t.Fatal(err)
	}
	a, ref, err := p.ingress.currentCodexReadAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot)
	if err != nil || a != original || ref != want || a.Followup.Selection != a.Selection {
		t.Fatal("read pair did not join original snapshot", a, ref, err)
	}
	selected.ThreadId, selected.TurnId = "changed-caller-thread", "changed-caller-turn"
	*p.metadata.Effort = "changed-effort"
	p.metadata.Followup.SchemaSha256 = strings.Repeat("f", 64)
	a.Selection.Binding.Model = "changed-returned-snapshot"
	ref.ThreadID, ref.TurnID = "changed-returned-thread", "changed-returned-turn"
	_, copied, err := p.ingress.currentCodexPublication(context.Background(), p.input.HostID, p.input.ScratchRoot)
	if err != nil || copied == nil {
		t.Fatal(err)
	}
	copied.ThreadId, copied.TurnId = "changed-copy-thread", "changed-copy-turn"
	a, ref, err = p.ingress.currentCodexReadAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot)
	if err != nil || a != original || ref != want {
		t.Fatal("caller or returned alias changed publication", a, ref, err)
	}
	assertTaskReadMetadataHasNoEffects(t, p)
}

func TestTaskReadPublicationCurrentPairReplacement(t *testing.T) {
	p := newTaskPublicationFixture(t)
	for i, selected := range []wire.TaskCodexReadSelection{
		{ThreadId: "thread-A", TurnId: "turn-A"},
		{ThreadId: "thread-A", TurnId: "turn-B"},
		{ThreadId: "thread-C", TurnId: "turn-C"},
	} {
		m := p.metadata
		m.Model = fmt.Sprintf("published-model-%d", i)
		if err := publishTaskReadMetadata(t, p, &m, &selected); err != nil {
			t.Fatal(err)
		}
		a, ref, err := p.ingress.currentCodexReadAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot)
		ordinary, ordinaryErr := p.read()
		if err != nil || ordinaryErr != nil || a != ordinary || a.Selection.Binding.Model != m.Model || ref != (controlct.Reference{ThreadID: selected.ThreadId, TurnID: selected.TurnId}) {
			t.Fatal("current publication mixed or retained an old pair", a, ref, err, ordinaryErr)
		}
	}
	// Removing exact metadata must not retain the previous pair for a valid source.
	if err := publishTaskReadMetadata(t, p, &p.metadata, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := p.read(); err != nil {
		t.Fatal(err)
	}
	if _, ref, err := p.ingress.currentCodexReadAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot); !errors.Is(err, task.ErrUnavailable) || ref != (controlct.Reference{}) {
		t.Fatal("removed pair remained current", ref, err)
	}
	assertTaskReadMetadataHasNoEffects(t, p)
}

func TestTaskReadPublicationIDBoundary(t *testing.T) {
	p := newTaskPublicationFixture(t)
	for _, id := range []string{"A", "z", "0", "_", "-", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-", strings.Repeat("A", 120)} {
		selected := wire.TaskCodexReadSelection{ThreadId: id, TurnId: id}
		if err := publishTaskReadMetadata(t, p, &p.metadata, &selected); err != nil {
			t.Fatalf("valid exact ID %q rejected: %v", id, err)
		}
		_, ref, err := p.ingress.currentCodexReadAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot)
		if err != nil || ref != (controlct.Reference{ThreadID: id, TurnID: id}) {
			t.Fatal("exact ASCII ID changed", ref, err)
		}
	}
	assertTaskReadMetadataHasNoEffects(t, p)
}

func TestTaskReadPublicationRejectsBeforeStoreUpdate(t *testing.T) {
	for _, id := range []string{"", strings.Repeat("a", 121), " leading", "trailing ", "line\n", "tab\t", "thread/other", "turn.other", "turn:other", "a+b", "a\\b", "\x00", "é", "线程", "Ａ", "a\u200b"} {
		for _, field := range []string{"thread", "turn"} {
			t.Run(fmt.Sprintf("%s/%q", field, id), func(t *testing.T) {
				p := newTaskPublicationFixture(t)
				p.publish(t, &p.metadata)
				old, updates, revision, claims := p.ingress.publication, p.store.updates, p.store.revision, len(p.ingress.used)
				selected := wire.TaskCodexReadSelection{ThreadId: "thread", TurnId: "turn"}
				if field == "thread" {
					selected.ThreadId = id
				} else {
					selected.TurnId = id
				}
				if parsed, err := p.ingress.parsePublishedCodexRead(&selected, old.taskCodex); !errors.Is(err, task.ErrUnavailable) || parsed != nil {
					t.Fatal("pure parser accepted malformed or partial pair", parsed, err)
				}
				if err := publishTaskReadMetadata(t, p, &p.metadata, &selected); err == nil {
					t.Fatal("malformed or partial pair published")
				}
				if p.store.updates != updates || p.store.revision != revision || p.ingress.publication != old || len(p.ingress.used) != claims+1 {
					t.Fatal("invalid metadata reached claim, Store write or publication replacement")
				}
				assertTaskReadMetadataHasNoEffects(t, p)
			})
		}
	}
	t.Run("nil-source", func(t *testing.T) {
		p := newTaskPublicationFixture(t)
		selected := wire.TaskCodexReadSelection{ThreadId: "thread", TurnId: "turn"}
		if parsed, err := p.ingress.parsePublishedCodexRead(&selected, nil); !errors.Is(err, task.ErrUnavailable) || parsed != nil {
			t.Fatal("pure parser accepted read without parsed source", parsed, err)
		}
		if err := publishTaskReadMetadata(t, p, nil, &selected); err == nil || p.store.updates != 0 || p.store.revision != 1 || p.ingress.publication != nil || len(p.ingress.used) != 1 {
			t.Fatal("read without source reached claim or Store write", err)
		}
		assertTaskReadMetadataHasNoEffects(t, p)
	})
}

func TestTaskReadPublicationNegativeGuards(t *testing.T) {
	for _, mode := range []string{"unknown", "unknown-commit", "withdrawn", "exhausted", "crossed", "zero-fence", "no-publication", "no-source", "nil-owner", "nil-context", "cancelled", "empty-host", "invalid-host", "long-host", "empty-scratch", "relative-scratch", "root-scratch", "unclean-scratch", "spaced-scratch"} {
		t.Run(mode, func(t *testing.T) {
			p := newTaskPublicationFixture(t)
			selected := wire.TaskCodexReadSelection{ThreadId: "thread", TurnId: "turn"}
			if err := publishTaskReadMetadata(t, p, &p.metadata, &selected); err != nil {
				t.Fatal(err)
			}
			ctx, ingress, host, scratch := context.Background(), p.ingress, p.input.HostID, p.input.ScratchRoot
			wantErr := task.ErrUnavailable
			switch mode {
			case "unknown":
				p.ingress.poison()
				wantErr = task.ErrUnknown
			case "unknown-commit":
				p.store.unknown = true
				if err := publishTaskReadMetadata(t, p, &p.metadata, &selected); err == nil {
					t.Fatal("controlled unknown Store commit accepted")
				}
				wantErr = task.ErrUnknown
			case "withdrawn":
				if _, err := p.ingress.Deactivate(ctx, "read-negative-withdraw"); err != nil {
					t.Fatal(err)
				}
			case "exhausted":
				p.ingress.guard.exhausted = true
			case "crossed":
				p.ingress.guard.revision++
			case "zero-fence":
				p.ingress.guard.revision = 0
			case "no-publication":
				p.ingress.publication = nil
			case "no-source":
				p.ingress.publication.taskCodex = nil
			case "nil-owner":
				ingress = nil
			case "nil-context":
				ctx = nil
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "empty-host":
				host = ""
			case "invalid-host":
				host = "host\nother"
			case "long-host":
				host = strings.Repeat("h", 121)
			case "empty-scratch":
				scratch = ""
			case "relative-scratch":
				scratch = "fixture/scratch"
			case "root-scratch":
				scratch = "/"
			case "unclean-scratch":
				scratch = "/fixture/../scratch"
			case "spaced-scratch":
				scratch = "/fixture/scratch "
			}
			updates := p.store.updates
			a, ref, err := ingress.currentCodexReadAuthority(ctx, host, scratch)
			if !errors.Is(err, wantErr) || a != (codexclient.AuthoritySnapshot{}) || ref != (controlct.Reference{}) || p.store.updates != updates {
				t.Fatal("negative guard returned metadata or wrote Store", a, ref, err)
			}
			assertTaskReadMetadataHasNoEffects(t, p)
		})
	}
}

func TestTaskReadPublicationIgnoresEffectsLockAndIO(t *testing.T) {
	p := newTaskPublicationFixture(t)
	selected := wire.TaskCodexReadSelection{ThreadId: "thread", TurnId: "turn"}
	if err := publishTaskReadMetadata(t, p, &p.metadata, &selected); err != nil {
		t.Fatal(err)
	}
	// Nil effect ports and a held effects lock must not affect guarded metadata.
	p.ingress.store, p.ingress.clock, p.ingress.chat, p.ingress.native = nil, nil, nil, nil
	p.ingress.effects.Lock()
	defer p.ingress.effects.Unlock()
	done := make(chan error, 1)
	go func() {
		a, ref, err := p.ingress.currentCodexReadAuthority(context.Background(), p.input.HostID, p.input.ScratchRoot)
		if err == nil && (a.State != codexclient.AuthorityReady || ref != (controlct.Reference{ThreadID: selected.ThreadId, TurnID: selected.TurnId})) {
			err = errors.New("exact metadata lost")
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("metadata read waited on effects lock")
	}
	assertTaskReadMetadataHasNoEffects(t, p)
}
