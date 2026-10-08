// Package selectedthread publishes a read-only, exact native thread/turn surface.
// Selection is trusted composition, never request-supplied authority. Provider
// history and retained Task-journal results remain independent evidence.
package selectedthread

import (
	"context"

	"github.com/legrch/farol/modules/task/contracts/control"
)

// Selection uses independent consumer DTOs. Physical roots, profile, host,
// project, writer, model/effort and the exact thread/turn are all immutable.
type Selection struct {
	Binding   control.Binding
	Reference control.Reference
}

// Request cannot select paths, sockets, projects, models, threads or turns.
type Request struct{ IncludeResult bool }

type Response struct {
	Selection      Selection
	Lifecycle      control.Lifecycle
	Text           string
	Source         string
	Snapshot       string
	Retained       bool
	ResultEvidence string
}

type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

// Reader exposes no adoption, admission, dispatch, delivery or active control.
// Provider readers return Retained=false. For retained results, use the existing
// observation.Contract on the SAME owning Task service and exact dispatch.
type Reader interface {
	Read(context.Context, Request) (*Response, error)
}
