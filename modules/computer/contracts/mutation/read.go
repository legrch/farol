package mutation

import "context"

type ReadRequest = CheckRequest
type ReadResponse = ExecuteResponse

func (c *Contract) Read(ctx context.Context, r ReadRequest) (*ReadResponse, error) {
	if c == nil || c.service == nil {
		return nil, boundary(nil)
	}
	out, err := c.service.Read(ctx, toApp(r))
	if err != nil || out == nil {
		return nil, boundary(err)
	}
	return response(out), nil
}
