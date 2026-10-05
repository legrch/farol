package desktop

import (
	"encoding/json"
	"os"
	"testing"
)

func TestChatStartSharedWireFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../api/desktop/v1/fixtures/chat-start.json")
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Input  json.RawMessage
		Output json.RawMessage
	}
	if err = json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if err = Validate("ChatStart", data.Input); err != nil {
		t.Fatal(err)
	}
	if err = Validate("ChatStarted", data.Output); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"chat.conversation.start", "chat.conversation.account.revoke"} {
		if !KnownMethod(name) || !RequiresOperationID(name) {
			t.Fatal("missing effect classification", name)
		}
	}
	var input map[string]any
	if err = json.Unmarshal(data.Input, &input); err != nil {
		t.Fatal(err)
	}
	input["approved"] = true
	changed, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	if Validate("ChatStart", changed) == nil {
		t.Fatal("unknown approval field accepted")
	}
}
