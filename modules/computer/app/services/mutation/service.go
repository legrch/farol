// Package mutation owns pure request checking. Execution/journal orchestration
// and the native effect handoff are deliberately absent from this first slice.
package mutation

type Service struct{}

func New() *Service { return &Service{} }
