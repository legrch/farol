package browse

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	app "github.com/legrch/farol/modules/computer/app/services/browse"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Contract mapping fixtures are not evidence of native filesystem behavior.
type snapshotReader struct {
	calls  int
	output *port.ReadResponse
	err    error
}

func (n *snapshotReader) Read(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	n.calls++
	if r.Range != nil {
		panic("ranged snapshot")
	}
	return n.output, n.err
}
func (*snapshotReader) List(context.Context, port.ListRequest) (*port.ListResponse, error) {
	panic("snapshot listing")
}
func snapshotContract(n *snapshotReader) *Contract {
	a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7,
		Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "12", Inode: "34"}}},
		Capabilities: []authority.Capability{authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock{}.Now().Add(time.Hour)}
	return New(app.New(current{a}, n, clock{}))
}
func TestSnapshotIndependentMetadataDTO(t *testing.T) {
	raw := "\ufeffprivate é😀"
	digest := sha256.Sum256([]byte(raw))
	hash := hex.EncodeToString(digest[:])
	n := &snapshotReader{output: &port.ReadResponse{Text: strings.TrimPrefix(raw, "\ufeff"), Bytes: uint64(len(raw)), SHA256: hash}}
	req := SnapshotRequest{WorkspaceID: "work", RelativePath: "file.txt"}
	out, err := snapshotContract(n).Snapshot(context.Background(), req)
	if err != nil || out == nil || out.WorkspaceID != req.WorkspaceID || out.RelativePath != req.RelativePath || out.Root != (Root{Path: "/work", Device: "12", Inode: "34"}) || out.Bytes != uint64(len(raw)) || out.SHA256 != hash || n.calls != 1 {
		t.Fatalf("%+v %v", out, err)
	}
	encoded, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 5 || fields["WorkspaceID"] == nil || fields["RelativePath"] == nil || fields["Root"] == nil || fields["Bytes"] == nil || fields["SHA256"] == nil || strings.Contains(string(encoded), "private") {
		t.Fatalf("metadata projection: %s", encoded)
	}
	if reflect.TypeFor[SnapshotResponse]() == reflect.TypeFor[app.SnapshotResult]() || reflect.TypeFor[SnapshotRequest]() == reflect.TypeFor[app.ListQuery]() || reflect.TypeFor[Root]() == reflect.TypeFor[port.Root]() {
		t.Fatal("implementation DTO escaped")
	}
	n.output.Bytes = 0
	n.output.SHA256 = "changed"
	out.Root.Path = "/caller"
	if out.Bytes != uint64(len(raw)) || out.SHA256 != hash {
		t.Fatal("shared native output")
	}
}
func TestSnapshotContractFailures(t *testing.T) {
	var typedNil *authority.Failure
	cases := []struct {
		err          error
		code, source string
	}{
		{authority.Fail("WORKSPACE_FILE_TOO_LARGE", "native-workspace"), "WORKSPACE_FILE_TOO_LARGE", "native-workspace"},
		{authority.Fail("WORKSPACE_NOT_TEXT", "native-workspace"), "WORKSPACE_NOT_TEXT", "native-workspace"},
		{authority.Fail("WORKSPACE_NOT_A_FILE", "native-workspace"), "WORKSPACE_NOT_A_FILE", "native-workspace"},
		{fmt.Errorf("private wrapper: %w", authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace")), "WORKSPACE_ROOT_CHANGED", "native-workspace"},
		{&authority.Failure{Code: "WORKSPACE_PATH_REFUSED", Source: "native-workspace", Retry: "private retry"}, "WORKSPACE_PATH_REFUSED", "native-workspace"},
		{errors.New("private /path diagnostics"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{authority.Fail("PRIVATE_CODE", "native-workspace"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{authority.Fail("WORKSPACE_NOT_TEXT", "private source"), "WORKSPACE_HELPER_FAILED", "native-workspace"},
		{typedNil, "WORKSPACE_HELPER_FAILED", "native-workspace"},
	}
	for i, tc := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			n := &snapshotReader{err: tc.err, output: &port.ReadResponse{Text: "private"}}
			out, err := snapshotContract(n).Snapshot(context.Background(), SnapshotRequest{WorkspaceID: "work", RelativePath: "file.txt"})
			var f *Failure
			if out != nil || !errors.As(err, &f) || f == nil || f.Code != tc.code || f.Source != tc.source || f.Retry != "never" || strings.Contains(err.Error(), "private") || n.calls != 1 {
				t.Fatalf("%+v %v", out, err)
			}
		})
	}
	for _, c := range []*Contract{nil, New(nil)} {
		out, err := c.Snapshot(context.Background(), SnapshotRequest{})
		var f *Failure
		if out != nil || !errors.As(err, &f) || f.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || f.Source != "authority-store" || f.Retry != "never" {
			t.Fatalf("%+v %v", out, err)
		}
	}
	t.Run("nil native output", func(t *testing.T) {
		out, err := snapshotContract(&snapshotReader{}).Snapshot(context.Background(), SnapshotRequest{WorkspaceID: "work", RelativePath: "file.txt"})
		var f *Failure
		if out != nil || !errors.As(err, &f) || f.Code != "WORKSPACE_HELPER_FAILED" {
			t.Fatalf("%+v %v", out, err)
		}
	})
}
