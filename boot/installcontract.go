package boot

import (
	"encoding/json"
	"strings"
)

// The installer admits only the completed stable receipt shape that the
// installed startup consumer can parse. Keep these checks aligned with
// SavedReceipt, Journal and parseRetainedGithubReleaseManifest.
func installObject(raw []byte, required, optional []string) (map[string]json.RawMessage, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, false
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = true
		if _, exists := object[key]; !exists {
			return nil, false
		}
	}
	for _, key := range optional {
		allowed[key] = true
	}
	for key := range object {
		if !allowed[key] {
			return nil, false
		}
	}
	return object, true
}

func installString(object map[string]json.RawMessage, key string) (string, bool) {
	raw, exists := object[key]
	if !exists || len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

func installBool(object map[string]json.RawMessage, key string) (bool, bool) {
	raw, exists := object[key]
	if !exists || len(raw) == 0 || (raw[0] != 't' && raw[0] != 'f') {
		return false, false
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return false, false
	}
	return value, true
}

func installHexString(value string, width int) bool {
	if len(value) != width {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func installSavedBuild(raw []byte, build installBuild) bool {
	object, ok := installObject(raw, []string{"digest", "version", "buildId"}, nil)
	if !ok || !validInstallBuild(build) {
		return false
	}
	for key, expected := range map[string]string{"digest": build.Digest, "version": build.Version, "buildId": build.BuildID} {
		value, valid := installString(object, key)
		if !valid || value != expected {
			return false
		}
	}
	return true
}

func installSavedOperation(raw []byte, operation installOperation) bool {
	object, ok := installObject(raw, []string{"operationId", "source", "target"}, nil)
	if !ok || !installHexString(operation.ID, 32) || !installSavedBuild(object["source"], operation.Source) || !installSavedBuild(object["target"], operation.Target) {
		return false
	}
	id, valid := installString(object, "operationId")
	return valid && id == operation.ID
}

func installManifestValues(raw []byte, allowRetainedRepository bool) (map[string]string, bool) {
	required := []string{"schema", "repository", "channel", "product", "bundleId", "version", "buildVersion", "sourceCommit", "sourceTreeDigest", "buildId", "artifactSha256", "archiveSha256", "archiveName", "archiveSize", "platform", "arch", "signing", "notarized", "sourceDirty"}
	object, ok := installObject(raw, required, nil)
	if !ok {
		return nil, false
	}
	values := make(map[string]string, len(required))
	for _, key := range required {
		if key == "archiveSize" || key == "notarized" || key == "sourceDirty" {
			continue
		}
		value, valid := installString(object, key)
		if !valid {
			return nil, false
		}
		values[key] = value
	}
	var archiveSize int64
	if json.Unmarshal(object["archiveSize"], &archiveSize) != nil || archiveSize < 1 || archiveSize > 2147483648 {
		return nil, false
	}
	notarized, valid := installBool(object, "notarized")
	if !valid || notarized {
		return nil, false
	}
	sourceDirty, valid := installBool(object, "sourceDirty")
	if !valid || sourceDirty {
		return nil, false
	}
	repository := values["repository"]
	valid = values["schema"] == "farol.github-release/1" &&
		(repository == "legrch/farol" || (allowRetainedRepository && repository == "legrch/farol-releases")) &&
		values["channel"] == "stable" && values["product"] == "Farol" &&
		values["bundleId"] == "io.github.legrch.farol" &&
		installStableVersion(values["version"]) &&
		installBuildVersion(values["buildVersion"]) &&
		installHexString(values["sourceCommit"], 40) &&
		installHexString(values["sourceTreeDigest"], 64) &&
		installHexString(values["buildId"], 64) &&
		installHexString(values["artifactSha256"], 64) &&
		installHexString(values["archiveSha256"], 64) &&
		values["archiveName"] == "Farol-"+values["version"]+"-darwin-arm64.zip" &&
		!strings.Contains(values["archiveName"], "..") &&
		values["platform"] == "darwin" && values["arch"] == "arm64" &&
		values["signing"] == "unsigned"
	return values, valid
}

func installRetainedManifest(raw []byte, saved installSavedUpdate) bool {
	values, valid := installManifestValues(raw, true)
	return valid &&
		values["version"] == saved.Manifest.Version &&
		values["buildVersion"] == saved.Manifest.BuildVersion &&
		values["buildId"] == saved.Manifest.BuildID &&
		values["artifactSha256"] == saved.Manifest.ArtifactSha256
}

func installAdoptedBaseline(raw []byte, profile string, candidate installReleaseManifest) bool {
	object, ok := installObject(raw, []string{"schema", "slot", "userData", "manifest", "adoptedAt"}, nil)
	if !ok {
		return false
	}
	for key, expected := range map[string]string{"schema": "farol.adopted-baseline/1", "slot": "/Applications/Farol.app", "userData": profile} {
		value, valid := installString(object, key)
		if !valid || value != expected {
			return false
		}
	}
	adoptedAt, valid := installString(object, "adoptedAt")
	if !valid || len(adoptedAt) > 64 {
		return false
	}
	values, valid := installManifestValues(object["manifest"], false)
	if !valid {
		return false
	}
	if values["buildId"] == candidate.BuildID {
		return values["version"] == candidate.Version && values["buildVersion"] == candidate.BuildVersion && values["artifactSha256"] == candidate.ArtifactSha256
	}
	return true
}

func installSavedReceipt(raw []byte, saved installSavedUpdate) bool {
	required := []string{"schema", "handle", "manifest", "operation", "observedAt", "phase", "runningBuildId"}
	optional := []string{"notes", "downloadId", "archiveReleased", "helper"}
	object, ok := installObject(raw, required, optional)
	if !ok || !installSavedOperation(object["operation"], saved.Operation) || !installRetainedManifest(object["manifest"], saved) {
		return false
	}
	for key, expected := range map[string]string{"schema": saved.Schema, "phase": saved.Phase, "runningBuildId": saved.RunningBuildID} {
		value, valid := installString(object, key)
		if !valid || value != expected {
			return false
		}
	}
	handle, valid := installString(object, "handle")
	if !valid || len(handle) == 0 || len(handle) > 4096 {
		return false
	}
	observed, valid := installString(object, "observedAt")
	if !valid || len(observed) > 64 {
		return false
	}
	if _, exists := object["notes"]; exists {
		notes, valid := installString(object, "notes")
		if !valid || len(notes) > 4096 {
			return false
		}
	}
	if _, exists := object["downloadId"]; exists {
		id, valid := installString(object, "downloadId")
		if !valid || !installHexString(id, 32) {
			return false
		}
	}
	if _, exists := object["archiveReleased"]; exists {
		if _, valid := installBool(object, "archiveReleased"); !valid {
			return false
		}
	}
	helper, exists := object["helper"]
	if !exists || saved.Helper == nil {
		return false
	}
	helperObject, valid := installObject(helper, []string{"pid", "processStart"}, nil)
	if !valid || saved.Helper.PID < 2 || int64(saved.Helper.PID) > 9007199254740991 {
		return false
	}
	var pid int64
	if json.Unmarshal(helperObject["pid"], &pid) != nil || pid != int64(saved.Helper.PID) {
		return false
	}
	start, valid := installString(helperObject, "processStart")
	return valid && saved.Helper.ProcessStart != nil && start == *saved.Helper.ProcessStart && len(start) >= 1 && len(start) <= 128
}

func installSavedJournal(raw []byte, journal installJournal) bool {
	object, ok := installObject(raw, []string{"schema", "phase", "operationId", "source", "target"}, nil)
	if !ok || !installSavedBuild(object["source"], journal.Source) || !installSavedBuild(object["target"], journal.Target) {
		return false
	}
	for key, expected := range map[string]string{"schema": journal.Schema, "phase": journal.Phase, "operationId": journal.OperationID} {
		value, valid := installString(object, key)
		if !valid || value != expected {
			return false
		}
	}
	return true
}
