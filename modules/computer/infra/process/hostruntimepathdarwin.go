//go:build darwin

package process

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const hostEnvironmentOutputLimit = 64 << 10

type UserExecutableEnvironment struct {
	Path, Home, User, Shell, XDGConfigHome, DeveloperDir, ZDotDir string
	Source, CapturedAt                                            string
}

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

type boundedHostOutput struct {
	buffer   bytes.Buffer
	limit    int
	overflow bool
}

func (b *boundedHostOutput) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > b.limit {
		b.overflow = true
		return 0, errShellEnvironmentUnknown
	}
	return b.buffer.Write(p)
}

func (b *boundedHostOutput) Bytes() []byte { return b.buffer.Bytes() }

// runHostProbe retains the original process through Wait, including timeout.
// It does not read inherited environment, stdin or arbitrary child output.
func runHostProbe(ctx context.Context, executable string, args, environment []string, home string, limit int) ([]byte, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, errShellEnvironmentUnknown
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.Command(executable, args...)
	command.Env = environment
	command.Dir = home
	command.Stdin = bytes.NewReader(nil)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.WaitDelay = time.Second
	stdout := &boundedHostOutput{limit: limit}
	stderr := &boundedHostOutput{limit: hostEnvironmentOutputLimit}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Start(); err != nil {
		return nil, errShellEnvironmentUnknown
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if errors.Is(err, exec.ErrWaitDelay) {
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		}
		if err != nil || probe.Err() != nil || stdout.overflow || stderr.overflow {
			return nil, errShellEnvironmentUnknown
		}
		return bytes.Clone(stdout.Bytes()), nil
	case <-probe.Done():
		// Kill the owned cohort and wait for the original root; a lost Wait stays
		// UNKNOWN and cannot authorize another probe in this Shell session.
		_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			return nil, errShellEnvironmentUnknown
		}
		if errors.Is(probe.Err(), context.DeadlineExceeded) {
			return nil, errShellEnvironmentTimeout
		}
		return nil, errShellEnvironmentUnknown
	}
}

