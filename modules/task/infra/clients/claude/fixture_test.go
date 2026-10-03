package claude

// Independent source-only scripted boundary: no CLI/account/child is launched.
// Its input oracle neither calls Build nor imports the parser/normalizer.
import (
	"errors"
	"reflect"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

const fixtureSession = "12345678-1234-1234-1234-123456789abc"
const fixtureInit = `{"type":"system","subtype":"init","session_id":"12345678-1234-1234-1234-123456789abc","cwd":"/fixture/writer","model":"fixture-model-a","permissionMode":"default"}` + "\n"
const fixtureDelta = `{"type":"assistant","session_id":"12345678-1234-1234-1234-123456789abc","message":{"content":[{"type":"text","text":"Useful café 🐙"},{"type":"thinking","thinking":"HIDDEN_REASONING"}]}}` + "\n"
const fixtureResult = `{"type":"result","subtype":"success","session_id":"12345678-1234-1234-1234-123456789abc","is_error":false,"permission_denials":[],"result":"fixture final"}` + "\n"

func fixtureSelection() Selection {
	b := task.Binding{Provider: task.Claude, ProfileID: "fixture-profile", HostID: "fixture-host", ProjectID: "project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "1", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "chosen-alias", Model: "fixture-model-a", Effort: "high", ConfigDigest: "fixture-config-a"}
	scope := task.AdmissionBinding{OwnerID: "owner", SessionID: "authority-session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "farol-turn"}
	return Selection{Binding: b, Scope: scope, RuntimeID: "fixture-runtime", AdmissionID: "authority-correlation", SessionID: fixtureSession, ReportedModel: "fixture-model-a", Efforts: []EffortMapping{{"high", "high"}}, ExactResume: true}
}
func fixtureDispatch(s Selection) port.Dispatch {
	return port.Dispatch{Intent: task.Intent{OperationID: "operation", TaskID: "task", Digest: "content-free-digest", Action: task.Create, Binding: s.Binding, Admission: s.Scope}, Message: "bounded fixture"}
}

type strictFixture struct {
	attempted, accepted int
	resume              bool
	effort              string
}

func (f *strictFixture) submit(args []string, input []byte) error {
	f.attempted++
	seen := map[string]string{}
	for n := 0; n < len(args); n++ {
		flag := args[n]
		if _, duplicate := seen[flag]; duplicate {
			return errors.New("FIXTURE_DUPLICATE_FLAG")
		}
		switch flag {
		case "--print", "--verbose":
			seen[flag] = "true"
		case "--output-format", "--session-id", "--resume", "--model", "--permission-mode", "--permission-prompts", "--effort":
			n++
			if n == len(args) {
				return errors.New("FIXTURE_MISSING_VALUE")
			}
			seen[flag] = args[n]
		default:
			return errors.New("FIXTURE_UNSUPPORTED_FLAG")
		}
	}
	sessionFlag := "--session-id"
	if f.resume {
		sessionFlag = "--resume"
	}
	expected := map[string]string{"--print": "true", "--verbose": "true", "--output-format": "stream-json", sessionFlag: fixtureSession, "--model": "fixture-model-a", "--permission-mode": "default", "--permission-prompts": "none"}
	if f.effort != "" {
		expected["--effort"] = f.effort
	}
	if !reflect.DeepEqual(seen, expected) || string(input) != "bounded fixture\n" {
		return errors.New("FIXTURE_INVOCATION_MISMATCH")
	}
	f.accepted++
	return nil
}
func (f *strictFixture) input(_ []byte) error { return errors.New("FIXTURE_INPUT_UNSUPPORTED") }
func streamFixture(t *testing.T) *Stream {
	t.Helper()
	s, err := NewStream(Expected{fixtureSession, "/fixture/writer", "fixture-model-a", "default"})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
