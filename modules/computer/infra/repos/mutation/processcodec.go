package mutation

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// v4 is a reservation only. It adds no terminal result or persisted liveness.
// Field order and exact re-encoding are part of this content-free format.
type processHost struct {
	ProfileID           string `json:"profileId"`
	BackendGeneration   string `json:"backendGeneration"`
	BuildID             string `json:"buildId"`
	RuntimeID           string `json:"runtimeId"`
	LaunchDigest        string `json:"launchDigest"`
	ConnectorGeneration string `json:"connectorGeneration"`
}
type processScope struct {
	Host               processHost `json:"host"`
	OwnerID            string      `json:"ownerId"`
	ComputerID         string      `json:"computerId"`
	CallID             string      `json:"callId"`
	ComputerGeneration string      `json:"computerGeneration"`
	Generation         string      `json:"generation"`
}
type processBinding struct {
	OwnerID       string `json:"ownerId"`
	SessionID     string `json:"sessionId"`
	TaskID        string `json:"taskId"`
	TaskEpoch     string `json:"taskEpoch"`
	ParticipantID string `json:"participantId"`
	TurnID        string `json:"turnId"`
}
type processSeal struct {
	Digest      string `json:"digest"`
	WorkspaceID string `json:"workspaceId"`
	Root        string `json:"root"`
	Cwd         string `json:"cwd"`
	Device      string `json:"device"`
	Inode       string `json:"inode"`
	Write       bool   `json:"write"`
}
type processIntent struct {
	OperationID string         `json:"operationId"`
	Binding     processBinding `json:"binding"`
	Seal        processSeal    `json:"seal"`
	Deadline    string         `json:"deadlineUnixNano"`
}
type processRecord struct {
	Scope  processScope  `json:"scope"`
	Intent processIntent `json:"intent"`
	Phase  string        `json:"phase"`
}
type processEnvelope struct {
	Version uint8         `json:"schemaVersion"`
	Kind    string        `json:"kind"`
	Record  processRecord `json:"record"`
}

func processIdentifier(v string, max int) bool {
	if len(v) < 1 || len(v) > max {
		return false
	}
	for _, c := range v {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._:-", c)) {
			return false
		}
	}
	return true
}
func validProcessScope(s processsvc.ConnectorReservationScope) bool {
	h := s.Host
	return processIdentifier(s.OwnerID, 160) && processIdentifier(s.ComputerID, 160) && processIdentifier(s.CallID, 120) &&
		processIdentifier(h.ProfileID, 160) && processIdentifier(h.BackendGeneration, 120) && processIdentifier(h.BuildID, 120) &&
		processIdentifier(h.RuntimeID, 120) && domain.SHA256(h.LaunchDigest) && h.ConnectorGeneration > 0
}
func processPath(v string) bool {
	if len(v) > 4096 || !authority.CanonicalPath(v) || v == "/" || strings.Contains(v, "\\") {
		return false
	}
	parts := strings.Split(v[1:], "/")
	if len(parts) > 256 {
		return false
	}
	for _, part := range parts {
		if len(part) > 255 {
			return false
		}
		for _, c := range part {
			if c < 32 || c == 127 {
				return false
			}
		}
	}
	return true
}
func processCounter(v string) bool {
	n, err := strconv.ParseUint(v, 10, 64)
	return err == nil && strconv.FormatUint(n, 10) == v
}
func validProcessIntent(s processsvc.ConnectorReservationScope, i processsvc.Intent) bool {
	b, seal := i.Binding, i.Seal
	n := i.Deadline.UnixNano()
	return validProcessScope(s) && processIdentifier(i.OperationID, 160) && b.OwnerID == s.OwnerID &&
		processIdentifier(b.OwnerID, 160) && processIdentifier(b.SessionID, 120) && processIdentifier(b.TaskID, 120) &&
		processIdentifier(b.ParticipantID, 120) && processIdentifier(b.TurnID, 120) &&
		domain.SHA256(seal.Digest) && processIdentifier(seal.WorkspaceID, 120) &&
		processPath(seal.Root) && processPath(seal.Cwd) && authority.Within(seal.Root, seal.Cwd) &&
		processCounter(seal.RootIdentity.Device) && processCounter(seal.RootIdentity.Inode) &&
		n > 0 && time.Unix(0, n).Equal(i.Deadline)
}

