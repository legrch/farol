package mutation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"unicode/utf8"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const processOutputChunkBytes = 32 * 1024

// v5 is separate from the unchanged content-free v4 reservation. The original
// scope/intent retain their exact v4 representation, including uint64 strings.
type processTerminalObservation struct {
	Handle             string               `json:"handle"`
	Root               processsvc.RootState `json:"root"`
	Waited             bool                 `json:"waited"`
	ExitCode           *int                 `json:"exitCode"`
	ExitSignal         int                  `json:"exitSignal"`
	GroupCleanup       processsvc.Cleanup   `json:"groupCleanup"`
	DescendantCleanup  processsvc.Cleanup   `json:"descendantCleanup"`
	StdoutOffset       uint64               `json:"stdoutOffset"`
	StderrOffset       uint64               `json:"stderrOffset"`
	StdoutNext         uint64               `json:"stdoutNext"`
	StderrNext         uint64               `json:"stderrNext"`
	StdoutBytes        uint64               `json:"stdoutBytes"`
	StderrBytes        uint64               `json:"stderrBytes"`
	OutputLimitReached bool                 `json:"outputLimitReached"`
	OutputDrained      bool                 `json:"outputDrained"`
	CancelRequested    bool                 `json:"cancelRequested"`
	TimedOut           bool                 `json:"timedOut"`
	AuthorityLost      bool                 `json:"authorityLost"`
}
type processOutputDigest struct {
	Offset uint64 `json:"offset"`
	Bytes  uint32 `json:"bytes"`
	SHA256 string `json:"sha256"`
}
type processTerminalRecord struct {
	Scope       processScope               `json:"scope"`
	Intent      processIntent              `json:"intent"`
	Phase       string                     `json:"phase"`
	Observation processTerminalObservation `json:"observation"`
	Stdout      []processOutputDigest      `json:"stdout"`
	Stderr      []processOutputDigest      `json:"stderr"`
}
type processTerminalEnvelope struct {
	Version uint8                 `json:"schemaVersion"`
	Kind    string                `json:"kind"`
	Record  processTerminalRecord `json:"record"`
}
type processOutputRecord struct {
	Parent string `json:"parent"`
	Stream string `json:"stream"`
	Offset uint64 `json:"offset"`
	SHA256 string `json:"sha256"`
	Data   []byte `json:"data"`
}
type processOutputEnvelope struct {
	Version uint8               `json:"schemaVersion"`
	Kind    string              `json:"kind"`
	Record  processOutputRecord `json:"record"`
}
type processOutputPublication struct {
	key string
	raw []byte
}

