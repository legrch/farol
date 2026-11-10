//go:build !darwin

package lease

import (
	"context"
	domain "github.com/legrch/farol/modules/computer/domain/lease"
)

// No Linux/macOS-image/unknown-host fallback for native startup provenance.
type unsupportedOperations struct{}

func newNative() ops { return unsupportedOperations{} }
func (unsupportedOperations) openRoot() (int, error) {
	return -1, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
}
func (unsupportedOperations) openAt(int, string) (int, error) {
	return -1, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
}
func (unsupportedOperations) stat(int) (file, error) {
	return file{}, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
}
func (unsupportedOperations) mount(int) (domain.Mount, error) {
	return domain.Mount{}, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
}
func (unsupportedOperations) metadata(context.Context, string) (domain.Metadata, error) {
	return domain.Metadata{}, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
}
func (unsupportedOperations) epoch(context.Context) (domain.Epoch, error) {
	return domain.Epoch{}, refusal("WORKSPACE_ANCHOR_UNSUPPORTED")
}
func (unsupportedOperations) close(int) error { return refusal("WORKSPACE_ANCHOR_UNSUPPORTED") }
