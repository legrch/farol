package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

// All fixtures and ports are synthetic. No test calls nativePorts, native
// inspection, process lookup, signaling, filesystem/profile or provider ports.
const testBoot = "12345678-1234-1234-1234-123456789abc"

func fixtureRequest() request {
	token, _ := lifetimeToken(testBoot, 1_700_000_000, 123456)
	return request{Action: "signal", PID: 123, UID: 501, Token: token, Signal: "SIGTERM",
		Executable: "/fixture/Owner's Farol" + electronSuffix,
		AppPath:    "/fixture/Owner's Farol/" + relativeAppPath}
}

func requestJSON(q request) []byte {
	data, _ := json.Marshal(map[string]any{"action": q.Action, "pid": q.PID,
		"uid": q.UID, "token": q.Token, "signal": q.Signal,
		"executable": q.Executable, "appPath": q.AppPath})
	return data
}

func present(q request) response {
	i := q.expected()
	return response{Status: "present", identity: &i}
}

func TestParser(t *testing.T) {
	q := fixtureRequest()
	for _, name := range []string{"SIGTERM", "SIGKILL"} {
		q.Signal = name
		got, err := parseRequest(requestJSON(q))
		if err != nil || got != q {
			t.Fatalf("signal parse: %v %v", got, err)
		}
	}
	if got, err := parseRequest([]byte(`{"action":"inspect","pid":2147483647}`)); err != nil || got.PID != maxPID {
		t.Fatalf("inspect parse: %v %v", got, err)
	}
	invalid := []string{
		``, `null`, `[]`, `{}`, `{"action":"inspect"}`, `{"action":"inspect","pid":null}`,
		`{"action":"inspect","pid":0}`, `{"action":"inspect","pid":-1}`,
		`{"action":"inspect","pid":2147483648}`, `{"action":"inspect","pid":1.0}`,
		`{"action":"inspect","pid":"123"}`, `{"action":"inspect","pid":true}`,
		`{"action":"inspect","pid":123,"pid":123}`, `{"Action":"inspect","pid":123}`,
		`{"action":"inspect","pid":123,"extra":1}`, `{"action":"inspect","pid":123} {}`,
		`{"action":"inspect","pid":123} false`, `{"action":"inspect","pid":123,}`,
		`{"action":"inspect","pid":123,"signal":"SIGTERM"}`,
		`{"action":"signal","pid":123}`, strings.Repeat(" ", maxRequestBytes+1),
	}
	for _, input := range invalid {
		if _, err := parseRequest([]byte(input)); err == nil {
			t.Errorf("accepted invalid JSON: %.100s", input)
		}
	}
	for _, field := range []string{"action", "pid", "uid", "token", "signal", "executable", "appPath"} {
		var values map[string]any
		_ = json.Unmarshal(requestJSON(fixtureRequest()), &values)
		values[field] = nil
		data, _ := json.Marshal(values)
		if _, err := parseRequest(data); err == nil {
			t.Errorf("accepted null %s", field)
		}
		delete(values, field)
		data, _ = json.Marshal(values)
		if _, err := parseRequest(data); err == nil {
			t.Errorf("accepted missing %s", field)
		}
	}
	for field, values := range map[string][]any{
		"uid": {-1, 4294967296, "501", 501.5}, "token": {"", "ps lstart", fixtureRequest().Token + "\x00"},
		"signal": {"SIGINT", "SIGSTOP", "9"}, "executable": {"/bin/sleep", "/Applications/Farol.app/Contents/MacOS/Farol"},
		"appPath": {"/other/" + relativeAppPath, relativeAppPath},
	} {
		for _, value := range values {
			var data map[string]any
			_ = json.Unmarshal(requestJSON(fixtureRequest()), &data)
			data[field] = value
			raw, _ := json.Marshal(data)
			if _, err := parseRequest(raw); err == nil {
				t.Errorf("accepted invalid %s", field)
			}
		}
	}
	if _, err := parseRequest([]byte{'{', '"', 0xff, '"', ':', '1', '}'}); err == nil {
		t.Fatal("accepted invalid UTF-8")
	}
}

func TestLifetimeToken(t *testing.T) {
	a, ok := lifetimeToken(strings.ToUpper(testBoot), 1_700_000_000, 1)
	b, _ := lifetimeToken(testBoot, 1_700_000_000, 2)
	c, _ := lifetimeToken("22345678-1234-1234-1234-123456789abc", 1_700_000_000, 1)
	if !ok || !validToken(a) || a == b || a == c || !strings.HasSuffix(a, ":1700000000000001") {
		t.Fatal("lost boot or microsecond precision")
	}
	for _, token := range []string{"", a + ":extra", strings.Replace(a, ":170", ":0170", 1), strings.Replace(a, ":170", ":+170", 1), "darwin-v1:" + testBoot + ":9223372036854775808", "darwin-v1:" + testBoot + ":1"} {
		if validToken(token) {
			t.Errorf("accepted token %s", token)
		}
	}
	for _, tv := range [][2]int64{{0, 0}, {-1, 0}, {1, -1}, {1, 1_000_000}, {1<<63 - 1, 0}} {
		if _, ok := lifetimeToken(testBoot, tv[0], tv[1]); ok {
			t.Errorf("accepted invalid timeval %v", tv)
		}
	}
	if _, ok := lifetimeToken("not-a-boot", 1, 0); ok {
		t.Fatal("accepted invalid boot")
	}
}

