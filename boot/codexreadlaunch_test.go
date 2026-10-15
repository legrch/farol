package boot

// Controlled launcher values only: no profile, scratch, host, account or provider
// is opened. These tests do not qualify native or installed selected-task reads.
import (
	"bytes"
	"flag"
	"io"
	"strings"
	"testing"
)

func TestCodexReadLaunchAtomicPairAndOccurrenceCounts(t *testing.T) {
	for _, test := range []struct {
		name   string
		args   []string
		native bool
		valid  bool
	}{
		{name: "absent", valid: true},
		{name: "native-absent", native: true, valid: true},
		{name: "selected", args: []string{"--codex-read-host", "codex", "--codex-read-temp", "/app/tmp"}, native: true, valid: true},
		{name: "equals", args: []string{"--codex-read-temp=/app/tmp", "--codex-read-host=codex"}, native: true, valid: true},
		{name: "host-only", args: []string{"--codex-read-host", "codex"}, native: true},
		{name: "temp-only", args: []string{"--codex-read-temp", "/app/tmp"}, native: true},
		{name: "empty-host", args: []string{"--codex-read-host=", "--codex-read-temp=/app/tmp"}, native: true},
		{name: "empty-temp", args: []string{"--codex-read-host=codex", "--codex-read-temp="}, native: true},
		{name: "empty-pair", args: []string{"--codex-read-host=", "--codex-read-temp="}, native: true},
		{name: "duplicate-host", args: []string{"--codex-read-host=codex", "--codex-read-host=codex", "--codex-read-temp=/app/tmp"}, native: true},
		{name: "duplicate-temp", args: []string{"--codex-read-host=codex", "--codex-read-temp=/app/tmp", "--codex-read-temp=/app/tmp"}, native: true},
		{name: "overwritten-host", args: []string{"--codex-read-host=foreign", "--codex-read-host=codex", "--codex-read-temp=/app/tmp"}, native: true},
		{name: "nonnative", args: []string{"--codex-read-host=codex", "--codex-read-temp=/app/tmp"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			flags := flag.NewFlagSet("controlled-launch", flag.ContinueOnError)
			var host, temp codexReadLaunchFlag
			flags.Var(&host, "codex-read-host", "")
			flags.Var(&temp, "codex-read-temp", "")
			if err := flags.Parse(test.args); err != nil {
				t.Fatal(err)
			}
			selected, err := decodeCodexReadLaunch(host, temp, test.native)
			if (err == nil) != test.valid {
				t.Fatal(selected, err)
			}
			if !test.valid || len(test.args) == 0 {
				if selected != nil {
					t.Fatal("absent or refused pair selected a source")
				}
				return
			}
			if selected == nil || *selected != (NativeCodexReadSelection{HostID: "codex", TrustedTemp: "/app/tmp"}) {
				t.Fatal("exact trusted pair changed", selected)
			}
		})
	}
}

func TestCodexReadLaunchUsesExistingGoSelectionValidation(t *testing.T) {
	for _, host := range []string{"", "other", "Codex", "codex/other"} {
		if selected, err := decodeCodexReadLaunch(codexReadLaunchFlag{host, 1}, codexReadLaunchFlag{"/app/tmp", 1}, true); err == nil || selected != nil {
			t.Fatal("invalid host accepted", host)
		}
	}
	for _, path := range []string{"", "/", "relative", "/app/../tmp", "/app/tmp/", "/app//tmp", "/app/\x00tmp", "/app/\ntmp", "/app/\x7ftmp", "/" + strings.Repeat("x", 256), "/" + strings.Repeat("a/", 2048) + "z", "/app/\xff"} {
		if selected, err := decodeCodexReadLaunch(codexReadLaunchFlag{"codex", 1}, codexReadLaunchFlag{path, 1}, true); err == nil || selected != nil {
			t.Fatal("invalid canonical parent accepted")
		}
	}
}

func TestCodexReadLaunchRunRefusesArgumentsBeforeServe(t *testing.T) {
	for _, args := range [][]string{
		{"--codex-read-host", "codex"},
		{"--codex-read-temp", "/app/tmp"},
		{"--codex-read-host=", "--codex-read-temp="},
		{"--codex-read-host=codex", "--codex-read-temp=/app/tmp"}, // No native profile.
		{"--profile-root=/not-opened", "--codex-read-host=other", "--codex-read-temp=/app/tmp"},
		{"--profile-root=/not-opened", "--codex-read-host=codex", "--codex-read-temp=/"},
		{"--profile-root=/not-opened", "--codex-read-host=codex", "--codex-read-host=codex", "--codex-read-temp=/app/tmp"},
		{"--profile-root=/not-opened", "--codex-read-host=codex", "--codex-read-temp=/app/tmp", "--codex-read-temp=/app/tmp"},
		{"--codex-read-host"},
		{"--codex-read-unknown=codex"},
		{"--codex-read-host=codex", "--codex-read-temp=/app/tmp", "unexpected"},
	} {
		var diagnostics, output bytes.Buffer
		status := Run(append([]string{"serve", "--profile=controlled"}, args...), io.NopCloser(bytes.NewReader(nil)), codexReadLaunchOutput{&output}, &diagnostics)
		if status != 2 || output.Len() != 0 || strings.Contains(diagnostics.String(), "farol backend:") {
			t.Fatal("invalid launch reached serve", args, status, diagnostics.String())
		}
	}
}

type codexReadLaunchOutput struct{ io.Writer }

func (codexReadLaunchOutput) Close() error { return nil }
