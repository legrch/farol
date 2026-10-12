package boot

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func shellLaunchFixture(t *testing.T) (json.RawMessage, NativeLaunch) {
	t.Helper()
	data, err := os.ReadFile("../tests/fixtures/shell-launch.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Payload json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(data, &fixture) != nil {
		t.Fatal("invalid shared synthetic fixture")
	}
	return fixture.Payload, NativeLaunch{Profile: ProfileBinding{ProfileID: "fixture-profile"}, Home: "/Users/fixture",
		HostLifetimeID: "fixture-host", ChildLaunchID: "fixture-child", SettingsMutations: true}
}

func TestShellLaunchSharedHostProjection(t *testing.T) {
	// Value decoding only. Shared fixture pins are synthetic, not qualification.
	raw, launch := shellLaunchFixture(t)
	config, err := decodeShellLaunch(raw, launch)
	if err != nil || config == nil {
		t.Fatal(err)
	}
	if config.runtimeID != launch.ChildLaunchID || config.home != launch.Home || config.support.OS != "darwin" ||
		config.support.ProtectedBundle.Path != "/Applications/Farol.app" || config.support.ProtectedBundle.Identity.Inode != "42" ||
		config.support.Backend.SHA256 != strings.Repeat("c", 64) || config.watchdog.Executable != config.support.Watchdog ||
		string(config.watchdog.Source) != "// Synthetic watchdog fixture; never executed.\n" || len(config.support.Executables) != 2 {
		t.Fatal("cross-language mapping changed")
	}
	for i := range raw {
		raw[i] = 0
	}
	if config.support.ReleaseID != "fixture-release" {
		t.Fatal("decoded selection retained mutable input")
	}
}

func TestShellLaunchRefusesCrossedLifetimeAndMalformedValues(t *testing.T) {
	raw, launch := shellLaunchFixture(t)
	for _, pair := range [][2]string{
		{`"BuildID": "development"`, `"BuildID": "other"`},
		{`"ProfileID": "fixture-profile"`, `"ProfileID": "other"`},
		{`"HostLifetimeID": "fixture-host"`, `"HostLifetimeID": "other"`},
		{`"ChildLaunchID": "fixture-child"`, `"ChildLaunchID": "other"`},
		{`"Schema": "farol-shell-launch/1"`, `"Schema": "farol-shell-launch/2"`},
		{`"BuildID":`, `"buildid":`},
		{`"Support":`, `"support":`},
		{`"Architecture":`, `"architecture":`},
		{`"Inode": "42"`, `"Inode": 42`},
		{`"BuildID": "development"`, `"BuildID": "development", "BuildID": "development"`},
		{`"ReleaseID": "fixture-release"`, `"ReleaseID": "fixture-release", "Extra": true`},
		{`"WatchdogSourceBase64":`, `"Extra": true, "WatchdogSourceBase64":`},
		{`Contents/Resources/app/farol-backend`, `Contents/Resources/app/other`},
		{`Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron`, `Contents/MacOS/other`},
	} {
		changed := strings.Replace(string(raw), pair[0], pair[1], 1)
		if changed == string(raw) {
			t.Fatal("invalid negative fixture", pair[0])
		}
		if config, err := decodeShellLaunch([]byte(changed), launch); err == nil || config != nil {
			t.Fatal("crossed payload accepted", pair[0])
		}
	}
	for _, data := range [][]byte{nil, []byte("null"), []byte("{}"), append(append([]byte(nil), raw...), []byte("{}")...), make([]byte, shellLaunchMaximumBytes+1)} {
		if config, err := decodeShellLaunch(data, launch); err == nil || config != nil {
			t.Fatal("malformed payload accepted")
		}
	}
	for _, change := range []func(*NativeLaunch){
		func(v *NativeLaunch) { v.SettingsMutations = false },
		func(v *NativeLaunch) { v.HostLifetimeID = "" },
		func(v *NativeLaunch) { v.ChildLaunchID = "other" },
		func(v *NativeLaunch) { v.Profile.ProfileID = "other" },
	} {
		other := launch
		change(&other)
		if config, err := decodeShellLaunch(raw, other); err == nil || config != nil {
			t.Fatal("crossed launch accepted")
		}
	}
}

func TestShellLaunchRejectsMissingBundleAndChangedSource(t *testing.T) {
	raw, launch := shellLaunchFixture(t)
	for _, change := range []func(*shellLaunchPayload){
		func(p *shellLaunchPayload) { p.Support.ProtectedBundle = nil },
		func(p *shellLaunchPayload) { p.WatchdogSourceBase64 = "" },
		func(p *shellLaunchPayload) { p.WatchdogSourceBase64 += "\n" },
		func(p *shellLaunchPayload) { p.WatchdogSourceBase64 = "/w==" },
		func(p *shellLaunchPayload) { p.Support.WatchdogSourceSHA256 = strings.Repeat("a", 64) },
	} {
		var payload shellLaunchPayload
		if json.Unmarshal(raw, &payload) != nil {
			t.Fatal("fixture")
		}
		change(&payload)
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if config, err := decodeShellLaunch(data, launch); err == nil || config != nil {
			t.Fatal("invalid source/bundle accepted")
		}
	}
}
