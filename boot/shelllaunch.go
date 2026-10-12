package boot

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"path/filepath"
	"reflect"
	"unicode/utf8"

	nativeprocess "github.com/legrch/farol/modules/computer/infra/process"
	"github.com/legrch/farol/pkg/ipc"
)

const shellLaunchMaximumBytes = 256 * 1024

// Private inherited-host payload. Field spelling deliberately follows the Go
// support values; no renderer, MCP body, environment or runtime file is a source.
// The verified packaged host must supply independently accepted support and
// attest its dependency closure. This channel binds a launch; it is not an issuer.
type shellLaunchPayload struct {
	Schema, BuildID, ProfileID, HostLifetimeID, ChildLaunchID string
	Support                                                   nativeprocess.RootScopedPlatformSupport
	WatchdogSourceBase64                                      string
}

func shellLaunchRefusal() error { return connectorProcessRefusal("SHELL_LAUNCH_METADATA_INVALID") }

func decodeShellLaunch(raw []byte, launch NativeLaunch) (*connectorShellConfig, error) {
	if len(raw) == 0 || len(raw) > shellLaunchMaximumBytes || ipc.ValidateJSON(raw) != nil ||
		!emptyRecoveryCanonicalFields(raw, reflect.TypeFor[shellLaunchPayload]()) ||
		!launch.SettingsMutations || !validIngressID(launch.HostLifetimeID) || !validIngressID(launch.ChildLaunchID) {
		return nil, shellLaunchRefusal()
	}
	var payload shellLaunchPayload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || decoder.Decode(new(any)) != io.EOF || payload.Schema != "farol-shell-launch/1" ||
		payload.BuildID != BuildID || payload.ProfileID != launch.Profile.ProfileID || payload.HostLifetimeID != launch.HostLifetimeID || payload.ChildLaunchID != launch.ChildLaunchID ||
		payload.Support.ProtectedBundle == nil {
		return nil, shellLaunchRefusal()
	}
	bundle := payload.Support.ProtectedBundle
	if !validProfilePath(bundle.Path) || payload.Support.Backend.Path != filepath.Join(bundle.Path, "Contents/Resources/app/farol-backend") ||
		payload.Support.Watchdog.Path != filepath.Join(bundle.Path, "Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron") {
		return nil, shellLaunchRefusal()
	}
	source, err := base64.StdEncoding.Strict().DecodeString(payload.WatchdogSourceBase64)
	if err != nil || len(source) == 0 || len(source) > 64*1024 || !utf8.Valid(source) || base64.StdEncoding.EncodeToString(source) != payload.WatchdogSourceBase64 {
		return nil, shellLaunchRefusal()
	}
	digest := sha256.Sum256(source)
	if hex.EncodeToString(digest[:]) != payload.Support.WatchdogSourceSHA256 {
		return nil, shellLaunchRefusal()
	}
	return &connectorShellConfig{runtimeID: launch.ChildLaunchID, home: launch.Home, support: payload.Support,
		watchdog: nativeprocess.WatchdogSelection{Executable: payload.Support.Watchdog, Source: source, SourceSHA256: payload.Support.WatchdogSourceSHA256}}, nil
}
