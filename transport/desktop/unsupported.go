//go:build !darwin

package desktop

import (
	"context"
	wire "github.com/legrch/farol/gen/desktop/v1"
)

type ConnectorListener struct{}

func StartConnector(context.Context, wire.ComputerConnectorBinding, map[string]Method) (*ConnectorListener, error) {
	return nil, ErrConnectorUnavailable
}
func (*ConnectorListener) Endpoint() wire.ComputerConnectorEndpoint {
	return wire.ComputerConnectorEndpoint{}
}
func (*ConnectorListener) Close(context.Context) error { return ErrConnectorUnavailable }
