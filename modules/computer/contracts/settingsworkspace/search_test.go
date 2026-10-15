package settingsworkspace

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	app "github.com/legrch/farol/modules/computer/app/services/settingsworkspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type searchNative struct {
	*native
	output *port.SearchResponse
	err    error
}

func (n *searchNative) Search(_ context.Context, r port.SearchRequest) (*port.SearchResponse, error) {
	if n.err != nil {
		return nil, n.err
	}
	n.output.Binding = &port.DirectoryBinding{Root: r.Workspace.Root, RelativePath: r.RelativePath, ApprovedRoot: r.Workspace.ApprovedRoot}
	return n.output, nil
}

func TestOwnerSearchContractMappingAndFailure(t *testing.T) {
	for _, mode := range []string{"matches", "empty", "timeout", "private-error"} {
		t.Run(mode, func(t *testing.T) {
			n := &searchNative{native: &native{}, output: &port.SearchResponse{Matches: []port.SearchMatch{{Path: "note.md", Line: 2, Text: "match", Truncated: true}}, ResultLimited: true}}
			switch mode {
			case "empty":
				n.output.Matches = nil
			case "timeout":
				n.err = authority.Fail("WORKSPACE_SEARCH_TIMEOUT", "native-workspace")
			case "private-error":
				n.err = errors.New("private diagnostics must not leave the contract")
			}
			a := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 7,
				Workspaces:   []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/work", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "12", Inode: "34"}}},
				Capabilities: []authority.Capability{authority.Search}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock{}.Now().Add(time.Hour)}
			c := New(app.New(current{a}, n, clock{}))
			out, err := c.Search(context.Background(), SearchRequest{WorkspaceID: "work", RelativePath: ".", Pattern: "match"})
			if n.err != nil {
				code := "WORKSPACE_HELPER_FAILED"
				if mode == "timeout" {
					code = "WORKSPACE_SEARCH_TIMEOUT"
				}
				var failure *Failure
				if out != nil || !errors.As(err, &failure) || failure.Code != code || failure.Retry != "never" {
					t.Fatal(out, err)
				}
				return
			}
			if err != nil || out == nil || out.WorkspaceID != "work" || out.Pattern != "match" || out.Root != (Root{Path: "/work", Device: "12", Inode: "34"}) || out.Matches == nil || !out.ResultLimited {
				t.Fatal(out, err)
			}
			if mode == "matches" {
				n.output.Matches[0].Text = "changed"
				if out.Matches[0].Text != "match" {
					t.Fatal("aliased output")
				}
			}
			if reflect.TypeFor[SearchMatch]() == reflect.TypeFor[port.SearchMatch]() || reflect.TypeFor[SearchResult]() == reflect.TypeFor[app.SearchResult]() {
				t.Fatal("internal DTO leaked")
			}
		})
	}
}

func TestOwnerSearchNilContract(t *testing.T) {
	for _, c := range []*Contract{nil, New(nil)} {
		out, err := c.Search(context.Background(), SearchRequest{})
		var f *Failure
		if out != nil || !errors.As(err, &f) || f.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" {
			t.Fatal(out, err)
		}
	}
}
