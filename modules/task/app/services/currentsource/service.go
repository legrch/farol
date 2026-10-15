package currentsource

import (
	"context"
	"strconv"

	"github.com/legrch/farol/modules/task/app/port"
)

type Service struct {
	decoder  port.TaskCurrentSettingsDecoder
	resolver port.TaskSourceModelResolver
}

func New(decoder port.TaskCurrentSettingsDecoder, resolver port.TaskSourceModelResolver) *Service {
	return &Service{decoder: decoder, resolver: resolver}
}
func fail(code string) (*Result, error) { return nil, &Failure{Code: code} }

// Resolve consumes one immutable caller snapshot and explicit sampled clock.
// Saved metadata is not a physical recheck, publication or Task admission.
func (s *Service) Resolve(ctx context.Context, raw []byte, nowMillis int64) (*Result, error) {
	if s == nil || s.decoder == nil || s.resolver == nil || ctx == nil || ctx.Err() != nil {
		return fail(Unavailable)
	}
	if len(raw) > MaxSnapshotBytes || nowMillis < -maxSafe || nowMillis > maxSafe {
		return fail(Invalid)
	}
	facts, err := s.decoder.Decode(append([]byte(nil), raw...))
	if ctx.Err() != nil {
		return fail(Unavailable)
	}
	if err != nil {
		return fail(Invalid)
	}
	if facts.Status == "settings-invalid" {
		return &Result{Status: Absent}, nil
	}
	if facts.Status != "parsed" {
		return fail(Invalid)
	}
	r, h := facts.NativeHosts.Route, facts.NativeHosts.Host
	if r == nil || h == nil || text(r["harness"]) != "codex" {
		return &Result{Status: Absent}, nil
	}
	if ctx.Err() != nil {
		return fail(Unavailable)
	}
	resolution, err := s.resolver.ResolveTaskSourceModel(ctx, append([]byte(nil), facts.Tasks...))
	if ctx.Err() != nil || err != nil {
		return fail(Unavailable)
	}
	switch resolution.Status {
	case "config-missing", "config-invalid", "harness-missing", "harness-unsupported", "model-missing":
		if resolution.Selection != nil {
			return fail(Unavailable)
		}
		return &Result{Status: Absent}, nil
	case "ready":
		if !validModel(resolution.Selection) {
			return fail(Unavailable)
		}
	default:
		return fail(Unavailable)
	}
	source := derive(facts, nowMillis, resolution.Selection)
	if ctx.Err() != nil {
		return fail(Unavailable)
	}
	if source == nil {
		return &Result{Status: Absent}, nil
	}
	result := &Result{Status: Available, Source: source}
	if facts.Setup.Reachable == "reachable" && !facts.Setup.OutcomeUnknown {
		thread, turn := text(r["observeThreadId"]), text(r["observeTurnId"])
		if thread != "" && turn != "" {
			result.Read = &ReadReference{ThreadID: thread, TurnID: turn}
		}
	}
	if ctx.Err() != nil {
		return fail(Unavailable)
	}
	return result, nil
}

