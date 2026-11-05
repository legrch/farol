//go:build darwin

package process

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const hostRuntimePathLimit = 16384

func validHostSearchPath(value string) bool {
	if value == "" || len(value) > hostRuntimePathLimit || !utf8.ValidString(value) {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	for _, dir := range strings.Split(value, ":") {
		if !absolutePolicyPath(dir) || filepath.Clean(dir) != dir {
			return false
		}
	}
	return true
}

type boundedHostPathOutput struct{ bytes.Buffer }

func (b *boundedHostPathOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > hostRuntimePathLimit+2 {
		return 0, errHostRuntime
	}
	return b.Buffer.Write(p)
}

// CaptureUserExecutablePath is invoked when a Shell session first needs an
// installed runtime. A Terminal launch preserves its inherited PATH. Finder
// launches obtain the user's login+interactive PATH once, outside Seatbelt;
// startup chatter, malformed framing or a timeout fail closed.
func CaptureUserExecutablePath(ctx context.Context) (string, error) {
	if ctx == nil || ctx.Err() != nil {
		return "", errHostRuntime
	}
	if term := os.Getenv("TERM"); os.Getenv("TERM_PROGRAM") != "" || (term != "" && term != "dumb") {
		value := os.Getenv("PATH")
		if validHostSearchPath(value) {
			return value, nil
		}
		return "", errHostRuntime
	}
	shell := os.Getenv("SHELL")
	if !absolutePolicyPath(shell) || filepath.Clean(shell) != shell {
		return "", errHostRuntime
	}
	info, err := os.Stat(shell)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return "", errHostRuntime
	}
	probe, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probe, shell, "-lic", `printf '\000%s\000' "$PATH"`)
	var out boundedHostPathOutput
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil || probe.Err() != nil {
		return "", errHostRuntime
	}
	raw := out.Bytes()
	// Interactive startup may print a bounded welcome/status prefix. Only the
	// final NUL-framed record is accepted; any suffix or embedded NUL in PATH
	// is refused rather than interpreted as another value.
	start := -1
	if len(raw) > 0 && raw[len(raw)-1] == 0 {
		start = bytes.LastIndexByte(raw[:len(raw)-1], 0)
	}
	if start < 0 || len(raw)-start < 3 || bytes.IndexByte(raw[start+1:len(raw)-1], 0) >= 0 {
		return "", errHostRuntime
	}
	value := string(raw[start+1 : len(raw)-1])
	if !validHostSearchPath(value) {
		return "", errHostRuntime
	}
	return value, nil
}

func DiscoverInstalledHostRuntimeForPath(ctx context.Context, searchPath string) (*HostRuntimePlan, error) {
	if !validHostSearchPath(searchPath) {
		return nil, errHostRuntime
	}
	return discoverHostRuntime(ctx, nativeHostRuntimeFilesystem{}, searchPath)
}