func procArgs(executable string, argv ...string) []byte {
	raw := make([]byte, 4)
	binary.NativeEndian.PutUint32(raw, uint32(len(argv)))
	raw = append(raw, executable...)
	raw = append(raw, 0, 0, 0)
	for _, arg := range argv {
		raw = append(raw, arg...)
		raw = append(raw, 0)
	}
	// Deliberately invalid UTF-8 and sensitive-looking text in the unparsed tail.
	return append(raw, []byte("IGNORED_ENV=private\x00\xff\x00")...)
}

func TestProcArgs(t *testing.T) {
	q := fixtureRequest()
	for _, app := range []string{q.AppPath, relativeAppPath} {
		for _, flags := range [][]string{nil, {"--preview-window-mode=secondary-visible"}, {"--preview-window-mode=secondary-visible", "--built-in-display-only", "--allow-primary-display"}} {
			argv := append([]string{q.Executable, app}, flags...)
			if !matchesProcArgs(procArgs(q.Executable, argv...), q) {
				t.Fatalf("rejected valid argv: %v", argv)
			}
		}
	}
	invalid := [][]byte{
		nil, {1, 2, 3}, procArgs("/bin/sleep", q.Executable, q.AppPath),
		procArgs(q.Executable, "/bin/sleep", q.AppPath), procArgs(q.Executable, q.Executable),
		procArgs(q.Executable, q.Executable, "/foreign/main.cjs"),
		procArgs(q.Executable, q.Executable, "./"+relativeAppPath),
		procArgs(q.Executable, q.Executable, q.AppPath, "--user-data-dir=/other"),
		procArgs(q.Executable, q.Executable, q.AppPath, "--type=renderer"),
		procArgs(q.Executable, q.Executable, q.AppPath, "--built-in-display-only", "--built-in-display-only"),
		procArgs(q.Executable, q.Executable, q.AppPath, ""),
		bytes.Repeat([]byte{0}, maxProcArgsBytes+1),
	}
	truncated := procArgs(q.Executable, q.Executable, q.AppPath)
	invalid = append(invalid, truncated[:len(truncated)-len("IGNORED_ENV=private\x00\xff\x00")-1])
	for i, raw := range invalid {
		if matchesProcArgs(raw, q) {
			t.Errorf("accepted invalid procargs fixture %d", i)
		}
	}
	for _, root := range []string{"", "/", "/fixture/../foreign", "/fixture//foreign", "/fixture/foreign/", "/fixture/\x00foreign"} {
		if validDevPaths(root+electronSuffix, root+"/"+relativeAppPath) {
			t.Errorf("accepted unsafe writer root %q", root)
		}
	}
}

