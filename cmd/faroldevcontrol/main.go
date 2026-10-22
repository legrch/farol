// dev-control accepts one JSON request on stdin (EOF required), no arguments,
// and emits one bounded JSON response. The caller owns its wall-clock timeout.
//
// Inspect: {"action":"inspect","pid":123}, optionally with the same exact
// executable/appPath pair to qualify the kernel command without exposing it.
// Signal: {"action":"signal","pid":123,"uid":501,"token":"<retained token>",
// "signal":"SIGTERM","executable":"<writer>/node_modules/electron/dist/
// Electron.app/Contents/MacOS/Electron","appPath":"<writer>/_output/build/app/main.cjs"}
//
// Only present responses carry top-level pid, uid and token. The Lead
// must independently correlate executable, command, profile and run marker.
// A token is process-lifetime evidence, not authorization to stop arbitrary work.
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	maxRequestBytes  = 4096
	maxResponseBytes = 512
	maxPID           = 1<<31 - 1
	maxProcArgsBytes = 1 << 20
	electronSuffix   = "/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
	relativeAppPath  = "_output/build/app/main.cjs"
)

type identity struct {
	PID   int    `json:"pid"`
	UID   uint32 `json:"uid"`
	Token string `json:"token"`
}

type request struct {
	Action     string
	PID        int
	UID        uint32
	Token      string
	Signal     string
	Executable string
	AppPath    string
}

type response struct {
	Status          string `json:"status"`
	Reason          string `json:"reason,omitempty"`
	CommandVerified bool   `json:"commandVerified,omitempty"`
	*identity
}

// These tiny seams permit pure tests; constructing nativePorts performs no I/O.
type ports struct {
	supported bool
	inspect   func(int) response
	command   func(request) response
	signal    func(request) response
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdin, os.Stdout, nativePorts()))
}

func runCLI(args []string, input io.Reader, output io.Writer, p ports) int {
	r := response{Status: "error", Reason: "INVALID_REQUEST"}
	code := 2
	if len(args) == 0 {
		data, err := io.ReadAll(io.LimitReader(input, maxRequestBytes+1))
		if err == nil && len(data) <= maxRequestBytes {
			if q, err := parseRequest(data); err == nil {
				r = execute(q, p)
				code = 1
				if r.Status == "present" || r.Status == "absent" || r.Status == "sent" {
					code = 0
				}
			}
		}
	}
	data, err := json.Marshal(r)
	if err != nil || len(data)+1 > maxResponseBytes {
		return 1
	}
	data = append(data, '\n')
	if n, err := output.Write(data); err != nil || n != len(data) {
		return 1
	}
	return code
}

var errInvalidRequest = errors.New("invalid request")

// Explicit keys also reject duplicate and differently-cased fields, which a
// struct decoder with DisallowUnknownFields alone would silently accept.
func object(data []byte, allowed ...string) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return nil, errInvalidRequest
	}
	fields := make(map[string]json.RawMessage)
	for d.More() {
		t, err := d.Token()
		key, ok := t.(string)
		if err != nil || !ok || !contains(allowed, key) {
			return nil, errInvalidRequest
		}
		if _, exists := fields[key]; exists {
			return nil, errInvalidRequest
		}
		var value json.RawMessage
		if d.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errInvalidRequest
		}
		fields[key] = value
	}
	if t, err := d.Token(); err != nil || t != json.Delim('}') {
		return nil, errInvalidRequest
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errInvalidRequest
	}
	return fields, nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func parseRequest(data []byte) (request, error) {
	var q request
	if len(data) > maxRequestBytes || !utf8.Valid(data) {
		return q, errInvalidRequest
	}
	f, err := object(data, "action", "pid", "uid", "token", "signal", "executable", "appPath")
	if err != nil || json.Unmarshal(f["action"], &q.Action) != nil || json.Unmarshal(f["pid"], &q.PID) != nil || !validPID(q.PID) {
		return q, errInvalidRequest
	}
	if q.Action == "inspect" && len(f) == 2 {
		return q, nil
	}
	if q.Action == "inspect" && len(f) == 4 && json.Unmarshal(f["executable"], &q.Executable) == nil && json.Unmarshal(f["appPath"], &q.AppPath) == nil && validDevPaths(q.Executable, q.AppPath) {
		return q, nil
	}
	if q.Action != "signal" || len(f) != 7 || json.Unmarshal(f["signal"], &q.Signal) != nil || !validSignal(q.Signal) {
		return q, errInvalidRequest
	}
	if json.Unmarshal(f["uid"], &q.UID) != nil || json.Unmarshal(f["token"], &q.Token) != nil ||
		json.Unmarshal(f["executable"], &q.Executable) != nil || json.Unmarshal(f["appPath"], &q.AppPath) != nil ||
		!validToken(q.Token) || !validDevPaths(q.Executable, q.AppPath) {
		return q, errInvalidRequest
	}
	return q, nil
}

