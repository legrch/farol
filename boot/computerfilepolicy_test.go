package boot

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

type searchFileOwnerDouble struct {
	fileOwnerDouble
	calls    int
	ctx      context.Context
	request  port.SearchRequest
	response *port.SearchResponse
	err      error
}

func (d *searchFileOwnerDouble) Search(ctx context.Context, request port.SearchRequest) (*port.SearchResponse, error) {
	d.calls++
	d.ctx, d.request = ctx, request
	return d.response, d.err
}

func TestComputerFileOwnersSearchPreservesSelectedProducer(t *testing.T) {
	for _, policy := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		t.Run(string(policy), func(t *testing.T) {
			legacy, root := &searchFileOwnerDouble{}, &searchFileOwnerDouble{}
			owners := &computerFileOwners{legacyRead: legacy, rootRead: root}
			chosen, unused := legacy, root
			if policy == authority.RootScopedFiles {
				chosen, unused = root, legacy
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			request := port.SearchRequest{Workspace: port.Descriptor{FilePolicy: policy, Root: "/synthetic/work", ApprovedRoot: port.Root{Path: "/synthetic/work", Device: "1", Inode: "2"}, DeniedPaths: []string{"private"}, ExactFilePaths: []string{"selected"}}, RelativePath: "selected", Pattern: "Farol"}
			chosen.response = &port.SearchResponse{}
			result, err := owners.Search(ctx, request)
			if err != nil || result != chosen.response || chosen.calls != 1 || unused.calls != 0 || chosen.ctx != ctx || !reflect.DeepEqual(chosen.request, request) {
				t.Fatal("search lost policy, request, context or result")
			}
			chosen.err = errors.New("selected failure")
			if _, err := owners.Search(ctx, request); err != chosen.err || unused.calls != 0 {
				t.Fatal("search failure changed or fell back")
			}
		})
	}
}

func TestComputerFileOwnersSearchRefusesMissingCapabilityAndUnknownPolicy(t *testing.T) {
	unused := &searchFileOwnerDouble{}
	owners := &computerFileOwners{legacyRead: &fileOwnerDouble{}, rootRead: unused}
	for _, policy := range []authority.FilePolicy{authority.LegacyProtectedFiles, "unknown"} {
		if _, err := owners.Search(context.Background(), port.SearchRequest{Workspace: port.Descriptor{FilePolicy: policy}}); err == nil {
			t.Fatal("missing capability or invalid policy accepted")
		}
	}
	if unused.calls != 0 {
		t.Fatal("refused search fell back")
	}
}

// Adapter routing doubles only; native descriptor/CAS evidence is separate.
type fileOwnerDouble struct {
	reads, lists, mutations int
	descriptor              port.Descriptor
	mutation                port.MutationRequest
}

func (d *fileOwnerDouble) Read(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
	d.reads++
	d.descriptor = r.Workspace
	return &port.ReadResponse{Text: "synthetic"}, nil
}
func (d *fileOwnerDouble) List(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
	d.lists++
	d.descriptor = r.Workspace
	return &port.ListResponse{}, nil
}
func (d *fileOwnerDouble) Mutate(_ context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
	d.mutations++
	d.mutation = r
	return &port.MutationReceipt{}, nil
}

func TestComputerFileOwnersSelectSameCapturedModeWithoutDroppingRestrictions(t *testing.T) {
	for _, mode := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		legacy, root := &fileOwnerDouble{}, &fileOwnerDouble{}
		owners := &computerFileOwners{legacyRead: legacy, rootRead: root, legacyMutation: legacy, rootMutation: root}
		d := port.Descriptor{FilePolicy: mode, Root: "/synthetic/work", ApprovedRoot: port.Root{Path: "/synthetic/work", Device: "1", Inode: "2"}, DeniedPaths: []string{"private"}, ExactFilePaths: []string{"selected"}}
		if _, err := owners.Read(context.Background(), port.ReadRequest{Workspace: d, RelativePath: "selected"}); err != nil {
			t.Fatal(err)
		}
		if _, err := owners.List(context.Background(), port.ListRequest{Workspace: d, RelativePath: "."}); err != nil {
			t.Fatal(err)
		}
		md := port.MutationDescriptor{FilePolicy: mode, Root: d.Root, ApprovedRoot: d.ApprovedRoot, DeniedPaths: d.DeniedPaths, WriteDeniedPaths: []string{"readonly"}}
		r := port.MutationRequest{Workspace: md, Operation: mutation.Write{RelativePath: "selected", Content: "synthetic"}, BeforePublish: func(context.Context) error { return nil }}
		if _, err := owners.Mutate(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		chosen, unused := legacy, root
		if mode == authority.RootScopedFiles {
			chosen, unused = root, legacy
		}
		if chosen.reads != 1 || chosen.lists != 1 || chosen.mutations != 1 || unused.reads+unused.lists+unused.mutations != 0 || !reflect.DeepEqual(chosen.descriptor, d) || !reflect.DeepEqual(chosen.mutation.Workspace, md) || chosen.mutation.BeforePublish == nil || !reflect.DeepEqual(chosen.mutation.Operation, r.Operation) {
			t.Fatal("policy route fell back or lost the original descriptor/guard")
		}
	}
}

func TestComputerFileOwnersUnknownPolicyNeverTouchesAProducer(t *testing.T) {
	d := &fileOwnerDouble{}
	owners := &computerFileOwners{legacyRead: d, rootRead: d, legacyMutation: d, rootMutation: d}
	if _, err := owners.Read(context.Background(), port.ReadRequest{Workspace: port.Descriptor{FilePolicy: "unknown"}}); err == nil {
		t.Fatal("unknown read policy accepted")
	}
	if _, err := owners.List(context.Background(), port.ListRequest{Workspace: port.Descriptor{FilePolicy: "unknown"}}); err == nil {
		t.Fatal("unknown list policy accepted")
	}
	if _, err := owners.Mutate(context.Background(), port.MutationRequest{Workspace: port.MutationDescriptor{FilePolicy: "unknown"}}); err == nil {
		t.Fatal("unknown mutation policy accepted")
	}
	if d.reads+d.lists+d.mutations != 0 {
		t.Fatal("unknown policy reached a producer")
	}
	if _, err := newComputerFileOwners("../invalid"); err == nil {
		t.Fatal("invalid trusted home accepted")
	}
}
