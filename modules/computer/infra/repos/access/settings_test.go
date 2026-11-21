package access

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	observationport "github.com/legrch/farol/modules/computer/app/port/observation"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/journal"
)

type currentConsentVector struct {
	Projection, SHA256 string
}

func loadConsentVector(t *testing.T) currentConsentVector {
	t.Helper()
	raw, err := os.ReadFile("../../../../../tests/fixtures/owner-computer-consent.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector currentConsentVector
	if err := json.Unmarshal(raw, &vector); err != nil || vector.Projection == "" || vector.SHA256 == "" {
		t.Fatal("invalid shared consent vector", err)
	}
	return vector
}

func TestSettingsCurrentReaderHashesDesktopConsentVector(t *testing.T) {
	vector := loadConsentVector(t)
	if digest := currentConsentDigest(vector.Projection); digest != vector.SHA256 {
		t.Fatalf("Go consent digest %s differs from the desktop digest %s", digest, vector.SHA256)
	}
}

func currentSettingsFixture(t *testing.T) (journal.Entry, authority.Approval, observationport.CurrentSettings) {
	t.Helper()
	vector := loadConsentVector(t)
	const workspace = "77000000-0000-4000-8000-000000000001"
	const root = "/Users/fixture/🪔 <workspace>"
	const computer = "77000000-0000-4000-8000-000000000003"
	entry := journal.Entry{
		Request: journal.Request{ProfileID: "profile", OwnerID: "owner-desktop", ComputerID: computer, WorkspaceID: workspace, Root: root, ConsentDigest: vector.SHA256},
		Phase:   journal.Committed, Certificate: &journal.Certificate{Kind: journal.Committed},
	}
	identity := authority.RootIdentity{Device: "17", Inode: "50"}
	snapshot := observationport.CurrentSettings{
		ProfileID: "profile", OwnerID: "owner-desktop", ComputerID: computer, WorkspaceID: workspace,
		Root: root, RootIdentity: identity, Revision: 8, Generation: 4, ConsentProjection: vector.Projection,
		Evidence: []byte(`{"schema":"farol.workspace-root-candidate/1","filesystem":"apfs","volumeUuid":"11111111-2222-3333-4444-555555555555","fileId":"50","birthSeconds":"10","birthNanoseconds":"7"}`),
	}
	proposed := authority.Approval{
		OwnerID: snapshot.OwnerID, ComputerID: computer, Generation: snapshot.Generation,
		Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: workspace, Root: root, RootIdentity: identity}},
	}
	return entry, proposed, snapshot
}

func TestSettingsCurrentReaderSelectsExactJournalWorkspace(t *testing.T) {
	entry, proposed, snapshot := currentSettingsFixture(t)
	calls := 0
	reader := SettingsCurrentReader(func(_ context.Context, workspace string) (observationport.CurrentSettings, error) {
		calls++
		if workspace != entry.Request.WorkspaceID {
			t.Fatalf("crossed workspace %q", workspace)
		}
		return snapshot, nil
	})
	proof, err := reader.ReadQualified(context.Background(), entry, proposed)
	if err != nil || calls != 1 || proof.SettingsRevision != 8 || proof.ComputerGeneration != 4 ||
		proof.ConsentDigest != entry.Request.ConsentDigest || proof.Saved.Binding.Path != entry.Request.Root ||
		proof.Saved.Binding.Device != "17" || proof.Saved.Binding.Inode != "50" ||
		proof.Saved.Evidence == nil || proof.Saved.Evidence.FileID != "50" {
		t.Fatalf("current readback mismatch: %+v, %v", proof, err)
	}
}

func TestSettingsCurrentReaderRefusesCrossedOrUnsettledReadback(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*observationport.CurrentSettings, *authority.Approval, *journal.Entry)
	}{
		{"pending effect", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) { s.Unsettled = true }},
		{"missing revision", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) { s.Revision = 0 }},
		{"wrong generation", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) { s.Generation++ }},
		{"another profile", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.ProfileID = "other"
		}},
		{"another owner", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) { s.OwnerID = "other" }},
		{"another computer", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.ComputerID = "other"
		}},
		{"another workspace", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.WorkspaceID = "other"
		}},
		{"another root", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.Root = "/Users/other"
		}},
		{"different consent", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.ConsentProjection += " "
		}},
		{"no consent", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.ConsentProjection = ""
		}},
		{"unbound root", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.RootIdentity = authority.RootIdentity{}
		}},
		{"different device", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.RootIdentity.Device = "18"
		}},
		{"different inode", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.RootIdentity.Inode = "51"
		}},
		{"noncanonical device", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.RootIdentity.Device = "017"
		}},
		{"missing evidence", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) { s.Evidence = nil }},
		{"malformed evidence", func(s *observationport.CurrentSettings, _ *authority.Approval, _ *journal.Entry) {
			s.Evidence = append(s.Evidence, []byte("{}")...)
		}},
		{"no approved workspace", func(_ *observationport.CurrentSettings, a *authority.Approval, _ *journal.Entry) { a.Workspaces = nil }},
		{"duplicate workspace", func(_ *observationport.CurrentSettings, a *authority.Approval, _ *journal.Entry) {
			a.Workspaces = append(a.Workspaces, a.Workspaces[0])
		}},
		{"carried shell verification", func(_ *observationport.CurrentSettings, a *authority.Approval, _ *journal.Entry) {
			a.Workspaces[0].ShellVerified = true
		}},
		{"unsettled transition", func(_ *observationport.CurrentSettings, _ *authority.Approval, e *journal.Entry) {
			e.Phase = journal.Intent
		}},
		{"missing certificate", func(_ *observationport.CurrentSettings, _ *authority.Approval, e *journal.Entry) { e.Certificate = nil }},
		{"discharged transition", func(_ *observationport.CurrentSettings, _ *authority.Approval, e *journal.Entry) {
			e.DischargedBy = "successor"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry, proposed, snapshot := currentSettingsFixture(t)
			tc.edit(&snapshot, &proposed, &entry)
			reader := SettingsCurrentReader(func(context.Context, string) (observationport.CurrentSettings, error) { return snapshot, nil })
			if proof, err := reader.ReadQualified(context.Background(), entry, proposed); !errors.Is(err, journal.ErrRefused) || proof != (CurrentReaderProof{}) {
				t.Fatalf("invalid Settings readback was not refused: %+v, %v", proof, err)
			}
		})
	}
}

func TestSettingsCurrentReaderRequiresAvailableExchange(t *testing.T) {
	entry, proposed, _ := currentSettingsFixture(t)
	ctx := context.Background()
	var absent SettingsCurrentReader
	if _, err := absent.ReadQualified(ctx, entry, proposed); !errors.Is(err, journal.ErrRefused) {
		t.Fatal("absent reader", err)
	}
	for _, expected := range []error{journal.ErrRefused, journal.ErrUnknown} {
		reader := SettingsCurrentReader(func(context.Context, string) (observationport.CurrentSettings, error) {
			return observationport.CurrentSettings{}, expected
		})
		if proof, err := reader.ReadQualified(ctx, entry, proposed); err != expected || proof != (CurrentReaderProof{}) {
			t.Fatalf("exchange outcome changed: %+v, %v", proof, err)
		}
	}
}