func TestSignalSequence(t *testing.T) {
	q := fixtureRequest()
	cases := []struct {
		name, stage string
		result      response
		uid         uint32
		uidOK       bool
		want        string
		kills       int
	}{
		{"term", "", response{}, q.UID, true, "sent", 1},
		{"kill", "", response{}, q.UID, true, "sent", 1},
		{"initial absent", "inspect1", response{Status: "absent"}, q.UID, true, "absent", 0},
		{"initial denied", "inspect1", response{Status: "unreadable", Reason: "INSPECTION_PERMISSION_DENIED"}, q.UID, true, "refused", 0},
		{"caller uid", "", response{}, 502, true, "refused", 0},
		{"elevated caller", "", response{}, q.UID, false, "refused", 0},
		{"exec phase one", "command1", response{Status: "refused", Reason: "COMMAND_MISMATCH"}, q.UID, true, "refused", 0},
		{"second absent", "inspect2", response{Status: "absent"}, q.UID, true, "absent", 0},
		{"second unreadable", "inspect2", response{Status: "unreadable"}, q.UID, true, "refused", 0},
		{"exec phase two", "command2", response{Status: "refused", Reason: "COMMAND_MISMATCH"}, q.UID, true, "refused", 0},
		{"argv denied", "command2", response{Status: "unreadable", Reason: "INSPECTION_PERMISSION_DENIED"}, q.UID, true, "refused", 0},
		{"kill denied", "kill", response{Status: "refused", Reason: "SIGNAL_PERMISSION_DENIED"}, q.UID, true, "refused", 1},
		{"kill unknown", "kill", response{Status: "unknown", Reason: "SIGNAL_OUTCOME_UNKNOWN"}, q.UID, true, "unknown", 1},
		{"kill absent", "kill", response{Status: "absent"}, q.UID, true, "absent", 1},
	}
	for _, field := range []string{"pid", "uid", "token"} {
		changed := present(q)
		switch field {
		case "pid":
			changed.PID++
		case "uid":
			changed.UID++
		case "token":
			changed.Token, _ = lifetimeToken(testBoot, 1_700_000_000, 123457)
		}
		for _, stage := range []string{"inspect1", "inspect2"} {
			cases = append(cases, struct {
				name, stage string
				result      response
				uid         uint32
				uidOK       bool
				want        string
				kills       int
			}{field + stage, stage, changed, q.UID, true, "refused", 0})
		}
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			current := q
			if tc.name == "kill" {
				current.Signal = "SIGKILL"
			}
			var events []string
			inspections, commands, kills := 0, 0, 0
			inspect := func(pid int) response {
				if pid != q.PID {
					t.Fatal("inspected another PID")
				}
				inspections++
				stage := "inspect" + string(rune('0'+inspections))
				events = append(events, stage)
				if tc.stage == stage {
					return tc.result
				}
				return present(q)
			}
			command := func(got request) response {
				if got != current {
					t.Fatal("changed command scope")
				}
				commands++
				stage := "command" + string(rune('0'+commands))
				events = append(events, stage)
				if tc.stage == stage {
					return tc.result
				}
				return response{Status: "present"}
			}
			uid := func() (uint32, bool) { events = append(events, "uid"); return tc.uid, tc.uidOK }
			kill := func(pid int, signal string) response {
				kills++
				events = append(events, "kill")
				if pid != q.PID || signal != current.Signal {
					t.Fatal("changed signal target")
				}
				if tc.stage == "kill" {
					return tc.result
				}
				return response{Status: "sent"}
			}
			p := ports{supported: true, inspect: inspect, signal: func(r request) response { return checkedSignal(r, inspect, uid, command, kill) }}
			got := execute(current, p)
			if got.Status != tc.want || kills != tc.kills {
				t.Fatalf("got %+v, kills %d, events %v", got, kills, events)
			}
			if kills > 0 && !reflect.DeepEqual(events, []string{"inspect1", "uid", "command1", "inspect2", "command2", "kill"}) {
				t.Fatalf("bad boundary sequence: %v", events)
			}
		})
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("fixture read failure") }

type shortWriter struct{}

func (shortWriter) Write([]byte) (int, error) { return 0, io.ErrShortWrite }

func TestCLI(t *testing.T) {
	q := fixtureRequest()
	noCall := ports{supported: true, inspect: func(int) response { t.Fatal("unexpected port call"); return response{} }}
	for _, tc := range []struct {
		args  []string
		input io.Reader
	}{
		{[]string{"--pid=123"}, strings.NewReader(`{"action":"inspect","pid":123}`)},
		{nil, strings.NewReader(strings.Repeat(" ", maxRequestBytes+1))},
		{nil, failingReader{}}, {nil, strings.NewReader(`{"action":"inspect","pid":0}`)},
	} {
		var out bytes.Buffer
		if code := runCLI(tc.args, tc.input, &out, noCall); code != 2 || out.String() != "{\"status\":\"error\",\"reason\":\"INVALID_REQUEST\"}\n" {
			t.Fatalf("invalid CLI: %d %s", code, out.String())
		}
	}
	var out bytes.Buffer
	if runCLI(nil, strings.NewReader(`{"action":"inspect","pid":123}`), &out, ports{}) != 1 || !strings.Contains(out.String(), `"status":"unsupported"`) {
		t.Fatal("unsupported OS did not fail closed")
	}
	out.Reset()
	p := ports{supported: true, inspect: func(int) response { return present(q) }}
	if runCLI(nil, strings.NewReader(`{"action":"inspect","pid":123}`), &out, p) != 0 {
		t.Fatal("inspect failed")
	}
	var fields map[string]any
	if json.Unmarshal(out.Bytes(), &fields) != nil || len(fields) != 4 || fields["pid"] != float64(q.PID) || fields["uid"] != float64(q.UID) || fields["token"] != q.Token || len(out.Bytes()) > maxResponseBytes {
		t.Fatalf("wrong bounded API response: %s", out.String())
	}
	if runCLI(nil, strings.NewReader(`{"action":"inspect","pid":123}`), shortWriter{}, p) != 1 {
		t.Fatal("ignored output failure")
	}
	for _, r := range []response{{Status: "absent"}, {Status: "unreadable", Reason: "INSPECTION_PERMISSION_DENIED"}, {Status: "sent"}, {Status: "refused"}, {Status: "unknown"}} {
		raw, _ := json.Marshal(r)
		if bytes.Contains(raw, []byte("token")) || bytes.Contains(raw, []byte("uid")) {
			t.Fatalf("leaked identity in non-present output: %s", raw)
		}
	}
}