func processSHA256(raw []byte) string {
	d := sha256.Sum256(raw)
	return hex.EncodeToString(d[:])
}
func processCanonical(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if enc.Encode(value) != nil {
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

// The explicit namespace prevents output records from sharing per-operation
// identities. Parent, stream, offset and content all participate in the key.
func processOutputKey(parent, stream string, d processOutputDigest) string {
	raw, _ := json.Marshal([]any{"process-output-v5", parent, stream, d.Offset, d.SHA256})
	return processSHA256(raw) + ".json"
}
func validProcessParent(parent string) bool {
	return len(parent) == 69 && parent[64:] == ".json" && domain.SHA256(parent[:64])
}
func terminalMetadata(o processsvc.Observation) processTerminalObservation {
	return processTerminalObservation{o.Handle, o.Root, o.Waited, o.ExitCode, o.ExitSignal, o.GroupCleanup, o.DescendantCleanup,
		o.StdoutOffset, o.StderrOffset, o.StdoutNext, o.StderrNext, o.StdoutBytes, o.StderrBytes,
		o.OutputLimitReached, o.OutputDrained, o.CancelRequested, o.TimedOut, o.AuthorityLost}
}
func (o processTerminalObservation) observation() processsvc.Observation {
	return processsvc.Observation{Handle: o.Handle, Root: o.Root, Waited: o.Waited, ExitCode: o.ExitCode, ExitSignal: o.ExitSignal,
		GroupCleanup: o.GroupCleanup, DescendantCleanup: o.DescendantCleanup,
		StdoutOffset: o.StdoutOffset, StderrOffset: o.StderrOffset, StdoutNext: o.StdoutNext, StderrNext: o.StderrNext,
		StdoutBytes: o.StdoutBytes, StderrBytes: o.StderrBytes, OutputLimitReached: o.OutputLimitReached, OutputDrained: o.OutputDrained,
		CancelRequested: o.CancelRequested, TimedOut: o.TimedOut, AuthorityLost: o.AuthorityLost}
}
func encodeProcessTerminal(v processsvc.TerminalResult) ([]byte, []processOutputPublication, error) {
	if !processsvc.ValidTerminalResult(v) {
		return nil, nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	reserved, err := encodeProcess(v.Scope, v.Intent)
	if err != nil {
		return nil, nil, err
	}
	var original processEnvelope
	if decodeStrict(reserved, &original) != nil {
		return nil, nil, failure("WORKSPACE_MUTATION_STATE_INVALID")
	}
	parent, err := recordKey(processIdentity(v.Scope, v.Intent.OperationID))
	if err != nil {
		return nil, nil, err
	}
	e := processTerminalEnvelope{Version: 5, Kind: "workspace_connector_process_terminal", Record: processTerminalRecord{
		Scope: original.Record.Scope, Intent: original.Record.Intent, Phase: "terminal", Observation: terminalMetadata(v.Observation)}}
	var chunks []processOutputPublication
	for _, stream := range []struct {
		name string
		data []byte
		list *[]processOutputDigest
	}{{"stdout", v.Observation.Stdout, &e.Record.Stdout}, {"stderr", v.Observation.Stderr, &e.Record.Stderr}} {
		*stream.list = make([]processOutputDigest, 0, (len(stream.data)+processOutputChunkBytes-1)/processOutputChunkBytes)
		for offset := 0; offset < len(stream.data); offset += processOutputChunkBytes {
			data := stream.data[offset:min(offset+processOutputChunkBytes, len(stream.data))]
			d := processOutputDigest{uint64(offset), uint32(len(data)), processSHA256(data)}
			raw, err := processCanonical(processOutputEnvelope{5, "workspace_connector_process_output", processOutputRecord{parent, stream.name, d.Offset, d.SHA256, data}})
			if err != nil {
				return nil, nil, err
			}
			*stream.list = append(*stream.list, d)
			chunks = append(chunks, processOutputPublication{processOutputKey(parent, stream.name, d), raw})
		}
	}
	raw, err := processCanonical(e)
	return raw, chunks, err
}
func validProcessDigests(list []processOutputDigest, size uint64) bool {
	if size > processsvc.MaximumOutput || list == nil || len(list) != int((size+processOutputChunkBytes-1)/processOutputChunkBytes) {
		return false
	}
	var next uint64
	for _, d := range list {
		if d.Offset != next || uint64(d.Bytes) != min(uint64(processOutputChunkBytes), size-next) || d.Bytes == 0 || !domain.SHA256(d.SHA256) {
			return false
		}
		next += uint64(d.Bytes)
	}
	return next == size
}

// Decode validates the bounded layout before output allocation and the complete
// value before chunk IO. Canonical comparison refuses missing, extra and duplicate fields.
func decodeProcessTerminal(raw []byte) (*processsvc.TerminalResult, *processTerminalEnvelope, error) {
	corrupt := func() (*processsvc.TerminalResult, *processTerminalEnvelope, error) {
		return nil, nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT")
	}
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) {
		return corrupt()
	}
	var e processTerminalEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != 5 || e.Kind != "workspace_connector_process_terminal" || e.Record.Phase != "terminal" {
		return corrupt()
	}
	original, err := processCanonical(processEnvelope{4, "workspace_connector_process", processRecord{e.Record.Scope, e.Record.Intent, "reserved"}})
	if err != nil {
		return corrupt()
	}
	scope, intent, err := decodeProcess(original)
	if err != nil {
		return corrupt()
	}
	o := e.Record.Observation.observation()
	if o.StdoutBytes > processsvc.MaximumOutput || o.StderrBytes > processsvc.MaximumOutput || o.StdoutBytes+o.StderrBytes > processsvc.MaximumOutput ||
		!validProcessDigests(e.Record.Stdout, o.StdoutBytes) || !validProcessDigests(e.Record.Stderr, o.StderrBytes) {
		return corrupt()
	}
	canonical, err := processCanonical(e)
	if err != nil || !bytes.Equal(raw, canonical) {
		return corrupt()
	}
	o.Stdout, o.Stderr = make([]byte, int(o.StdoutBytes)), make([]byte, int(o.StderrBytes))
	v := &processsvc.TerminalResult{Scope: scope, Intent: intent, Observation: o}
	if !processsvc.ValidTerminalResult(*v) {
		return corrupt()
	}
	return v, &e, nil
}
func decodeProcessOutput(raw []byte, parent, stream string, d processOutputDigest) ([]byte, error) {
	corrupt := func() ([]byte, error) { return nil, failure("WORKSPACE_MUTATION_STATE_CORRUPT") }
	if len(raw) == 0 || len(raw) > maxRecordBytes || !utf8.Valid(raw) || !validProcessParent(parent) ||
		(stream != "stdout" && stream != "stderr") || d.Bytes == 0 || d.Bytes > processOutputChunkBytes || !domain.SHA256(d.SHA256) {
		return corrupt()
	}
	var e processOutputEnvelope
	if decodeStrict(raw, &e) != nil || e.Version != 5 || e.Kind != "workspace_connector_process_output" {
		return corrupt()
	}
	r := e.Record
	if r.Parent != parent || r.Stream != stream || r.Offset != d.Offset || r.SHA256 != d.SHA256 ||
		len(r.Data) != int(d.Bytes) || processSHA256(r.Data) != d.SHA256 {
		return corrupt()
	}
	canonical, err := processCanonical(e)
	if err != nil || !bytes.Equal(raw, canonical) {
		return corrupt()
	}
	return bytes.Clone(r.Data), nil
}
