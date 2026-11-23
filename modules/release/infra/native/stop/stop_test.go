package stop

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

type fakeSystem struct {
	exe  string
	err  error
	sent []port.ProcessSignal
}

func (f *fakeSystem) path(context.Context, int) (string, error) { return f.exe, f.err }
func (f *fakeSystem) signal(_ int, s port.ProcessSignal) error {
	f.sent = append(f.sent, s)
	return nil
}

func TestSignalsOnlyAProcessRunningFromTheBoundSlot(t *testing.T) {
	const slot = "/Applications/Farol.app"
	for _, tc := range []struct {
		name, exe string
		err       error
		want      error
		signalled bool
	}{
		{"main", slot + "/Contents/MacOS/Farol", nil, nil, true},
		{"electron runtime", slot + "/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron", nil, nil, true},
		{"other app", "/Applications/Other.app/Contents/MacOS/Other", nil, ErrPath, false},
		{"prefix trick", "/Applications/Farol.app.evil/Contents/MacOS/Farol", nil, ErrPath, false},
		{"bundle root", slot, nil, ErrPath, false},
		{"unclean", slot + "/Contents/../../Other.app/Contents/MacOS/x", nil, ErrPath, false},
		{"gone", "", nil, nil, false},
		{"unreadable", "", errors.New("eperm"), ErrUnknown, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sys := &fakeSystem{exe: tc.exe, err: tc.err}
			term, err := newTerminator(4242, slot, sys)
			if err != nil {
				t.Fatal(err)
			}
			if got := term.Signal(context.Background(), port.ProcessSignalTerminate); !errors.Is(got, tc.want) && got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
			if (len(sys.sent) == 1) != tc.signalled {
				t.Fatal("signalled", sys.sent)
			}
		})
	}
}

func TestRejectsUnboundInputs(t *testing.T) {
	sys := &fakeSystem{}
	for _, slot := range []string{"", "Applications/Farol.app", "/Applications/Farol", "/Applications/../Farol.app"} {
		if _, err := newTerminator(4242, slot, sys); !errors.Is(err, ErrInput) {
			t.Fatal(slot, err)
		}
	}
	if _, err := newTerminator(1, "/Applications/Farol.app", sys); !errors.Is(err, ErrInput) {
		t.Fatal("pid 1 accepted")
	}
	term, _ := newTerminator(4242, "/Applications/Farol.app", sys)
	if err := term.Signal(context.Background(), port.ProcessSignal(9)); !errors.Is(err, ErrInput) {
		t.Fatal("unknown signal accepted", err)
	}
}

func TestSlotFollowsTheInstallLocation(t *testing.T) {
	if got := Slot("/Users/x", true); got != "/Applications/Farol.app" {
		t.Fatal(got)
	}
	if got := Slot("/Users/x", false); got != "/Users/x/Applications/Farol.app" {
		t.Fatal(got)
	}
}
