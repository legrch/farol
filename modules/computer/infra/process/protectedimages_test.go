package process

import (
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestRootScopedProtectedImagesDoNotRejectWritableHomeOrGrantExecution(t *testing.T) {
	s, c := rootScopedFixture(t)
	root := "/owner/home"
	s.Home = root
	s.Snapshot.Participant.Grant.Workspaces[0].Root = root
	s.Snapshot.Approval.Workspaces[0].Root = root
	c.Root, c.Cwd, c.Write = root, root, true
	c.Environment = seatbeltEnvironment(s, true)
	image := root + "/Applications/Farol.app/Contents/MacOS/backend"
	s.ProtectedImages = []ExecutablePin{{image, strings.Repeat("e", 64)}}
	plan, err := compileSeatbelt(s, c)
	if err != nil {
		t.Fatal("approved writable HOME refused", err)
	}
	if !hasParameterRule(plan, "allow file-write*", "subpath", root) ||
		!hasParameterRule(plan, "deny file-write*", "literal", image) {
		t.Fatal("root access or protected image rule missing")
	}
	for _, path := range []string{root + "/Applications", root + "/Applications/Farol.app", root + "/Applications/Farol.app/Contents", root + "/Applications/Farol.app/Contents/MacOS"} {
		if !hasParameterRule(plan, "deny file-write-unlink", "literal", path) {
			t.Fatal("image ancestor can be renamed", path)
		}
		if hasParameterRule(plan, "deny file-write*", "subpath", path) {
			t.Fatal("ancestor protection denied ordinary sibling writes", path)
		}
	}
	for _, operation := range []string{"allow file-read*", "allow process-exec"} {
		if hasParameterRule(plan, operation, "literal", image) {
			t.Fatal("protected image added a new permission")
		}
	}
	// A protected image outside the scope likewise supplies no ambient permission.
	s.ProtectedImages[0].Path = "/separate/runtime/backend"
	outside, err := compileSeatbelt(s, c)
	if err != nil || hasParameterRule(outside, "allow process-exec", "literal", s.ProtectedImages[0].Path) ||
		hasParameterRule(outside, "allow file-read*", "literal", s.ProtectedImages[0].Path) {
		t.Fatal("outside protection broadened access", err)
	}
}

func TestRootScopedProtectedImagesAreFrozenMeasuredAndSealed(t *testing.T) {
	s, c := rootScopedFixture(t)
	image := ExecutablePin{"/owner/home/Applications/Farol/backend", strings.Repeat("e", 64)}
	s.ProtectedImages = []ExecutablePin{image}
	policy, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := policy.bind(c)
	if err != nil {
		t.Fatal(err)
	}
	s.ProtectedImages[0].Path = "/changed"
	launch, err := selectedLaunch(policy, bound)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, pin := range launch.pins {
		if pin == image {
			found = true
		}
	}
	if !found || policy.selection.ProtectedImages[0] != image {
		t.Fatal("protected image not frozen/measured")
	}
	before := *bound.Confinement
	policy.selection.ProtectedImages[0].SHA256 = strings.Repeat("f", 64)
	if _, err := selectedLaunch(policy, bound); err == nil {
		t.Fatal("changed protected image retained old seal")
	}
	c.Confinement = nil
	changed, err := policy.bind(c)
	if err != nil || *changed.Confinement == before {
		t.Fatal("protected image omitted from policy seal", err)
	}
}

func TestRootScopedProtectedImageInvalidSelectionRefuses(t *testing.T) {
	for _, mode := range []string{"duplicate", "executable-overlap", "scratch", "legacy", "bad-digest", "relative"} {
		t.Run(mode, func(t *testing.T) {
			s, c := rootScopedFixture(t)
			s.ProtectedImages = []ExecutablePin{{"/runtime/backend", strings.Repeat("e", 64)}}
			switch mode {
			case "duplicate":
				s.ProtectedImages = append(s.ProtectedImages, s.ProtectedImages[0])
			case "executable-overlap":
				s.ProtectedImages[0] = s.Executables[0]
			case "scratch":
				s.ProtectedImages[0].Path = s.Scratch + "/backend"
			case "legacy":
				s.FilePolicy = authority.LegacyProtectedFiles
			case "bad-digest":
				s.ProtectedImages[0].SHA256 = "not-a-hash"
			case "relative":
				s.ProtectedImages[0].Path = "runtime/backend"
			}
			if _, err := compileSeatbelt(s, c); err == nil {
				t.Fatal("invalid protection selected")
			}
		})
	}
}
