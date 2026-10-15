package helperprotocol_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	nativeinput "github.com/legrch/farol/modules/release/infra/native/helperinput"
	nativeprotocol "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
)

func TestRelaunchComposesActualInputPolicyAndCodecAgainstOriginalPython(t *testing.T) {
	raw, err := os.ReadFile("testdata/relaunch-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Source string `json:"source"`
		SHA256 string `json:"sha256"`
		Cases  []struct {
			Name       string          `json:"name"`
			Request    json.RawMessage `json:"request"`
			Completion string          `json:"completion"`
			Helper     struct {
				PID          int64  `json:"pid"`
				ProcessStart string `json:"processStart"`
			} `json:"helper"`
			PrivateLaunch *string  `json:"privateLaunch"`
			Arguments     []string `json:"arguments"`
			Error         string   `json:"error"`
		} `json:"cases"`
	}
	if json.Unmarshal(raw, &fixture) != nil || fixture.Source != "resources/native/update_helper.py" || len(fixture.Cases) != 11 {
		t.Fatal("invalid original oracle fixture")
	}
	original, err := os.ReadFile("../../../../../resources/native/update_helper.py")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(original)
	if hex.EncodeToString(digest[:]) != fixture.SHA256 {
		t.Fatal("original helper source identity changed")
	}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			api, err := protocolapp.Bind(context.Background(), c.Request, inputapp.New(nativeinput.JSONDecoder{}), nativeprotocol.JSONCodec{})
			if err != nil {
				t.Fatalf("real input parser refused oracle request: %v", err)
			}
			arguments, err := api.BuildRelaunchArguments(context.Background(), c.Completion, port.HelperSelfIdentity{PID: c.Helper.PID, ProcessStart: c.Helper.ProcessStart}, c.PrivateLaunch, nativeprotocol.JSONCodec{})
			if c.Error != "" {
				var failure *protocolapp.Failure
				if !errors.As(err, &failure) || failure.Code != c.Error || failure.Internal || arguments != nil {
					t.Fatalf("refusal=%v arguments=%v, want %s", err, arguments, c.Error)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(arguments, c.Arguments) {
				t.Fatalf("arguments=%q err=%v, want %q", arguments, err, c.Arguments)
			}
		})
	}
}

func TestRelaunchCodecBoundsEscapedBytesAndKeepsHintShape(t *testing.T) {
	codec := nativeprotocol.JSONCodec{}
	hint := port.HelperRelaunchHint{OperationID: strings.Repeat("a", 32), Action: "apply", Phase: "completed", BuildID: strings.Repeat("b", 64), Helper: port.HelperSelfIdentity{PID: 5678}}
	base, err := codec.Relaunch(hint)
	if err != nil || strings.HasSuffix(string(base), "\n") {
		t.Fatalf("hint encoding: %q %v", base, err)
	}
	hint.Helper.ProcessStart = strings.Repeat("x", 2048-len(base))
	exact, err := codec.Relaunch(hint)
	if err != nil || len(exact) != 2048 {
		t.Fatalf("exact byte boundary: %d %v", len(exact), err)
	}
	hint.Helper.ProcessStart += "x"
	if _, err := codec.Relaunch(hint); err == nil || err.Error() != "helper_protocol_size" {
		t.Fatal("oversize hint accepted", err)
	}
	hint.Helper.ProcessStart = strings.Repeat("\x7f", 400)
	if _, err := codec.Relaunch(hint); err == nil || err.Error() != "helper_protocol_size" {
		t.Fatal("escaped oversize hint accepted", err)
	}
	hint.Helper.ProcessStart = string([]byte{0xff})
	if _, err := codec.Relaunch(hint); err == nil || err.Error() != "helper_protocol_encoding" {
		t.Fatal("malformed Unicode accepted", err)
	}
	hint.Helper.ProcessStart = "<>&é😀\x7f\n"
	encoded, err := codec.Relaunch(hint)
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range encoded {
		if b >= 0x7f || b == '\n' {
			t.Fatalf("hint not ASCII single line: %q", encoded)
		}
	}
	if !strings.Contains(string(encoded), "<>&\\u00e9\\ud83d\\ude00\\u007f\\n") {
		t.Fatalf("original escaping changed: %s", encoded)
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(encoded, &object) != nil || len(object) != 5 {
		t.Fatalf("wrong closed hint shape: %s", encoded)
	}
}
