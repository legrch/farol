package boot

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"io"

	"github.com/legrch/farol/boot/container"
)

// BuildID is set by the build via -ldflags; it cannot be overridden by a client.
var BuildID = "development"

func Serve(ctx context.Context, profileID string, in io.ReadCloser, out io.WriteCloser) error {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return err
	}
	server, err := container.New(BuildID, profileID, hex.EncodeToString(bytes[:]), nil)
	if err != nil {
		return err
	}
	return server.Serve(ctx, in, out)
}

// Run parses only currently implemented command modes; diagnostics never use stdout.
func Run(args []string, in io.ReadCloser, out io.WriteCloser, diagnostics io.Writer) int {
	if len(args) < 1 || args[0] != "serve" {
		fmt.Fprintln(diagnostics, "usage: farol serve --profile <id>")
		return 2
	}
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(diagnostics)
	profile := flags.String("profile", "", "exact backend profile ID")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *profile == "" {
		return 2
	}
	if err := Serve(context.Background(), *profile, in, out); err != nil {
		fmt.Fprintln(diagnostics, "farol backend:", err)
		return 1
	}
	return 0
}
