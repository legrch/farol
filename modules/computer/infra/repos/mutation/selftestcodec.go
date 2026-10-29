package mutation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"unicode/utf8"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const selfTestVersion = 10
const selfTestKind = "workspace_owner_selftest_run"

type selfTestStepRecord struct {
	Name              string `json:"name"`
	Status            string `json:"status"`
	Code              string `json:"code"`
	Operation         string `json:"operation"`
	Handle            string `json:"handle"`
	CancelOperation   string `json:"cancelOperation"`
	DescendantCleanup string `json:"descendantCleanup"`
}
type selfTestResultRecord struct {
	Status string               `json:"status"`
	Steps  []selfTestStepRecord `json:"steps"`
}
type selfTestRecord struct {
	Identity           ownerIdentity         `json:"identity"`
	WorkspaceID        string                `json:"workspaceId"`
	ComputerGeneration uint64                `json:"computerGeneration"`
	PlanVersion        uint8                 `json:"planVersion"`
	Phase              domain.Phase          `json:"phase"`
	Result             *selfTestResultRecord `json:"result"`
}
type selfTestEnvelope struct {
	Version uint8          `json:"schemaVersion"`
	Kind    string         `json:"kind"`
	Record  selfTestRecord `json:"record"`
}

func selfTestKey(id domain.Identity) (string, error) {
	if !domain.ValidIdentity(id) || id.Scope != domain.ScopeOwnerSettings || !domain.ScratchLeaf(domain.ScratchPath(id.OperationID)) {
		return "", failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	raw := `["owner-selftest-run-v1",` + quoteJS(id.OperationID) + "," + quoteJS(id.OwnerID) + "," + quoteJS(id.ProfileID) + "," + quoteJS(id.ComputerID) + "]"
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:]) + ".json", nil
}

func encodeSelfTest(s *domain.SelfTestState) ([]byte, error) {
	if s == nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	b, result := s.Binding(), s.Result()
	if _, err := domain.RestoreSelfTest(b, s.Phase(), result); err != nil {
		return nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	i := b.Identity
	r := selfTestRecord{Identity: ownerIdentity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, WorkspaceID: b.WorkspaceID, ComputerGeneration: b.ComputerGeneration, PlanVersion: b.Version, Phase: s.Phase()}
	if result != nil {
		r.Result = &selfTestResultRecord{Status: result.Status, Steps: make([]selfTestStepRecord, 0, len(result.Steps))}
		for _, step := range result.Steps {
			r.Result.Steps = append(r.Result.Steps, selfTestStepRecord{Name: step.Name, Status: step.Status, Code: step.Code, Operation: step.Operation, Handle: step.Handle, CancelOperation: step.CancelOperation, DescendantCleanup: step.DescendantCleanup})
		}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(selfTestEnvelope{Version: selfTestVersion, Kind: selfTestKind, Record: r}) != nil {
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

func decodeSelfTest(raw []byte) (*domain.SelfTestState, error) {
	corrupt := func() (*domain.SelfTestState, error) { return nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT") }
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) {
		return corrupt()
	}
	var e selfTestEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != selfTestVersion || e.Kind != selfTestKind {
		return corrupt()
	}
	r, i := e.Record, e.Record.Identity
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: i.Scope, OperationID: i.OperationID, OwnerID: i.OwnerID, ProfileID: i.ProfileID, ComputerID: i.ComputerID}, WorkspaceID: r.WorkspaceID, ComputerGeneration: r.ComputerGeneration, Version: r.PlanVersion}
	var result *domain.SelfTestResult
	if r.Result != nil {
		if r.Result.Steps == nil {
			return corrupt()
		}
		result = &domain.SelfTestResult{Status: r.Result.Status, Steps: make([]domain.SelfTestStep, 0, len(r.Result.Steps))}
		for _, step := range r.Result.Steps {
			result.Steps = append(result.Steps, domain.SelfTestStep{Name: step.Name, Status: step.Status, Code: step.Code, Operation: step.Operation, Handle: step.Handle, CancelOperation: step.CancelOperation, DescendantCleanup: step.DescendantCleanup})
		}
	}
	s, err := domain.RestoreSelfTest(b, r.Phase, result)
	if err != nil {
		return corrupt()
	}
	canonical, err := encodeSelfTest(s)
	if err != nil || !bytes.Equal(canonical, raw) {
		return corrupt()
	}
	return s, nil
}
