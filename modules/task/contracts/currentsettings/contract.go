// Package currentsettings publishes a pure Task comparison with no authority.
package currentsettings

import (
	"context"

	app "github.com/legrch/farol/modules/task/app/services/currentsettings"
)

type Request struct{ Before, Candidate []byte }
type Response struct{ Changed bool }
type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

type Contract struct{ service *app.Service }

func New(service *app.Service) *Contract { return &Contract{service: service} }

func (c *Contract) Compare(ctx context.Context, in Request) (*Response, error) {
	if c == nil || c.service == nil || ctx == nil || ctx.Err() != nil {
		return nil, &Failure{Code: app.Unavailable}
	}
	if len(in.Before) > app.MaxSnapshotBytes || len(in.Candidate) > app.MaxSnapshotBytes {
		return nil, &Failure{Code: app.Invalid}
	}
	before := append([]byte(nil), in.Before...)
	candidate := append([]byte(nil), in.Candidate...)
	changed, err := c.service.Compare(ctx, before, candidate)
	if ctx.Err() != nil {
		return nil, &Failure{Code: app.Unavailable}
	}
	if err != nil {
		if failure, ok := err.(*app.Failure); ok && failure.Code == app.Invalid {
			return nil, &Failure{Code: app.Invalid}
		}
		return nil, &Failure{Code: app.Unavailable}
	}
	return &Response{Changed: changed}, nil
}
