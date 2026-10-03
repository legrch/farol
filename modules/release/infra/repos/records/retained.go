package records

import "encoding/json"

type Retained struct {
	Handle          string
	Manifest        json.RawMessage // opaque until accepted manifest/package verification
	Operation       *Operation
	DownloadID      string
	Preparation     *Operation
	ArchiveReleased *bool
	Helper          *Helper
	HelperPresent   bool
}

type Receipt struct {
	Retained
	ObservedAt     string
	Phase          string
	RunningBuildID string
}

func retained(m map[string]any, raw []byte, receipt bool) (*Retained, error) {
	required := []string{"schema", "handle", "manifest", "operation"}
	optional := []string{"downloadId", "preparation", "archiveReleased", "helper"}
	if receipt {
		required = append(required, "observedAt", "phase", "runningBuildId")
	}
	m, ok := object(m, required, optional)
	if !ok || m["schema"] != "farol.ready-update/1" {
		return nil, Invalid
	}
	handle, ok := text(m["handle"], 0, 4096)
	if !ok {
		return nil, Invalid
	}
	fields := map[string]json.RawMessage{}
	if json.Unmarshal(raw, &fields) != nil {
		return nil, Invalid
	}
	r := &Retained{Handle: handle, Manifest: append(json.RawMessage(nil), fields["manifest"]...)}
	if m["operation"] != nil {
		op, ok := nestedOperation(m["operation"])
		if !ok {
			return nil, Invalid
		}
		r.Operation = &op
	}
	if value, present := m["downloadId"]; present {
		r.DownloadID, ok = hex(value, 32)
		if !ok {
			return nil, Invalid
		}
	}
	if value, present := m["preparation"]; present {
		op, ok := nestedOperation(value)
		if !ok {
			return nil, Invalid
		}
		r.Preparation = &op
	}
	if value, present := m["archiveReleased"]; present {
		b, ok := value.(bool)
		if !ok {
			return nil, Invalid
		}
		r.ArchiveReleased = &b
	}
	if value, present := m["helper"]; present {
		r.HelperPresent = true
		if value != nil {
			r.Helper, ok = helper(value, true)
			if !ok {
				return nil, Invalid
			}
		}
	}
	return r, nil
}

func DecodeRetained(data []byte) (*Retained, error) {
	m, err := decode(data)
	if err != nil {
		return nil, err
	}
	return retained(m, data, false)
}

func DecodeReceipt(data []byte) (*Receipt, error) {
	m, err := decode(data)
	if err != nil {
		return nil, err
	}
	r, err := retained(m, data, true)
	if err != nil {
		return nil, err
	}
	at, a := text(m["observedAt"], 0, 64)
	p, b := phase(m["phase"])
	id, c := hex(m["runningBuildId"], 64)
	if !a || !b || !c {
		return nil, Invalid
	}
	return &Receipt{Retained: *r, ObservedAt: at, Phase: p, RunningBuildID: id}, nil
}
