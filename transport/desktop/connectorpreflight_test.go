//go:build darwin

package desktop

import (
	"context"
	"strings"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
)

// This pure check qualifies only the native fixture's config against the current
// validator. It creates no endpoints and supplies no native startup evidence.
func TestConnectorConfigNativePreflight(t *testing.T) {
	config := ConnectorConfig{
		Endpoint: wire.ComputerConnectorEndpoint{
			Binding:    nativeConnectorBinding(),
			SocketPath: "/private/tmp/pending.sock",
			Token:      strings.Repeat("a", 64),
		},
		Methods: map[string]Method{
			"computer.workspace.list": {Handle: func(context.Context, Request) (*Outcome, error) { return nil, nil }},
		},
	}
	if validateConnectorConfig(config) != nil {
		t.Fatal("native fixture config failed pure preflight")
	}
	config.Methods["computer.workspace.list"] = Method{}
	if validateConnectorConfig(config) != ErrConnectorUnavailable {
		t.Fatal("missing handler changed preflight refusal classification")
	}
}

// Nil and already canceled contexts stop before entropy or endpoint IO.
func TestConnectorStartupContextDiagnostic(t *testing.T) {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		name string
		ctx  context.Context
	}{{"nil", nil}, {"canceled", canceled}} {
		t.Run(tc.name, func(t *testing.T) {
			listener, stage, err := startConnector(tc.ctx, nativeConnectorBinding(), nil)
			if listener != nil || stage != connectorStartContext || stage.String() != "context" || err != ErrConnectorUnavailable {
				t.Fatal("context refusal changed private stage or exact sentinel")
			}
			listener, err = StartConnector(tc.ctx, nativeConnectorBinding(), nil)
			if listener != nil || err != ErrConnectorUnavailable {
				t.Fatal("public context refusal changed exact sentinel")
			}
		})
	}
}