func derive(f port.TaskCurrentSettingsFacts, now int64, model *port.TaskSourceModelSelection) *CodexSource {
	r, h := f.NativeHosts.Route, f.NativeHosts.Host
	if !closed(r, "transport socketPath expectedCodexHome workspaceId projectId projectRoot projectIdentity gitCommonDirectory execution harness computerGeneration hostGeneration approvedAt expiresAt", "observeThreadId observeTurnId") || text(r["transport"]) != "codex-shared-proxy/v1" || !validReference(r) {
		return nil
	}
	if !identifierPattern.MatchString(text(r["workspaceId"])) || !identifierPattern.MatchString(text(r["projectId"])) || !identity(r["projectIdentity"]) {
		return nil
	}
	if !closed(h, "executablePath executableSha256 version protocol schemaSha256 localVerification", "verifiedAt taskSource liveVerification agentVerification") || !versionPattern.MatchString(text(h["version"])) || text(h["protocol"]) != protocol {
		return nil
	}
	if !digestPattern.MatchString(text(h["executableSha256"])) || !digestPattern.MatchString(text(h["schemaSha256"])) {
		return nil
	}
	if _, ok := timestamp(text(h["verifiedAt"])); !ok {
		return nil
	}
	var w *port.TaskCurrentWorkspace
	for i := range f.Computer.Workspaces {
		if f.Computer.Workspaces[i].WorkspaceID == text(r["workspaceId"]) {
			if w != nil {
				return nil
			}
			w = &f.Computer.Workspaces[i]
		}
	}
	if w == nil || !identity(w.RootIdentity) || w.GitHistoryApproved == nil || !*w.GitHistoryApproved || len(w.ExcludedPaths) != 0 || (w.Access != "read" && w.Access != "write") {
		return nil
	}
	git, v, record := obj(w.GitMetadata), obj(f.Setup.Verified), obj(h["taskSource"])
	if !closed(git, "gitDirectory commonDirectory", "") || !closed(v, "profile configRevision workspaceId runtimeGeneration buildId protocol verifiedAt", "") || !closed(record, "hostGeneration localVerification evidence", "") {
		return nil
	}
	for _, k := range []string{"profile", "runtimeGeneration", "protocol"} {
		if !nonempty(text(v[k]), 160) {
			return nil
		}
	}
	if !digestPattern.MatchString(text(v["buildId"])) {
		return nil
	}
	if _, ok := timestamp(text(v["verifiedAt"])); !ok {
		return nil
	}
	execution := obj(r["execution"])
	if !closed(execution, "sandbox approvalPolicy", "") {
		return nil
	}
	sandbox, approval := text(execution["sandbox"]), text(execution["approvalPolicy"])
	if (sandbox != "read-only" && sandbox != "workspace-write") || (approval != "untrusted" && approval != "on-request") || (sandbox == "workspace-write" && w.Access != "write") {
		return nil
	}
	hostGeneration, hgOK := generation(f.NativeHosts.Generation)
	computerGeneration, cgOK := generation(f.Computer.Generation)
	routeHost, rhOK := positive(r["hostGeneration"])
	routeComputer, rcOK := positive(r["computerGeneration"])
	recordHost, reOK := positive(record["hostGeneration"])
	verifiedComputer, vcOK := positive(v["configRevision"])
	if !hgOK || !cgOK || !rhOK || !rcOK || !reOK || !vcOK || routeHost != hostGeneration || routeComputer != computerGeneration || recordHost != hostGeneration || verifiedComputer != computerGeneration || text(v["workspaceId"]) != text(r["workspaceId"]) || text(git["commonDirectory"]) != text(r["gitCommonDirectory"]) {
		return nil
	}
	if !local(h["localVerification"]) || !local(record["localVerification"]) {
		return nil
	}
	l, rl := obj(h["localVerification"]), obj(record["localVerification"])
	if text(l["executableSha256"]) != text(h["executableSha256"]) || text(l["schemaSha256"]) != text(h["schemaSha256"]) {
		return nil
	}
	for _, k := range []string{"executableSha256", "schemaSha256", "buildId", "verifiedAt"} {
		if text(l[k]) != text(rl[k]) {
			return nil
		}
	}
	evidence := obj(record["evidence"])
	if !closed(evidence, "handoff followup", "") {
		return nil
	}
	handoff, followup := obj(evidence["handoff"]), obj(evidence["followup"])
	if !witness(handoff, h, false) || !witness(followup, h, true) || text(handoff["status"]) != "supported" {
		return nil
	}
	hc := obj(handoff["contract"])
	if text(hc["version"]) != text(h["version"]) || text(hc["protocol"]) != text(h["protocol"]) || !yes(hc["projectBoundCreateStatus"]) || text(hc["schemaSha256"]) == text(h["schemaSha256"]) {
		return nil
	}
	var follow *Followup
	if text(followup["status"]) == "supported" {
		fc := obj(followup["contract"])
		if text(fc["baseSchemaSha256"]) != text(hc["schemaSha256"]) || text(fc["schemaSha256"]) == text(hc["schemaSha256"]) || text(fc["schemaSha256"]) == text(h["schemaSha256"]) {
			return nil
		}
		follow = &Followup{Kind: text(fc["kind"]), Protocol: text(fc["protocol"]), BaseSchemaSHA256: text(fc["baseSchemaSha256"]), SchemaSHA256: text(fc["schemaSha256"])}
	} else if text(followup["code"]) == "CODEX_HOST_TASK_SOURCE_CHANGED" {
		return nil
	}
	paths := []string{text(h["executablePath"]), text(r["socketPath"]), text(r["expectedCodexHome"]), text(r["projectRoot"]), text(r["gitCommonDirectory"]), w.Root, text(git["commonDirectory"]), text(git["gitDirectory"])}
	for i, p := range paths {
		if !path(p) {
			return nil
		}
		if i < 7 && len(p) > 4096 {
			return nil
		}
	}
	granted, grOK := timestamp(text(r["approvedAt"]))
	expires, exOK := positive(r["expiresAt"])
	if !grOK || !exOK || expires > maxDate || expires <= granted || expires-granted > 43200000 || now < granted || now >= expires {
		return nil
	}
	// The old producer finally validates TaskCodexSource. Its wire UTC format
	// admits only years 1..9999, although saved evidence admits all JS ISO years.
	grantedISO, expiryISO := text(r["approvedAt"]), iso(expires)
	if len(grantedISO) != 24 || grantedISO[:4] == "0000" || len(expiryISO) != 24 || expiryISO[:4] == "0000" {
		return nil
	}
	if !wireIDPattern.MatchString(model.ModelAlias) || !wireIDPattern.MatchString(model.Model) {
		return nil
	}
	projectIdentity, writerIdentity := obj(r["projectIdentity"]), obj(w.RootIdentity)
	out := &CodexSource{
		ProjectID:                  text(r["projectId"]),
		WorkspaceID:                text(r["workspaceId"]),
		Project:                    Root{Path: text(r["projectRoot"]), Device: text(projectIdentity["device"]), Inode: text(projectIdentity["inode"]), GitCommonDirectory: text(r["gitCommonDirectory"])},
		Writer:                     Root{Path: w.Root, Device: text(writerIdentity["device"]), Inode: text(writerIdentity["inode"]), GitCommonDirectory: text(git["commonDirectory"])},
		ModelAlias:                 model.ModelAlias,
		Model:                      model.Model,
		ConfigDigest:               model.ConfigSHA256,
		ExecutablePath:             text(h["executablePath"]),
		ExecutableSHA256:           text(h["executableSha256"]),
		Protocol:                   text(hc["protocol"]),
		BaseSchemaSHA256:           text(h["schemaSha256"]),
		HandoffSchemaSHA256:        text(hc["schemaSha256"]),
		Followup:                   follow,
		SocketPath:                 text(r["socketPath"]),
		ExpectedCodexHome:          text(r["expectedCodexHome"]),
		Sandbox:                    sandbox,
		ApprovalPolicy:             approval,
		GrantedAt:                  grantedISO,
		ExpiresAt:                  expiryISO,
		HostGeneration:             strconv.FormatInt(hostGeneration, 10),
		ComputerGeneration:         strconv.FormatInt(computerGeneration, 10),
		GrantHostGeneration:        strconv.FormatInt(routeHost, 10),
		GrantComputerGeneration:    strconv.FormatInt(routeComputer, 10),
		VerifiedWorkspaceID:        text(v["workspaceId"]),
		VerifiedComputerGeneration: strconv.FormatInt(verifiedComputer, 10),
		Access:                     w.Access,
		ProjectBoundCreateStatus:   true,
	}
	if model.Effort != nil {
		effort := *model.Effort
		out.Effort = &effort
	}
	return out
}
func witness(w, h map[string]any, followup bool) bool {
	if !closed(w, "executablePath executableSha256 baseSchemaSha256 status", "code contract") || text(w["executablePath"]) != text(h["executablePath"]) || text(w["executableSha256"]) != text(h["executableSha256"]) || text(w["baseSchemaSha256"]) != text(h["schemaSha256"]) {
		return false
	}
	if text(w["status"]) == "unavailable" {
		if _, exists := w["contract"]; exists {
			return false
		}
		switch text(w["code"]) {
		case "CODEX_HOST_SCHEMA_UNSAFE", "CODEX_HOST_SCHEMA_INVALID", "CODEX_HOST_HANDOFF_UNAVAILABLE", "CODEX_HOST_FOLLOWUP_UNAVAILABLE", "CODEX_HOST_TASK_SOURCE_CHANGED", "CODEX_HOST_TASK_SOURCE_UNCONFIRMED":
			return true
		}
		return false
	}
	if text(w["status"]) != "supported" {
		return false
	}
	if _, exists := w["code"]; exists {
		return false
	}
	c := obj(w["contract"])
	if followup {
		return closed(c, "kind protocol baseSchemaSha256 schemaSha256", "") && text(c["kind"]) == "codex-followup-schema/v1" && text(c["protocol"]) == protocol && digestPattern.MatchString(text(c["baseSchemaSha256"])) && digestPattern.MatchString(text(c["schemaSha256"]))
	}
	return closed(c, "version protocol schemaSha256 projectBoundCreateStatus", "") && versionPattern.MatchString(text(c["version"])) && text(c["protocol"]) == protocol && digestPattern.MatchString(text(c["schemaSha256"])) && yes(c["projectBoundCreateStatus"])
}
