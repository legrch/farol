package port

import "context"

// Search is an optional consumer capability. It does not widen Workspace or
// acquire authority; composition supplies it through the same workspace adapter.
type Search interface {
	Search(context.Context, SearchRequest) (*SearchResponse, error)
}

type SearchRequest struct {
	Workspace             Descriptor
	RelativePath, Pattern string
}
type SearchMatch struct {
	Path      string
	Line      uint64
	Text      string
	Truncated bool
}
type SearchResponse struct {
	// Binding is observed by the native boundary, not copied from policy alone.
	Binding                    *DirectoryBinding
	Matches                    []SearchMatch
	ResultLimited, ScanLimited bool
}
