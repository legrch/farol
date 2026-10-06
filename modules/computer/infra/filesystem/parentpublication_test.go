package filesystem

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Only the in-memory inode/syscall model and real application producers run.
// There are no native directory, Store, process or connector-socket effects.
type parentBoundaryFS struct {
	*fakeMutationFS
	beforeMkdir func(string)
}

func (f parentBoundaryFS) mkdir(parent int, name string, mode uint32) error {
	f.beforeMkdir(name)
	return f.fakeMutationFS.mkdir(parent, name, mode)
}

func TestMutationParentPublicationPureWithdrawalAtMkdir(t *testing.T) {
	for _, route := range []string{"settings", "connector"} {
		t.Run(route, func(t *testing.T) {
			m, f, owners, journal, execute := publicationFixture(t, route, "create", "nested/deeper/note.md")
			var withdrawn chan struct{}
			m.fs = parentBoundaryFS{fakeMutationFS: f, beforeMkdir: func(name string) {
				if name != "nested" {
					t.Fatal("a later directory reached mkdir after withdrawal")
				}
				// Exactly after validation, before the modeled visible mkdir.
				if owners.access.TryLock() {
					owners.withdrawn = true
					owners.access.Unlock()
					t.Error("withdrawal completed before mkdir effect")
					return
				}
				if owners.connector && owners.execution.TryLock() {
					owners.execution.Unlock()
					t.Error("execution gate released before mkdir")
				}
				withdrawn = make(chan struct{})
				attempted := make(chan struct{})
				go func() { close(attempted); owners.withdraw(); close(withdrawn) }()
				<-attempted
			}}
			f.onSync = func(_ *fakeNode) error {
				// Force withdrawal to finish after this authorized mkdir, before
				// another parent or the target file can be published. Sync is out
				// of the owner gate, so this join also detects an overlong gate.
				if withdrawn != nil {
					<-withdrawn
				}
				if !owners.access.TryLock() {
					t.Fatal("directory sync held owner gate")
				}
				owners.access.Unlock()
				return nil
			}
			_ = execute()
			if journal.record == nil || journal.record.Phase() != mutation.OutcomeUnknown || f.mkdirs != 1 || f.links+f.swaps != 0 {
				t.Fatal("partial directory effect lost, repeated or completed after withdrawal")
			}
			nested := f.work.children["nested"]
			if nested == nil || len(nested.children) != 0 {
				t.Fatal("authorized parent lost or later path created")
			}
			_ = execute()
			if journal.admissions != 1 || journal.saves != 1 || f.mkdirs != 1 {
				t.Fatal("partial effect retried")
			}
		})
	}
}

func TestMutationParentPublicationPureRechecksWithdrawnAuthority(t *testing.T) {
	m, f := fakeMutable()
	request := fakeRequest(mutation.Write{RelativePath: "nested/note.md", Content: "new"})
	checks := 0
	withdrawn := false
	request.BeforePublish = func(context.Context) error {
		checks++
		if checks == 2 {
			withdrawn = true
		} // Withdrawal after the old pre-mkdir validation.
		return nil
	}
	request.WithPublication = func(_ context.Context, publish func() error) error {
		if withdrawn {
			return authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-approval")
		}
		return publish()
	}
	_, err := m.Mutate(context.Background(), request)
	nativeCode(t, err, "COMPUTER_APPROVAL_NOT_FOUND")
	if f.mkdirs != 0 || f.links+f.swaps != 0 || f.work.children["nested"] != nil {
		t.Fatal("directory after withdrawn authority")
	}
}

func TestMutationParentPublicationPureGuardFailuresNeverRetry(t *testing.T) {
	for _, name := range []string{"known refusal", "unknown mkdir", "lost guard ACK", "repeated guard", "late guard"} {
		t.Run(name, func(t *testing.T) {
			m, f := fakeMutable()
			request := fakeRequest(mutation.Write{RelativePath: "nested/note.md", Content: "new"})
			var late func() error
			if name == "known refusal" {
				f.onMkdir = func(string) error { return unix.EACCES }
			}
			if name == "unknown mkdir" {
				f.onMkdir = func(string) error { return errors.New("unknown mkdir ACK") }
			}
			request.WithPublication = func(_ context.Context, publish func() error) error {
				switch name {
				case "lost guard ACK":
					_ = publish()
					return errors.New("lost guard ACK")
				case "repeated guard":
					_ = publish()
					return publish()
				case "late guard":
					late = publish
					return nil
				}
				return publish()
			}
			_, err := m.Mutate(context.Background(), request)
			want := "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
			if name == "known refusal" || name == "late guard" {
				want = "WORKSPACE_PATH_REFUSED"
			}
			nativeCode(t, err, want)
			if late != nil && late() == nil {
				t.Fatal("late mkdir callback accepted")
			}
			attempts := 1
			if name == "late guard" {
				attempts = 0
			}
			if f.mkdirs != attempts || f.links+f.swaps != 0 || f.unlinks != 0 {
				t.Fatal("directory attempt replayed or evidence removed")
			}
		})
	}
}

func TestMutationParentPublicationPurePreparationOutsideOwnerGate(t *testing.T) {
	for _, route := range []string{"settings", "connector"} {
		t.Run(route, func(t *testing.T) {
			_, f, owners, journal, execute := publicationFixture(t, route, "create", "nested/note.md")
			f.onMkdir = func(name string) error {
				if name == "nested" {
					if owners.access.TryLock() {
						owners.access.Unlock()
						t.Fatal("workspace mkdir unguarded")
					}
				} else if !owners.access.TryLock() {
					t.Fatal("private staging mkdir held owner gate")
				} else {
					owners.access.Unlock()
				}
				return nil
			}
			f.onSync = func(*fakeNode) error {
				if !owners.access.TryLock() {
					t.Fatal("preparation/sync held owner gate")
				}
				owners.access.Unlock()
				return nil
			}
			if err := execute(); err != nil {
				t.Fatal(err)
			}
			if journal.record.Phase() != mutation.Completed || f.mkdirs != 2 || f.links != 1 {
				t.Fatal("nested create failed")
			}
		})
	}
}
