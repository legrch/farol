package boot

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	"github.com/legrch/farol/transport/desktop"
)

// Real root/application/contract with controlled authority and native ports.
// No Chat service, participants, native filesystem or provider is constructed.
type settingsStoreFixture struct {
	*chatComputerStore
	after func()
}

func (s *settingsStoreFixture) WithOwnerApproval(ctx context.Context, inspect func(accessrepo.Status, *authority.Approval) error) error {
	a := s.approval.Clone()
	err := inspect(accessrepo.Status{Revision: s.revision, Generation: a.Generation, ApprovalPresent: true}, &a)
	if s.after != nil {
		s.after()
	}
	return err
}

type settingsNativeFixture struct {
	calls int
	after func()
}

func (*settingsNativeFixture) Read(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
	return nil, errors.New("unexpected read")
}
func (n *settingsNativeFixture) List(_ context.Context, request port.ListRequest) (*port.ListResponse, error) {
	n.calls++
	if n.after != nil {
		n.after()
	}
	return &port.ListResponse{Binding: &port.DirectoryBinding{Root: request.Workspace.Root, ApprovedRoot: request.Workspace.ApprovedRoot, RelativePath: request.RelativePath}, Entries: []string{"note.md", "folder/"}}, nil
}

func settingsFixture(t *testing.T) (*ComputerIngress, *settingsStoreFixture, *settingsNativeFixture, wire.ComputerSettingsListRequest) {
	t.Helper()
	clock := &computerClockFixture{now: time.UnixMilli(1900000000000)}
	a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3,
		Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/disposable", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}},
		Capabilities: []authority.Capability{authority.List}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock.Now().Add(time.Hour)}
	store := &settingsStoreFixture{chatComputerStore: &chatComputerStore{Repository: accessrepo.New(), approval: a.Clone(), clock: clock, revision: 4}}
	native := &settingsNativeFixture{}
	publication := wire.ComputerAuthorityPublication{Fence: "1", StoreRevision: "4", SettingsRevision: "8", Generation: "3", ApprovalDigest: strings.Repeat("a", 64), PublishOperationId: "publication"}
	root := &ComputerIngress{store: store, native: native, clock: clock, ownerID: "owner", computerID: "computer", peer: wire.Context{ProfileId: "profile", BackendGeneration: "backend"}, publication: &knownComputerPublication{receipt: publication, approval: a.Clone()}}
	if _, err := root.guard.deactivate(); err != nil {
		t.Fatal(err)
	}
	return root, store, native, wire.ComputerSettingsListRequest{Publication: publication, WorkspaceId: "work", RelativePath: "."}
}

func TestSettingsListUsesPublishedOwnerWithoutChatAdmission(t *testing.T) {
	root, store, native, request := settingsFixture(t)
	// A real Chat admission may have advanced the same store before Settings.
	// Its existence is neither required nor fabricated by this owner call.
	store.revision++
	root.guard.active = true
	body, _ := json.Marshal(request)
	out, err := root.Methods()["computer.settings.list"].Handle(context.Background(), desktop.Request{RequestID: "request", Body: body})
	if err != nil || out == nil || out.Status != "ok" || wire.Validate("ComputerSettingsListResponse", out.Data) != nil {
		t.Fatalf("owner list: %+v %v", out, err)
	}
	var result wire.ComputerSettingsListResponse
	if err := json.Unmarshal(out.Data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Publication != request.Publication || result.WorkspaceId != request.WorkspaceId || result.Root.Device != "1" || string(result.Entries) != `["note.md","folder/"]` || native.calls != 1 {
		t.Fatalf("crossed list: %+v, calls=%d", result, native.calls)
	}
	if root.chat != nil || store.admits != 0 || len(root.tasks) != 0 || len(root.turns) != 0 || store.revision != 5 || root.readFacade != nil {
		t.Fatal("Settings fabricated Chat/Task membership or changed authority")
	}
}

func TestSettingsListRejectsCrossedPublicationBeforeIO(t *testing.T) {
	for _, field := range []string{"fence", "revision", "settings", "generation", "digest", "operation", "workspace"} {
		t.Run(field, func(t *testing.T) {
			root, _, native, request := settingsFixture(t)
			switch field {
			case "fence":
				request.Publication.Fence = "2"
			case "revision":
				request.Publication.StoreRevision = "5"
			case "settings":
				request.Publication.SettingsRevision = "9"
			case "generation":
				request.Publication.Generation = "4"
			case "digest":
				request.Publication.ApprovalDigest = strings.Repeat("b", 64)
			case "operation":
				request.Publication.PublishOperationId = "other"
			case "workspace":
				request.WorkspaceId = "outside"
			}
			out, err := root.settingsList(context.Background(), request)
			if err == nil || out != nil || native.calls != 0 {
				t.Fatalf("crossed %s reached IO: %+v %v calls=%d", field, out, err, native.calls)
			}
		})
	}
}

func TestSettingsListRechecksOriginalOwnerAfterNativeIO(t *testing.T) {
	for _, change := range []string{"withdraw", "revision", "root", "exclusion", "owner", "computer", "expiry", "unknown", "publication"} {
		t.Run(change, func(t *testing.T) {
			root, store, native, request := settingsFixture(t)
			native.after = func() {
				switch change {
				case "withdraw":
					_, _ = root.guard.deactivate()
				case "revision":
					store.revision++
				case "root":
					store.approval.Workspaces[0].RootIdentity.Inode = "other"
				case "exclusion":
					store.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/disposable/note.md"}}
				case "owner":
					store.approval.OwnerID = "other"
				case "computer":
					store.approval.ComputerID = "other"
				case "expiry":
					store.approval.ExpiresAt = store.approval.ExpiresAt.Add(time.Minute)
				case "unknown":
					root.unknown = true
				case "publication":
					root.publication.receipt.PublishOperationId = "new"
				}
			}
			out, err := root.settingsList(context.Background(), request)
			if err == nil || out != nil || native.calls != 1 {
				t.Fatalf("late %s disclosed: %+v %v calls=%d", change, out, err, native.calls)
			}
		})
	}
}

func TestSettingsListRejectsWithdrawalBeforeIOAndMalformedWire(t *testing.T) {
	root, _, native, request := settingsFixture(t)
	_, _ = root.guard.deactivate()
	if out, err := root.settingsList(context.Background(), request); err == nil || out != nil || native.calls != 0 {
		t.Fatal("withdrawn owner reached IO")
	}
	method := root.Methods()["computer.settings.list"]
	for _, body := range []string{`{}`, `{"publication":null}`, `{"workspaceId":"work","workspaceId":"other"}`} {
		out, err := method.Handle(context.Background(), desktop.Request{RequestID: "request", Body: json.RawMessage(body)})
		if err != nil || out == nil || out.Status != "refused" || native.calls != 0 {
			t.Fatalf("invalid boundary accepted: %+v %v", out, err)
		}
	}
}
