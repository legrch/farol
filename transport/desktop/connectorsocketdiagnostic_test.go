//go:build darwin

package desktop

import (
	"errors"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
)

// Synthetic errors only: no listener, network call, or retry is attempted.
func TestConnectorSocketFailureClassificationDoesNotDiscloseHostDetails(t *testing.T) {
	for _, tc := range []struct {
		err   error
		stage connectorStartStage
		label string
	}{
		{syscall.EPERM, connectorStartSocketPermission, "socket-listen-permission"},
		{syscall.EACCES, connectorStartSocketPermission, "socket-listen-permission"},
		{syscall.ENAMETOOLONG, connectorStartSocketPathTooLong, "socket-listen-path-too-long"},
		{syscall.EADDRINUSE, connectorStartSocketAddressInUse, "socket-listen-address-in-use"},
		{errors.New("PRIVATE-PATH-CANARY"), connectorStartSocketListen, "socket-listen"},
	} {
		err := &net.OpError{Op: "listen", Net: "unix", Err: &os.PathError{Op: "bind", Path: "/PRIVATE-PATH-CANARY", Err: tc.err}}
		stage := connectorSocketFailure(err)
		if stage != tc.stage || stage.String() != tc.label || strings.Contains(stage.String(), "PRIVATE-PATH-CANARY") {
			t.Fatalf("wrong safe category: %q", stage.String())
		}
	}
}
