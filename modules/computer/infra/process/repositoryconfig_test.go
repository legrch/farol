package process

import (
	"regexp"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Pure policy/profile compilation only. No files, native qualification or
// processes are used; emitted rules are not kernel enforcement evidence.
func TestRepositoryConfigPureHomeOnlyProtection(t *testing.T) {
	const home = "/owner/home"
	for _, path := range []string{"/repo/.npmrc", "/repo/nested/.NPMRC", home + "/code/repo/.npmrc", home + "grown/.npmrc"} {
		if protectedPath(path, home) || protectedScope(path, home) || regexp.MustCompile(credentialRegex()).MatchString(path) {
			t.Fatal("ordinary repository config blanket-denied", path)
		}
	}
	for _, path := range []string{home + "/.npmrc", "/OWNER/HOME/.NPMRC", home + "/.npmrc/child", home + "/.NPMRC/ancestor/repo"} {
		if !protectedPath(path, home) || !protectedScope(path, home) {
			t.Fatal("HOME credential alias lost", path)
		}
	}
	for _, root := range []string{"/owner", home, "/OWNER/HOME"} {
		if !protectedScope(root, home) {
			t.Fatal("enclosing HOME scope accepted", root)
		}
	}
}

func TestRepositoryConfigPureSelectedProfile(t *testing.T) {
	for _, shape := range []string{"repository", "nested", "direct", "ancestor", "home-approval"} {
		t.Run(shape, func(t *testing.T) {
			_, s, c, evidence := confinementFixture(t)
			root := s.Home + "/code/repo"
			if shape == "direct" || shape == "ancestor" {
				root += "/.NPMRC"
			}
			if shape == "ancestor" {
				root += "/repo"
			}
			s.Snapshot.Approval.Workspaces[0].Root = root
			s.Snapshot.Participant.Grant.Workspaces[0].Root = root
			c.Root, c.Cwd = root, root
			if shape == "nested" {
				c.Cwd += "/nested/.npmrc"
			}
			if shape == "home-approval" {
				c.Root, s.Snapshot.Approval.Workspaces[0].Root = s.Home, s.Home
			}
			for _, write := range []bool{false, true} {
				c.Write, c.Environment = write, seatbeltEnvironment(s, write)
				plan, err := compileSeatbelt(s, c)
				if err != nil {
					t.Fatal("approved repository config scope refused", err)
				}
				if !hasParameterRule(plan, "allow file-read*", "subpath", root) || hasParameterRule(plan, "allow file-write*", "subpath", root) != write ||
					!hasParameterRule(plan, "deny file-read* file-write*", "subpath", s.Home+"/.npmrc") || hasParameterRule(plan, "deny file-read* file-write*", "subpath", root+"/.npmrc") {
					t.Fatal("HOME-only rule or separate write scope lost")
				}
				for _, text := range []string{"(deny default)", "(deny network*)", `(regex #"/[.]git(/|$)")`} {
					if !strings.Contains(plan.source, text) {
						t.Fatal("unchanged guard lost", text)
					}
				}
			}
			// Explicit exclusions from either policy remain stronger than the grant.
			for _, owner := range []bool{false, true} {
				excluded := root + "/.NPMRC"
				e := []authority.Exclusion{{WorkspaceID: "work", Path: excluded}}
				if owner {
					s.Snapshot.Approval.ExcludedPaths = e
				} else {
					s.Snapshot.Participant.Grant.ExcludedPaths = e
				}
				plan, err := compileSeatbelt(s, c)
				if err != nil || !hasParameterRule(plan, "deny file-read* file-write*", "subpath", excluded) {
					t.Fatal("explicit repository exclusion omitted", err)
				}
			}
			if evidence.calls != 0 {
				t.Fatal("pure compilation invoked native evidence")
			}
		})
	}
}