func (q request) expected() identity { return identity{PID: q.PID, UID: q.UID, Token: q.Token} }

// The Lead selects the physically canonical owned writer root. These lexical
// checks permit only its Electron binary and matching built Dev entrypoint;
// they do not independently prove realpath, ownership, profile or run marker.
func validDevPaths(executable, appPath string) bool {
	if !canonicalPath(executable) || !canonicalPath(appPath) || !strings.HasSuffix(executable, electronSuffix) {
		return false
	}
	root := strings.TrimSuffix(executable, electronSuffix)
	return canonicalPath(root) && appPath == root+"/"+relativeAppPath
}

func canonicalPath(value string) bool {
	if len(value) > 2048 || !strings.HasPrefix(value, "/") || strings.ContainsAny(value, "\x00\r\n") {
		return false
	}
	for _, part := range strings.Split(value[1:], "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// kern.procargs2 contains argc (native int32), executable NUL, padding NULs,
// argc argv strings, then environment. Parse exactly argc strings; never parse
// or emit the remaining environment. No shell quoting or command-line splitting.
// Only an independently parsed different executable excludes a named process
// from this writer. Unsupported argv of the same binary remains a blocker.
func inspectProcCommand(raw []byte, q request) response {
	if !validDevPaths(q.Executable, q.AppPath) || len(raw) < 5 || len(raw) > maxProcArgsBytes {
		return response{Status: "unreadable", Reason: "PROC_EXECUTABLE_UNREADABLE"}
	}
	end := bytes.IndexByte(raw[4:], 0)
	if end < 1 || end > 2048 || !utf8.Valid(raw[4:4+end]) || !canonicalPath(string(raw[4:4+end])) {
		return response{Status: "unreadable", Reason: "PROC_EXECUTABLE_UNREADABLE"}
	}
	if string(raw[4:4+end]) != q.Executable {
		return response{Status: "refused", Reason: "WRITER_EXECUTABLE_MISMATCH"}
	}
	if !matchesProcArgs(raw, q) {
		return response{Status: "refused", Reason: "COMMAND_MISMATCH"}
	}
	return response{Status: "present"}
}

func matchesProcArgs(raw []byte, q request) bool {
	if !validDevPaths(q.Executable, q.AppPath) || len(raw) < 4 || len(raw) > maxProcArgsBytes {
		return false
	}
	argc := int(binary.NativeEndian.Uint32(raw[:4]))
	if argc < 2 || argc > 5 {
		return false
	}
	rest := raw[4:]
	readString := func() (string, bool) {
		end := bytes.IndexByte(rest, 0)
		if end < 0 || end > 2048 {
			return "", false
		}
		value := string(rest[:end])
		rest = rest[end+1:]
		return value, utf8.ValidString(value)
	}
	executable, ok := readString()
	if !ok || executable != q.Executable {
		return false
	}
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}
	argv0, ok := readString()
	if !ok {
		return false
	}
	// Node's process.title replaces argv with the exact product name and empty
	// remaining strings on Darwin. The kernel executable above is retained.
	// Profile/entrypoint correlation still belongs to the private run-marker
	// owner; this renamed form cannot independently reconstruct erased argv.
	if argv0 == "Farol Dev" {
		for i := 1; i < argc; i++ {
			value, ok := readString()
			if !ok || value != "" {
				return false
			}
		}
		return true
	}
	if argv0 != q.Executable {
		return false
	}
	app, ok := readString()
	if !ok || (app != q.AppPath && app != relativeAppPath) {
		return false
	}
	seen := make(map[string]bool)
	for i := 2; i < argc; i++ {
		flag, ok := readString()
		if !ok || seen[flag] || !contains([]string{
			"--preview-window-mode=secondary-visible", "--built-in-display-only", "--allow-primary-display", "--display=secondary",
		}, flag) {
			return false
		}
		seen[flag] = true
	}
	return true
}

func validPID(pid int) bool { return pid > 0 && pid <= maxPID }

func validSignal(signal string) bool { return signal == "SIGTERM" || signal == "SIGKILL" }

func validBootToken(boot string) bool {
	if len(boot) != 36 {
		return false
	}
	for i, c := range boot {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Preserve integer microseconds, never float milliseconds or whole seconds.
func lifetimeToken(boot string, seconds, microseconds int64) (string, bool) {
	boot = strings.ToLower(boot)
	if !validBootToken(boot) || seconds <= 0 || microseconds < 0 || microseconds >= 1_000_000 ||
		seconds > ((1<<63-1)-microseconds)/1_000_000 {
		return "", false
	}
	return "darwin-v1:" + boot + ":" + strconv.FormatInt(seconds*1_000_000+microseconds, 10), true
}

func validToken(token string) bool {
	parts := strings.Split(token, ":")
	if len(parts) != 3 || parts[0] != "darwin-v1" || !validBootToken(parts[1]) {
		return false
	}
	start, err := strconv.ParseInt(parts[2], 10, 64)
	return err == nil && start >= 1_000_000 && strconv.FormatInt(start, 10) == parts[2]
}

func execute(q request, p ports) response {
	if !validPID(q.PID) || (q.Action != "inspect" && q.Action != "signal") ||
		(q.Action == "signal" && (!validSignal(q.Signal) || !validToken(q.Token) || !validDevPaths(q.Executable, q.AppPath))) {
		return response{Status: "error", Reason: "INVALID_REQUEST"}
	}
	if !p.supported {
		return response{Status: "unsupported", Reason: "UNSUPPORTED_OS"}
	}
	observed := p.inspect(q.PID)
	if q.Action == "inspect" {
		if q.Executable != "" && observed.Status == "present" {
			if observed.identity == nil || p.command == nil || !validDevPaths(q.Executable, q.AppPath) {
				return response{Status: "unreadable", Reason: "IDENTITY_UNREADABLE"}
			}
			if command := p.command(q); command.Status != "present" {
				return command
			}
			if denied, ok := match(*observed.identity, p.inspect(q.PID)); !ok {
				return denied
			}
			observed.CommandVerified = true
		}
		return observed
	}
	if denied, ok := match(q.expected(), observed); !ok {
		return signalFailure(denied)
	}
	return p.signal(q)
}

func match(expected identity, observed response) (response, bool) {
	if observed.Status == "absent" || observed.Status == "unreadable" {
		return response{Status: observed.Status, Reason: observed.Reason}, false
	}
	if observed.Status != "present" || observed.identity == nil ||
		!validPID(observed.identity.PID) || !validToken(observed.identity.Token) {
		return response{Status: "unreadable", Reason: "IDENTITY_UNREADABLE"}, false
	}
	if *observed.identity != expected {
		return response{Status: "refused", Reason: "IDENTITY_MISMATCH"}, false
	}
	return response{}, true
}

// This second observation belongs at the native syscall boundary. It is NOT an
// atomic compare-and-signal: Darwin kill still addresses a numeric PID. Exit,
// PID reuse, exec or credential change between the final observations and kill remains
// possible. Two observations and precise start+boot tokens minimize that window;
// callers must not claim an identity-atomic syscall or a successful clean Quit.
// execute supplies the first lifetime observation; both phases correlate argv.
func checkedSignal(q request, inspect func(int) response, callerUID func() (uint32, bool), command func(request) response, kill func(int, string) response) response {
	if !validPID(q.PID) || !validSignal(q.Signal) || !validToken(q.Token) || !validDevPaths(q.Executable, q.AppPath) {
		return response{Status: "error", Reason: "INVALID_REQUEST"}
	}
	uid, ok := callerUID()
	if !ok || uid != q.UID {
		return response{Status: "refused", Reason: "CALLER_UID_MISMATCH"}
	}
	if observed := command(q); observed.Status != "present" {
		return signalFailure(observed)
	}
	if denied, ok := match(q.expected(), inspect(q.PID)); !ok {
		return signalFailure(denied)
	}
	if observed := command(q); observed.Status != "present" {
		return signalFailure(observed)
	}
	return kill(q.PID, q.Signal)
}

// Signal's closed result vocabulary is sent/absent/refused/unknown. Failures
// before kill are refused (with the read classification retained in reason).
func signalFailure(r response) response {
	if r.Status == "absent" {
		return response{Status: "absent"}
	}
	if r.Reason == "" {
		r.Reason = "IDENTITY_UNREADABLE"
	}
	return response{Status: "refused", Reason: r.Reason}
}
