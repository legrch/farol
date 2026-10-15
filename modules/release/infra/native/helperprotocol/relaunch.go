package helperprotocol

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

var _ port.HelperRelaunchCodec = JSONCodec{}

// Relaunch preserves the Python hint's compact ASCII JSON, field order and
// 2048-byte bound. It is a value encoder, not a process or startup admission.
func (JSONCodec) Relaunch(h port.HelperRelaunchHint) ([]byte, error) {
	for _, text := range []string{h.OperationID, h.Action, h.Phase, h.BuildID, h.Helper.ProcessStart} {
		if !utf8.ValidString(text) {
			return nil, errEncoding
		}
		if len(text) > 2048 {
			return nil, errSize
		}
	}
	wire := struct {
		OperationID string `json:"operationId"`
		Action      string `json:"action"`
		Phase       string `json:"phase"`
		Helper      struct {
			PID          int64  `json:"pid"`
			ProcessStart string `json:"processStart"`
		} `json:"helper"`
		BuildID string `json:"buildId"`
	}{OperationID: h.OperationID, Action: h.Action, Phase: h.Phase, BuildID: h.BuildID}
	wire.Helper.PID, wire.Helper.ProcessStart = h.Helper.PID, h.Helper.ProcessStart
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(wire) != nil {
		return nil, errEncoding
	}
	data := buffer.String()
	return pythonASCII(data[:len(data)-1], 2048)
}
