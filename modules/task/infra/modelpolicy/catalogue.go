package modelpolicy

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"unicode/utf8"

	"github.com/legrch/farol/modules/task/app/port"
)

// DecodeCatalogue accepts the runtime schema with an additional one-MiB raw
// wire limit (including whitespace). Object width, depth and array width are
// bounded before allocating DTOs. Text lengths use JavaScript UTF-16 units.
func (JSONDecoder) DecodeCatalogue(raw []byte) (port.TaskRuntimeCatalogue, error) {
	invalid := port.TaskRuntimeCatalogue{}
	if len(raw) > 1<<20 || !utf8.Valid(raw) || !json.Valid(raw) || !pairedUnicode(raw) {
		return invalid, errInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	value, err := readCatalogueValue(d, 0)
	if err != nil {
		return invalid, err
	}
	o, ok := value.(map[string]any)
	if !ok {
		return invalid, errInvalid
	}
	switch o["status"] {
	case "unavailable":
		o, ok = object(o, "status", "code")
		code, codeOK := catalogueString(o, "code", 1, 120)
		if !ok || !codeOK {
			return invalid, errInvalid
		}
		return port.TaskRuntimeCatalogue{Status: "unavailable", Code: code}, nil
	case "ready":
		o, ok = object(o, "status", "source", "scope", "observedAt", "models")
		if !ok || o["source"] != "model/list" {
			return invalid, errInvalid
		}
		scope, ok := catalogueString(o, "scope", 1, 240)
		if !ok {
			return invalid, errInvalid
		}
		number, ok := o["observedAt"].(json.Number)
		if !ok {
			return invalid, errInvalid
		}
		observed, err := strconv.ParseFloat(string(number), 64)
		if err != nil || math.IsInf(observed, 0) || observed < 0 || observed > 9007199254740991 || math.Trunc(observed) != observed {
			return invalid, errInvalid
		}
		models, ok := o["models"].([]any)
		if !ok || len(models) > 2000 {
			return invalid, errInvalid
		}
		out := port.TaskRuntimeCatalogue{Status: "ready", Source: "model/list", Scope: scope, ObservedAt: int64(observed), Models: make([]port.TaskRuntimeModel, 0, len(models))}
		for _, value := range models {
			m, ok := object(value, "id", "model", "displayName", "hidden", "supportedEfforts", "defaultEffort")
			if !ok {
				return invalid, errInvalid
			}
			id, idOK := catalogueString(m, "id", 1, 160)
			model, modelOK := m["model"].(string)
			display, displayOK := catalogueString(m, "displayName", 0, 240)
			hidden, hiddenOK := m["hidden"].(bool)
			efforts, effortsOK := m["supportedEfforts"].([]any)
			def, defOK := optionalString(m, "defaultEffort")
			if !idOK || !modelOK || !catalogueASCII(model, 120, true) || !displayOK || !hiddenOK || !effortsOK || len(efforts) > 32 || !defOK || def != nil && !catalogueASCII(*def, 40, false) {
				return invalid, errInvalid
			}
			runtime := port.TaskRuntimeModel{ID: id, Model: model, DisplayName: display, Hidden: hidden, DefaultEffort: def, SupportedEfforts: make([]string, 0, len(efforts))}
			for _, value := range efforts {
				effort, ok := value.(string)
				if !ok || !catalogueASCII(effort, 40, false) {
					return invalid, errInvalid
				}
				runtime.SupportedEfforts = append(runtime.SupportedEfforts, effort)
			}
			out.Models = append(out.Models, runtime)
		}
		return out, nil
	default:
		return invalid, errInvalid
	}
}

// ModelOrder reads the source object after DecodePolicy has checked all shapes,
// duplicate keys and Unicode. The application owns full semantic validation.
func (decoder JSONDecoder) ModelOrder(raw []byte, harness string) ([]string, error) {
	policy, err := decoder.DecodePolicy(raw)
	if err != nil || policy == nil {
		return nil, errInvalid
	}
	if _, ok := policy.Harnesses[harness]; !ok {
		return nil, errInvalid
	}
	var wire struct {
		Harnesses map[string]struct{ Models json.RawMessage }
	}
	if json.Unmarshal(raw, &wire) != nil {
		return nil, errInvalid
	}
	d := json.NewDecoder(bytes.NewReader(wire.Harnesses[harness].Models))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, errInvalid
	}
	order := make([]string, 0, len(policy.Harnesses[harness].Models))
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return nil, errInvalid
		}
		key, ok := token.(string)
		if !ok {
			return nil, errInvalid
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, errInvalid
		}
		order = append(order, key)
	}
	if token, err := d.Token(); err != nil || token != json.Delim('}') {
		return nil, errInvalid
	}
	return order, nil
}

func catalogueString(o map[string]any, key string, min, max int) (string, bool) {
	value, ok := o[key].(string)
	if !ok {
		return "", false
	}
	units := 0
	for _, r := range value {
		units++
		if r > 0xffff {
			units++
		}
	}
	return value, units >= min && units <= max
}
func catalogueASCII(value string, max int, model bool) bool {
	if len(value) < 1 || len(value) > max {
		return false
	}
	for i := range len(value) {
		c := value[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-' || model && (c == '.' || c == '/') {
			continue
		}
		return false
	}
	return true
}

func readCatalogueValue(d *json.Decoder, depth int) (any, error) {
	if depth > 4 {
		return nil, errInvalid
	}
	token, err := d.Token()
	if err != nil {
		return nil, errInvalid
	}
	switch value := token.(type) {
	case string, bool, json.Number, nil:
		return value, nil
	case json.Delim:
		switch value {
		case '{':
			object := make(map[string]any)
			for d.More() {
				token, err := d.Token()
				if err != nil {
					return nil, errInvalid
				}
				key, ok := token.(string)
				if !ok {
					return nil, errInvalid
				}
				if _, duplicate := object[key]; duplicate || len(object) >= 6 {
					return nil, errInvalid
				}
				value, err := readCatalogueValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				object[key] = value
			}
			if end, err := d.Token(); err != nil || end != json.Delim('}') {
				return nil, errInvalid
			}
			return object, nil
		case '[':
			array := make([]any, 0)
			for d.More() {
				if len(array) >= 2000 {
					return nil, errInvalid
				}
				value, err := readCatalogueValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				array = append(array, value)
			}
			if end, err := d.Token(); err != nil || end != json.Delim(']') {
				return nil, errInvalid
			}
			return array, nil
		}
	}
	return nil, errInvalid
}

var _ port.TaskModelCatalogueDecoder = JSONDecoder{}
