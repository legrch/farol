package boot

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestPreservedProfileDiscoveryCommandRejectsBeforeIO(t *testing.T) {
	for _, args := range [][]string{nil, {"--profile"}, append(preservedCommandArgs(), "--discover", "true")} {
		var diagnostic bytes.Buffer
		if code := runPreservedProfileDiscovery(args, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostic); code != 2 || diagnostic.Len() != 0 {
			t.Fatal("invalid discovery arguments reached IO", code)
		}
	}
	args := preservedCommandArgs()
	args[3] = "/private/tmp/Farol Next Preview/farol-next-state/go-core"
	var diagnostic bytes.Buffer
	if code := runPreservedProfileDiscovery(args, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostic); code != 2 {
		t.Fatal("installed namespace reached discovery", code)
	}
	if code := Run([]string{"discover-preserved-profile"}, preservedCommandUntouched{}, preservedCommandUntouched{}, &diagnostic); code != 2 {
		t.Fatal("missing discovery dispatch", code)
	}
}

func TestPreservedProfileDiscoveryCommandKeepsStrictFramesAndBudget(t *testing.T) {
	for _, raw := range []string{"", "null\n", "{} {}\n", "{\"ownerid\":\"owner\"}\n", "{\"OwnerID\":\"a\",\"OwnerID\":\"b\"}\n", "{\"Profile\":null}\n", "{\"discover\":true}\n", strings.Repeat(" ", 65537) + "\n"} {
		until := time.Now().Add(time.Second)
		input := &preservedCommandInput{Reader: strings.NewReader(raw)}
		var output preservedCommandOutput
		var diagnostic bytes.Buffer
		if code := runPreservedProfileDiscoveryDeadline(preservedCommandArgs(), input, &output, &diagnostic, until); code != 2 || output.Len() != 0 || diagnostic.Len() != 0 || input.deadline != until || output.deadline != until {
			t.Fatal("invalid discovery frame or changed budget admitted", code)
		}
	}
}
