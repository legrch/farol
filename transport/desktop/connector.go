// The connector transport authenticates an external MCP adapter to the same selected
// Go backend. It creates no approval, execution lease or module operation owner.
package desktop

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/pkg/ipc"
)

var ErrConnectorUnavailable = errors.New("COMPUTER_CONNECTOR_UNAVAILABLE")

type ConnectorConfig struct {
	// These values come from the already selected backend and live connector owner.
	// They must never be reconstructed from an attachment's request body.
	Endpoint wire.ComputerConnectorEndpoint
	Methods  map[string]Method
}

func validateConnectorConfig(config ConnectorConfig) error {
	raw, err := json.Marshal(config.Endpoint)
	if err != nil || wire.Validate("ComputerConnectorEndpoint", raw) != nil || len(config.Methods) == 0 || len(config.Methods) > 16 {
		return ErrConnectorUnavailable
	}
	for name, method := range config.Methods {
		switch name {
		case "computer.workspace.search", "computer.workspace.read", "computer.workspace.list", "computer.workspace.catalogue", "computer.workspace.bootstrap", "computer.connector.verify", "computer.connector.catalogueverify", "computer.connector.verification", "computer.workspace.write", "computer.workspace.edit", "computer.workspace.mutation.read":
			if method.Handle == nil {
				return ErrConnectorUnavailable
			}
		default:
			return ErrConnectorUnavailable
		}
	}
	return nil
}

// serveConnectorConnection is called only after native same-user peer qualification.
// Attachment loss closes this stream, not a module-owned operation or process.
// Original handler owners retain possible effects and their uncertainty.
func serveConnectorConnection(ctx context.Context, stream net.Conn, config ConnectorConfig) error {
	defer stream.Close()
	if ctx == nil || ctx.Err() != nil || validateConnectorConfig(config) != nil {
		return ErrConnectorUnavailable
	}
	stopped := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		select {
		case <-ctx.Done():
			_ = stream.Close()
		case <-stopped:
		}
	}()
	defer func() { close(stopped); <-done }()
	if stream.SetDeadline(time.Now().Add(5*time.Second)) != nil {
		return ErrConnectorUnavailable
	}
	// Cap untrusted pre-auth allocation independently of ordinary 1 MiB frames.
	var header [4]byte
	if _, err := io.ReadFull(stream, header[:]); err != nil {
		return ErrConnectorUnavailable
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > 8192 {
		return ErrConnectorUnavailable
	}
	raw := make([]byte, size)
	_, err := io.ReadFull(stream, raw)
	if err != nil || ipc.ValidateJSON(raw) != nil || wire.Validate("ComputerConnectorHello", raw) != nil {
		return ErrConnectorUnavailable
	}
	var hello wire.ComputerConnectorHello
	if json.Unmarshal(raw, &hello) != nil || hello.Binding != config.Endpoint.Binding || subtle.ConstantTimeCompare([]byte(hello.Token), []byte(config.Endpoint.Token)) != 1 {
		return ErrConnectorUnavailable
	}
	reply, err := json.Marshal(config.Endpoint.Binding)
	if err != nil || ipc.WriteFrame(stream, reply) != nil {
		return ErrConnectorUnavailable
	}
	if stream.SetDeadline(time.Time{}) != nil {
		return ErrConnectorUnavailable
	}
	b := config.Endpoint.Binding
	server, err := New(Config{BuildID: b.BuildId, ProfileID: b.ProfileId, Generation: b.BackendGeneration, Methods: config.Methods})
	if err != nil {
		return ErrConnectorUnavailable
	}
	return server.Serve(ctx, stream, stream)
}