func nativeLoginAccount(ctx context.Context) (username, home, shell string, err error) {
	current, lookupErr := user.Current()
	if lookupErr != nil || current.Uid != strconv.Itoa(os.Geteuid()) || current.Username == "" {
		return "", "", "", errShellEnvironmentUnknown
	}
	// id -P obtains the account's actual home and shell from Directory Services.
	// os/user.User has no shell field; neither HOME nor SHELL is trusted here.
	output, runErr := runHostProbe(ctx, "/usr/bin/id", []string{"-P", current.Username},
		[]string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=/", "TERM=dumb"}, "/", 4096)
	if runErr != nil {
		return "", "", "", runErr
	}
	fields := strings.Split(strings.TrimSuffix(string(output), "\n"), ":")
	if len(fields) != 10 || fields[0] != current.Username || fields[2] != current.Uid {
		return "", "", "", errShellEnvironmentUnknown
	}
	home, shell = fields[8], fields[9]
	if !absolutePolicyPath(home) || !absolutePolicyPath(shell) || filepath.Clean(home) != home || filepath.Clean(shell) != shell {
		return "", "", "", errShellEnvironmentUnknown
	}
	if shell != "/bin/zsh" && shell != "/bin/bash" {
		return "", "", "", errShellEnvironmentUnknown
	}
	return current.Username, home, shell, nil
}

func framedUserEnvironment(raw []byte, nonce string) ([4]string, error) {
	var values [4]string
	begin := []byte("\x00FAROL_ENV_BEGIN_" + nonce + "\x00")
	end := []byte("\x00FAROL_ENV_END_" + nonce + "\x00")
	if bytes.Count(raw, begin) != 1 || bytes.Count(raw, end) != 1 {
		return values, errShellEnvironmentUnknown
	}
	start := bytes.Index(raw, begin) + len(begin)
	finish := bytes.Index(raw, end)
	if finish < start {
		return values, errShellEnvironmentUnknown
	}
	fields := bytes.Split(raw[start:finish], []byte{0})
	if len(fields) != 4 {
		return values, errShellEnvironmentUnknown
	}
	for i := 0; i < 4; i++ {
		if !utf8.Valid(fields[i]) {
			return values, errShellEnvironmentUnknown
		}
		values[i] = string(fields[i])
	}
	return values, nil
}

// CaptureUserEnvironment runs once at Shell admission, never on passive polls.
// The only accepted data is one nonce-bound, four-field frame from the account's
// login interactive shell. Chatter outside that frame is discarded.
func CaptureUserEnvironment(ctx context.Context) (UserExecutableEnvironment, error) {
	var empty UserExecutableEnvironment
	if ctx == nil || ctx.Err() != nil {
		return empty, errShellEnvironmentUnknown
	}
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	username, home, shell, err := nativeLoginAccount(bounded)
	if err != nil {
		return empty, err
	}
	var random [16]byte
	if _, err = io.ReadFull(rand.Reader, random[:]); err != nil {
		return empty, errShellEnvironmentUnknown
	}
	nonce := hex.EncodeToString(random[:])
	seed := []string{"HOME=" + home, "USER=" + username, "LOGNAME=" + username, "SHELL=" + shell,
		"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TERM=dumb"}
	for _, name := range []string{"XDG_CONFIG_HOME", "DEVELOPER_DIR", "ZDOTDIR"} {
		value := os.Getenv(name)
		if value == "" {
			continue
		}
		if !absolutePolicyPath(value) || filepath.Clean(value) != value {
			return empty, errShellEnvironmentUnknown
		}
		seed = append(seed, name+"="+value)
	}
	script := "printf '\\000FAROL_ENV_BEGIN_" + nonce + "\\000%s\\000%s\\000%s\\000%s\\000FAROL_ENV_END_" + nonce + "\\000' \"$PATH\" \"$XDG_CONFIG_HOME\" \"$DEVELOPER_DIR\" \"$ZDOTDIR\""
	output, err := runHostProbe(bounded, shell, []string{"-l", "-i", "-c", script}, seed, home, hostEnvironmentOutputLimit)
	if err != nil {
		return empty, err
	}
	fields, err := framedUserEnvironment(output, nonce)
	if err != nil || !validHostSearchPath(fields[0]) {
		return empty, errShellEnvironmentUnknown
	}
	for _, value := range fields[1:] {
		if value != "" && (!absolutePolicyPath(value) || filepath.Clean(value) != value) {
			return empty, errShellEnvironmentUnknown
		}
	}
	return UserExecutableEnvironment{Path: fields[0], Home: home, User: username, Shell: shell,
		XDGConfigHome: fields[1], DeveloperDir: fields[2], ZDotDir: fields[3],
		Source: "login-shell", CapturedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
}

func CaptureUserExecutablePath(ctx context.Context) (string, error) {
	environment, err := CaptureUserEnvironment(ctx)
	return environment.Path, err
}

func DiscoverInstalledHostRuntimeForPath(ctx context.Context, searchPath string) (*HostRuntimePlan, error) {
	if !validHostSearchPath(searchPath) {
		return nil, errHostRuntime
	}
	return discoverHostRuntime(ctx, nativeHostRuntimeFilesystem{}, searchPath)
}

func DiscoverInstalledHostRuntimeForEnvironment(ctx context.Context, environment UserExecutableEnvironment) (*HostRuntimePlan, error) {
	if !validHostSearchPath(environment.Path) || (environment.DeveloperDir != "" && !absolutePolicyPath(environment.DeveloperDir)) {
		return nil, errHostRuntime
	}
	return discoverHostRuntime(ctx, nativeHostRuntimeFilesystem{developerDir: environment.DeveloperDir}, environment.Path)
}
