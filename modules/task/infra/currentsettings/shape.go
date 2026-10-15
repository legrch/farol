package currentsettings

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/legrch/farol/modules/task/app/port"
)

func object(v any, required, optional string) (map[string]any, bool) {
	o, ok := v.(map[string]any)
	if !ok {
		return nil, false
	}
	allowed := strings.Fields(required + " " + optional)
	for _, key := range strings.Fields(required) {
		if _, ok := o[key]; !ok {
			return nil, false
		}
	}
	for key := range o {
		found := false
		for _, name := range allowed {
			found = found || key == name
		}
		if !found {
			return nil, false
		}
	}
	return o, true
}
func text(v any) bool    { _, ok := v.(string); return ok }
func boolean(v any) bool { _, ok := v.(bool); return ok }
func oneOf(v any, options ...string) bool {
	for _, option := range options {
		if v == option {
			return true
		}
	}
	return false
}
func texts(o map[string]any, keys string) bool {
	for _, key := range strings.Fields(keys) {
		if !text(o[key]) {
			return false
		}
	}
	return true
}
func generation(v any) bool {
	s, ok := v.(string)
	if !ok || s == "" || len(s) > 16 || (len(s) > 1 && s[0] == '0') {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(s, 10, 64)
	return err == nil && n <= 9007199254740991
}
func positiveNumber(v any) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	// Source adapters emit integer tokens. The source schema admits positive
	// safe generations/revisions/times; no identity passes through float64.
	i, err := strconv.ParseUint(string(n), 10, 64)
	return err == nil && i > 0 && i <= 9007199254740991
}
func identity(v any, nullable bool) bool {
	if v == nil {
		return nullable
	}
	o, ok := object(v, "device inode", "")
	if !ok {
		return false
	}
	for _, key := range []string{"device", "inode"} {
		s, ok := o[key].(string)
		if !ok || len(s) < 1 || len(s) > 20 {
			return false
		}
		for _, c := range s {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	return true
}
func git(v any) bool {
	if v == nil {
		return true
	}
	o, ok := object(v, "gitDirectory commonDirectory", "")
	return ok && texts(o, "gitDirectory commonDirectory")
}
func local(v any, nullable bool) bool {
	if v == nil {
		return nullable
	}
	o, ok := object(v, "executableSha256 schemaSha256 buildId verifiedAt", "")
	return ok && texts(o, "executableSha256 schemaSha256 buildId verifiedAt")
}
func route(v any) bool {
	if v == nil {
		return true
	}
	o, ok := object(v, "transport socketPath expectedCodexHome workspaceId projectId projectRoot projectIdentity gitCommonDirectory execution harness computerGeneration hostGeneration approvedAt expiresAt", "observeThreadId observeTurnId")
	if !ok || !texts(o, "transport socketPath expectedCodexHome workspaceId projectId projectRoot gitCommonDirectory harness approvedAt") || !identity(o["projectIdentity"], false) {
		return false
	}
	if !oneOf(o["transport"], "codex-shared-proxy/v1") || !oneOf(o["harness"], "codex") {
		return false
	}
	if !positiveNumber(o["computerGeneration"]) || !positiveNumber(o["hostGeneration"]) || !positiveNumber(o["expiresAt"]) {
		return false
	}
	execution, ok := object(o["execution"], "sandbox approvalPolicy", "")
	if !ok || !oneOf(execution["sandbox"], "read-only", "workspace-write") || !oneOf(execution["approvalPolicy"], "untrusted", "on-request") {
		return false
	}
	for _, key := range []string{"observeThreadId", "observeTurnId"} {
		if v, exists := o[key]; exists && !text(v) {
			return false
		}
	}
	_, turn := o["observeTurnId"]
	_, thread := o["observeThreadId"]
	return !turn || thread
}
func witness(v any, followup bool) bool {
	o, ok := object(v, "executablePath executableSha256 baseSchemaSha256 status", "code contract")
	if !ok || !texts(o, "executablePath executableSha256 baseSchemaSha256 status") {
		return false
	}
	if o["status"] == "unavailable" {
		_, contract := o["contract"]
		return !contract && oneOf(o["code"], "CODEX_HOST_SCHEMA_UNSAFE", "CODEX_HOST_SCHEMA_INVALID", "CODEX_HOST_HANDOFF_UNAVAILABLE", "CODEX_HOST_FOLLOWUP_UNAVAILABLE", "CODEX_HOST_TASK_SOURCE_CHANGED", "CODEX_HOST_TASK_SOURCE_UNCONFIRMED")
	}
	if o["status"] != "supported" {
		return false
	}
	if _, exists := o["code"]; exists {
		return false
	}
	if followup {
		c, ok := object(o["contract"], "kind protocol baseSchemaSha256 schemaSha256", "")
		return ok && texts(c, "kind protocol baseSchemaSha256 schemaSha256")
	}
	c, ok := object(o["contract"], "version protocol schemaSha256 projectBoundCreateStatus", "")
	return ok && texts(c, "version protocol schemaSha256") && c["projectBoundCreateStatus"] == true
}
func source(v any) bool {
	if v == nil {
		return true
	}
	o, ok := object(v, "hostGeneration localVerification evidence", "")
	if !ok || !positiveNumber(o["hostGeneration"]) || !local(o["localVerification"], false) {
		return false
	}
	e, ok := object(o["evidence"], "handoff followup", "")
	return ok && witness(e["handoff"], false) && witness(e["followup"], true)
}
func host(v any) bool {
	if v == nil {
		return true
	}
	o, ok := object(v, "executablePath executableSha256 version protocol schemaSha256 localVerification", "verifiedAt taskSource liveVerification agentVerification")
	if !ok || !texts(o, "executablePath executableSha256 version protocol schemaSha256") || !local(o["localVerification"], true) || !source(o["taskSource"]) {
		return false
	}
	if v, exists := o["verifiedAt"]; exists && !text(v) {
		return false
	}
	// Inert saved live/agent fields are opaque object-or-null source data.
	for _, key := range []string{"liveVerification", "agentVerification"} {
		if v := o[key]; v != nil {
			if _, ok := v.(map[string]any); !ok {
				return false
			}
		}
	}
	return true
}
func verified(v any) bool {
	if v == nil {
		return true
	}
	o, ok := object(v, "profile configRevision workspaceId runtimeGeneration buildId protocol verifiedAt", "")
	return ok && texts(o, "profile runtimeGeneration buildId protocol verifiedAt") && positiveNumber(o["configRevision"]) && (o["workspaceId"] == nil || text(o["workspaceId"]))
}

func facts(v any) (port.TaskCurrentSettingsFacts, error) {
	var f port.TaskCurrentSettingsFacts
	o, ok := v.(map[string]any)
	if !ok {
		return f, errInvalid
	}
	if o["status"] == "settings-invalid" {
		if len(o) != 1 {
			return f, errInvalid
		}
		return port.TaskCurrentSettingsFacts{Status: "settings-invalid"}, nil
	}
	o, ok = object(v, "status tasks nativeHosts computer setup", "")
	if !ok || o["status"] != "parsed" {
		return f, errInvalid
	}
	n, ok := object(o["nativeHosts"], "generation route host", "")
	if !ok || !generation(n["generation"]) || !route(n["route"]) || !host(n["host"]) {
		return f, errInvalid
	}
	c, ok := object(o["computer"], "computerId generation workspaces", "")
	if !ok || !text(c["computerId"]) || !generation(c["generation"]) {
		return f, errInvalid
	}
	s, ok := object(o["setup"], "verified reachable outcomeUnknown", "")
	if !ok || !verified(s["verified"]) || !oneOf(s["reachable"], "unknown", "reachable", "unreachable") || !boolean(s["outcomeUnknown"]) {
		return f, errInvalid
	}
	workspaces, ok := c["workspaces"].([]any)
	if !ok {
		return f, errInvalid
	}
	f = port.TaskCurrentSettingsFacts{Status: "parsed", NativeHosts: port.TaskCurrentNativeHosts{Generation: n["generation"].(string)},
		Computer: port.TaskCurrentComputer{ComputerID: c["computerId"].(string), Generation: c["generation"].(string), Workspaces: []port.TaskCurrentWorkspace{}},
		Setup:    port.TaskCurrentSetup{Verified: value(s["verified"]), Reachable: s["reachable"].(string), OutcomeUnknown: s["outcomeUnknown"].(bool)}}
	f.Tasks, _ = json.Marshal(o["tasks"])
	if n["route"] != nil {
		f.NativeHosts.Route = value(n["route"]).(map[string]any)
	}
	if n["host"] != nil {
		f.NativeHosts.Host = value(n["host"]).(map[string]any)
	}
	for _, v := range workspaces {
		w, ok := object(v, "workspaceId root access rootIdentity gitMetadata excludedPaths gitHistoryApproved", "")
		if !ok || !texts(w, "workspaceId root access") || !oneOf(w["access"], "read", "write") || !identity(w["rootIdentity"], true) || !git(w["gitMetadata"]) || (w["gitHistoryApproved"] != nil && !boolean(w["gitHistoryApproved"])) {
			return port.TaskCurrentSettingsFacts{}, errInvalid
		}
		exclusions, ok := w["excludedPaths"].([]any)
		if !ok {
			return port.TaskCurrentSettingsFacts{}, errInvalid
		}
		workspace := port.TaskCurrentWorkspace{WorkspaceID: w["workspaceId"].(string), Root: w["root"].(string), Access: w["access"].(string), RootIdentity: value(w["rootIdentity"]), GitMetadata: value(w["gitMetadata"]), ExcludedPaths: []string{}}
		if w["gitHistoryApproved"] != nil {
			b := w["gitHistoryApproved"].(bool)
			workspace.GitHistoryApproved = &b
		}
		for _, v := range exclusions {
			if !text(v) {
				return port.TaskCurrentSettingsFacts{}, errInvalid
			}
			workspace.ExcludedPaths = append(workspace.ExcludedPaths, v.(string))
		}
		f.Computer.Workspaces = append(f.Computer.Workspaces, workspace)
	}
	return f, nil
}
