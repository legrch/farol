// Package port defines consumer-owned Computer application dependencies.
package port

import (
	"context"

	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

type Root struct{ Path, Device, Inode string }

// FilePolicy is selected from a trusted current approval/grant snapshot. It is
// never a caller selector; native composition must use the same policy meaning.
type Descriptor struct {
	FilePolicy                  authority.FilePolicy
	WorkspaceID, Root           string
	ApprovedRoot                Root
	DeniedPaths, ExactFilePaths []string
}

// A nil ExactFilePaths grants a subtree; a nonnil empty slice grants no files.
// The native boundary must verify ApprovedRoot and all physical path facts.
type Range struct {
	Offset uint64
	Length uint32
}
type Page struct {
	Offset, Size uint64
	NextOffset   *uint64
}
type ReadRequest struct {
	Workspace    Descriptor
	RelativePath string
	Range        *Range
}
type ReadResponse struct {
	Text   string
	Bytes  uint64
	SHA256 string
	Page   *Page
}
type ListRequest struct {
	Workspace    Descriptor
	RelativePath string
}

// DirectoryBinding is returned only after the native directory/root checks.
// It is not a policy-only context or proof that a bounded listing is complete.
type DirectoryBinding struct {
	RelativePath string
	Root         string
	ApprovedRoot Root
}

type ListResponse struct {
	Binding   *DirectoryBinding
	Entries   []string
	Truncated bool
}
type Workspace interface {
	Read(context.Context, ReadRequest) (*ReadResponse, error)
	List(context.Context, ListRequest) (*ListResponse, error)
}

// ScratchReadBinding is supplied only by the private diagnostic owner holding
// both original descriptors. It grants no workspace authority.
type ScratchReadBinding struct {
	RunID           string
	Directory, File mutation.DirectoryIdentity
	DirectoryHold   ScratchDirectoryCustody
	FileHold        ScratchFileCustody
}

type ScratchBoundWorkspace interface {
	ReadScratch(context.Context, ReadRequest, ScratchReadBinding) (*ReadResponse, error)
}
type ScratchBoundList interface {
	ListScratch(context.Context, ListRequest, ScratchReadBinding) (*ListResponse, error)
}
type ScratchBoundSearch interface {
	SearchScratch(context.Context, SearchRequest, ScratchReadBinding) (*SearchResponse, error)
}

// DirectoryInspector checks a selected physical directory without listing its
// contents. It proves access and binding, not a stable directory snapshot.
type DirectoryInspector interface {
	Inspect(context.Context, ListRequest) (*DirectoryBinding, error)
}