func encodeProcess(s processsvc.ConnectorReservationScope, i processsvc.Intent) ([]byte, error) {
	if !validProcessIntent(s, i) {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	h, b, seal := s.Host, i.Binding, i.Seal
	e := processEnvelope{Version: 4, Kind: "workspace_connector_process", Record: processRecord{
		Scope: processScope{Host: processHost{h.ProfileID, h.BackendGeneration, h.BuildID, h.RuntimeID, h.LaunchDigest, strconv.FormatUint(h.ConnectorGeneration, 10)},
			OwnerID: s.OwnerID, ComputerID: s.ComputerID, CallID: s.CallID, ComputerGeneration: strconv.FormatUint(s.ComputerGeneration, 10), Generation: strconv.FormatUint(s.Generation, 10)},
		Intent: processIntent{OperationID: i.OperationID, Binding: processBinding{b.OwnerID, b.SessionID, b.TaskID, strconv.FormatUint(b.TaskEpoch, 10), b.ParticipantID, b.TurnID},
			Seal: processSeal{seal.Digest, seal.WorkspaceID, seal.Root, seal.Cwd, seal.RootIdentity.Device, seal.RootIdentity.Inode, seal.Write}, Deadline: strconv.FormatInt(i.Deadline.UnixNano(), 10)},
		Phase: "reserved",
	}}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(e) != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	raw, err := jsSeparators(buf.Bytes())
	if err != nil {
		return nil, err
	}
	if len(raw) > maxRecordBytes {
		return nil, failure("WORKSPACE_MUTATION_STATE_OVERSIZED")
	}
	return raw, nil
}

func decodeProcess(raw []byte) (processsvc.ConnectorReservationScope, processsvc.Intent, error) {
	corrupt := func() (processsvc.ConnectorReservationScope, processsvc.Intent, error) {
		return processsvc.ConnectorReservationScope{}, processsvc.Intent{}, failure("WORKSPACE_MUTATION_STATE_CORRUPT")
	}
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) {
		return corrupt()
	}
	var e processEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != 4 || e.Kind != "workspace_connector_process" || e.Record.Phase != "reserved" {
		return corrupt()
	}
	s, i := e.Record.Scope, e.Record.Intent
	generation, err := strconv.ParseUint(s.Host.ConnectorGeneration, 10, 64)
	if err != nil {
		return corrupt()
	}
	computerGeneration, err := strconv.ParseUint(s.ComputerGeneration, 10, 64)
	if err != nil {
		return corrupt()
	}
	operationGeneration, err := strconv.ParseUint(s.Generation, 10, 64)
	if err != nil {
		return corrupt()
	}
	taskEpoch, err := strconv.ParseUint(i.Binding.TaskEpoch, 10, 64)
	if err != nil {
		return corrupt()
	}
	nanos, err := strconv.ParseInt(i.Deadline, 10, 64)
	if err != nil || nanos <= 0 {
		return corrupt()
	}
	scope := processsvc.ConnectorReservationScope{Host: port.ConnectorHost{
		ProfileID: s.Host.ProfileID, BackendGeneration: s.Host.BackendGeneration, BuildID: s.Host.BuildID, RuntimeID: s.Host.RuntimeID,
		LaunchDigest: s.Host.LaunchDigest, ConnectorGeneration: generation},
		OwnerID: s.OwnerID, ComputerID: s.ComputerID, CallID: s.CallID, ComputerGeneration: computerGeneration, Generation: operationGeneration}
	intent := processsvc.Intent{OperationID: i.OperationID,
		Binding: port.TaskBinding{Identity: authority.Identity{OwnerID: i.Binding.OwnerID, SessionID: i.Binding.SessionID, TaskID: i.Binding.TaskID, TaskEpoch: taskEpoch}, ParticipantID: i.Binding.ParticipantID, TurnID: i.Binding.TurnID},
		Seal: processsvc.Seal{Digest: i.Seal.Digest, WorkspaceID: i.Seal.WorkspaceID, Root: i.Seal.Root, Cwd: i.Seal.Cwd,
			RootIdentity: authority.RootIdentity{Device: i.Seal.Device, Inode: i.Seal.Inode}, Write: i.Seal.Write}, Deadline: time.Unix(0, nanos)}
	canonical, err := encodeProcess(scope, intent)
	if err != nil || !bytes.Equal(raw, canonical) {
		return corrupt()
	}
	return scope, intent, nil
}
