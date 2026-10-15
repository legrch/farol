package helperprotocol

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"

	"github.com/legrch/farol/modules/release/app/port"
)

var _ port.HelperSlotBindingCodec = JSONCodec{}

// SlotBinding encodes the existing Python sort_keys/compact/ASCII record. Key
// order is explicit, including both nested builds. It performs no filesystem IO.
func (JSONCodec) SlotBinding(value port.HelperSlotBinding) ([]byte, error) {
	for _, text := range []string{value.OperationID, value.InstallLocation, value.Source.Digest, value.Source.Version, value.Source.BuildID, value.Target.Digest, value.Target.Version, value.Target.BuildID} {
		if !utf8.ValidString(text) {
			return nil, errEncoding
		}
		if len(text) > 8192 {
			return nil, errSize
		}
	}
	type orderedBuild struct {
		BuildID string `json:"buildId"`
		Digest  string `json:"digest"`
		Version string `json:"version"`
	}
	wire := struct {
		InstallLocation string       `json:"installLocation"`
		OperationID     string       `json:"operationId"`
		Schema          string       `json:"schema"`
		Source          orderedBuild `json:"source"`
		Target          orderedBuild `json:"target"`
	}{value.InstallLocation, value.OperationID, "farol.installed-operation-slot/1",
		orderedBuild{value.Source.BuildID, value.Source.Digest, value.Source.Version},
		orderedBuild{value.Target.BuildID, value.Target.Digest, value.Target.Version}}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(wire) != nil {
		return nil, errEncoding
	}
	return pythonASCII(buffer.String(), 8192)
}
