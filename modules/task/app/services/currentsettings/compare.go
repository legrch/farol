// Package currentsettings compares saved Task facts without granting authority.
package currentsettings

import (
	"bytes"
	"context"
	"encoding/json"
	"sort"

	"github.com/legrch/farol/modules/task/app/port"
)

const MaxSnapshotBytes = 1 << 20
const Invalid = "TASK_CURRENT_SETTINGS_INVALID"
const Unavailable = "TASK_CURRENT_SETTINGS_UNAVAILABLE"

type Failure struct{ Code string }

func (f *Failure) Error() string { return f.Code }

type Service struct {
	decoder port.TaskCurrentSettingsDecoder
	policy  port.TaskSettingsPolicyIdentityResolver
}

func New(decoder port.TaskCurrentSettingsDecoder, policy port.TaskSettingsPolicyIdentityResolver) *Service {
	return &Service{decoder: decoder, policy: policy}
}

// Compare retains no mutable input or result. Callers must not mutate bytes
// during the call. Errors never carry a comparison result or saved contents.
func (s *Service) Compare(ctx context.Context, before, candidate []byte) (bool, error) {
	if s == nil || s.decoder == nil || s.policy == nil || ctx == nil || ctx.Err() != nil {
		return false, &Failure{Code: Unavailable}
	}
	if len(before) > MaxSnapshotBytes || len(candidate) > MaxSnapshotBytes {
		return false, &Failure{Code: Invalid}
	}
	a, err := s.decoder.Decode(append([]byte(nil), before...))
	if ctx.Err() != nil {
		return false, &Failure{Code: Unavailable}
	}
	if err != nil {
		return false, &Failure{Code: Invalid}
	}
	b, err := s.decoder.Decode(append([]byte(nil), candidate...))
	if ctx.Err() != nil {
		return false, &Failure{Code: Unavailable}
	}
	if err != nil {
		return false, &Failure{Code: Invalid}
	}
	left, err := s.project(a)
	if ctx.Err() != nil {
		return false, &Failure{Code: Unavailable}
	}
	if err != nil {
		return false, err
	}
	right, err := s.project(b)
	if ctx.Err() != nil {
		return false, &Failure{Code: Unavailable}
	}
	if err != nil {
		return false, err
	}
	leftJSON, err := json.Marshal(left)
	if err != nil {
		return false, &Failure{Code: Invalid}
	}
	rightJSON, err := json.Marshal(right)
	if err != nil {
		return false, &Failure{Code: Invalid}
	}
	changed := !bytes.Equal(leftJSON, rightJSON)
	if ctx.Err() != nil {
		return false, &Failure{Code: Unavailable}
	}
	return changed, nil
}

type projection struct {
	Status                         string
	Policy                         port.TaskSettingsPolicyIdentity
	NativeHosts                    port.TaskCurrentNativeHosts
	ComputerID, ComputerGeneration string
	SelectedWorkspaceID            *string
	Unique                         bool
	Workspaces                     []port.TaskCurrentWorkspace
	Setup                          port.TaskCurrentSetup
}

func (s *Service) project(f port.TaskCurrentSettingsFacts) (projection, error) {
	if f.Status == "settings-invalid" {
		return projection{Status: f.Status}, nil
	}
	if f.Status != "parsed" {
		return projection{}, &Failure{Code: Invalid}
	}
	identity, err := s.policy.IdentifyTaskPolicy(append([]byte(nil), f.Tasks...))
	if err != nil {
		return projection{}, &Failure{Code: Unavailable}
	}
	switch identity.Kind {
	case port.TaskSettingsPolicyValid:
		if !validDigest(identity.SHA256) {
			return projection{}, &Failure{Code: Unavailable}
		}
	case port.TaskSettingsPolicyMissing, port.TaskSettingsPolicyInvalid:
		if identity.SHA256 != "" {
			return projection{}, &Failure{Code: Unavailable}
		}
	default:
		return projection{}, &Failure{Code: Unavailable}
	}
	out := projection{Status: f.Status, Policy: identity, ComputerID: f.Computer.ComputerID,
		ComputerGeneration: f.Computer.Generation, Setup: f.Setup,
		NativeHosts: port.TaskCurrentNativeHosts{Generation: f.NativeHosts.Generation, Route: f.NativeHosts.Route},
		Workspaces:  []port.TaskCurrentWorkspace{}}
	if f.NativeHosts.Host != nil {
		h := f.NativeHosts.Host
		out.NativeHosts.Host = map[string]any{"executablePath": h["executablePath"],
			"executableSha256": h["executableSha256"], "version": h["version"], "protocol": h["protocol"],
			"baseSchemaSha256": h["schemaSha256"], "localVerification": h["localVerification"], "taskSource": h["taskSource"]}
	}
	if f.NativeHosts.Route != nil {
		id, ok := f.NativeHosts.Route["workspaceId"].(string)
		if !ok {
			return projection{}, &Failure{Code: Invalid}
		}
		out.SelectedWorkspaceID = &id
		for _, workspace := range f.Computer.Workspaces {
			if workspace.WorkspaceID != id {
				continue
			}
			workspace.ExcludedPaths = append([]string{}, workspace.ExcludedPaths...)
			sort.Strings(workspace.ExcludedPaths)
			out.Workspaces = append(out.Workspaces, workspace)
		}
	}
	out.Unique = len(out.Workspaces) == 1
	// All workspace values have bounded, JSON-compatible types. Sorting encoded
	// values gives a deterministic multiset order while retaining duplicate facts.
	type ordered struct {
		value port.TaskCurrentWorkspace
		key   string
	}
	items := make([]ordered, len(out.Workspaces))
	for i, w := range out.Workspaces {
		key, err := json.Marshal(w)
		if err != nil {
			return projection{}, &Failure{Code: Invalid}
		}
		items[i] = ordered{w, string(key)}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].key < items[j].key })
	for i := range items {
		out.Workspaces[i] = items[i].value
	}
	return out, nil
}

func validDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'f') && !(c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
