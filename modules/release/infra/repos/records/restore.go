package records

type Helper struct {
	PID          int64
	ProcessStart *string // nil retains the legacy null/unavailable value
}

func helper(v any, nullableStart bool) (*Helper, bool) {
	m, ok := object(v, []string{"pid", "processStart"}, nil)
	if !ok {
		return nil, false
	}
	id, ok := pid(m["pid"])
	if !ok {
		return nil, false
	}
	if m["processStart"] == nil && nullableStart {
		return &Helper{PID: id}, true
	}
	start, ok := text(m["processStart"], 1, 128)
	if !ok {
		return nil, false
	}
	return &Helper{PID: id, ProcessStart: &start}, true
}

type Restore struct {
	Action          string
	Operation       Operation
	PriorPhase      string
	NotStartedAt    *Build
	InstalledBefore *Build
	Helper          *Helper
	HelperPresent   bool
}

func DecodeRestore(data []byte, expected Operation) (*Restore, error) {
	m, err := decode(data)
	if err != nil {
		return nil, err
	}
	m, ok := object(m, []string{"schema", "action", "operation", "priorPhase"}, []string{"notStartedAt", "installedBefore", "helper"})
	if !ok || m["schema"] != "farol.update-restore-intent/1" {
		return nil, Invalid
	}
	op, a := nestedOperation(m["operation"])
	p, b := phase(m["priorPhase"])
	action, c := m["action"].(string)
	if !a || !b || !c || (action != "recover" && action != "rollback") {
		return nil, Invalid
	}
	if op != expected {
		return nil, BindingMismatch
	}
	notStarted, a := optionalBuild(m, "notStartedAt")
	before, b := optionalBuild(m, "installedBefore")
	if !a || !b {
		return nil, Invalid
	}
	r := &Restore{Action: action, Operation: op, PriorPhase: p, NotStartedAt: notStarted, InstalledBefore: before}
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

type RejectedTarget struct {
	Operation Operation
	Device    string
	Inode     string
}

func DecodeRejectedTarget(data []byte, expected Operation) (*RejectedTarget, error) {
	m, err := decode(data)
	if err != nil {
		return nil, err
	}
	m, ok := object(m, []string{"schema", "operationId", "source", "target", "directoryIdentity"}, nil)
	if !ok || m["schema"] != "farol.rejected-update-target/1" {
		return nil, Invalid
	}
	op, a := operation(m)
	identity, b := object(m["directoryIdentity"], []string{"device", "inode"}, nil)
	if !a || !b {
		return nil, Invalid
	}
	device, a := decimal(identity["device"])
	inode, b := decimal(identity["inode"])
	if !a || !b {
		return nil, Invalid
	}
	if op != expected {
		return nil, BindingMismatch
	}
	return &RejectedTarget{op, device, inode}, nil
}
