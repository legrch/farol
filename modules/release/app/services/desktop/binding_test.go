package desktop

import (
	"github.com/legrch/farol/modules/release/app/port"
	"strings"
	"testing"
)

func binding() port.DesktopLifetimeBinding {
	return port.DesktopLifetimeBinding{Schema: "farol.desktop-helper-lifetime/1", OperationID: strings.Repeat("a", 32), Action: "apply", Location: "shared",
		Source:      port.DesktopLifetimeBuild{strings.Repeat("b", 64), strings.Repeat("c", 64), "0.5.2"},
		Target:      port.DesktopLifetimeBuild{strings.Repeat("d", 64), strings.Repeat("e", 64), "0.5.3"},
		Predecessor: port.DesktopLifetimeProcess{10, "Sat Oct 31 23:31:30 2026"}, Helper: port.DesktopLifetimeProcess{11, "Sat Oct 31 23:31:35 2026"}, Deadline: 1001}
}

func TestBindingRefusesWrongCustodyAndRenewedDeadline(t *testing.T) {
	if !Valid(binding(), 10, 1000) {
		t.Fatal("valid binding refused")
	}
	for name, change := range map[string]func(*port.DesktopLifetimeBinding){
		"schema":                  func(b *port.DesktopLifetimeBinding) { b.Schema = "other" },
		"operation":               func(b *port.DesktopLifetimeBinding) { b.OperationID = "x" },
		"action":                  func(b *port.DesktopLifetimeBinding) { b.Action = "retry" },
		"location":                func(b *port.DesktopLifetimeBinding) { b.Location = "other" },
		"source":                  func(b *port.DesktopLifetimeBinding) { b.Source.BuildID = "x" },
		"same-content":            func(b *port.DesktopLifetimeBinding) { b.Target.Digest = b.Source.Digest },
		"guardian-as-predecessor": func(b *port.DesktopLifetimeBinding) { b.Predecessor.PID = 12 },
		"helper-is-desktop":       func(b *port.DesktopLifetimeBinding) { b.Helper.PID = 10 },
		"missing-birth":           func(b *port.DesktopLifetimeBinding) { b.Helper.Start = "" },
		"expired":                 func(b *port.DesktopLifetimeBinding) { b.Deadline = 1000 },
		"renewed":                 func(b *port.DesktopLifetimeBinding) { b.Deadline = 301001 },
	} {
		t.Run(name, func(t *testing.T) {
			b := binding()
			change(&b)
			if Valid(b, 10, 1000) {
				t.Fatal("invalid binding accepted")
			}
		})
	}
}
