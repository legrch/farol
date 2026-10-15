package port

// TaskModelPolicy is configured data, never proof of an executable harness,
// catalogue availability, entitlement, account access or permission.
type TaskModelPolicy struct {
	DefaultHarness string
	Harnesses      map[string]TaskModelHarness
}

type TaskModelHarness struct {
	DefaultModel string
	Models       map[string]TaskModel
}

type TaskModel struct {
	Model         string
	DefaultEffort *string
}

type TaskModelPolicyRequest struct {
	Harness, Model, Effort *string
}

// TaskModelPolicyDecoder rejects unknown/duplicate keys, malformed Unicode,
// non-object requests and explicit null optional fields. Empty policy bytes or
// JSON null return nil, nil. Implementations are deterministic and concurrency
// safe, perform no IO and retain no input. Returned values belong to the caller.
// Trusted composition supplies valid, non-panicking values, never typed nils.
type TaskModelPolicyDecoder interface {
	DecodePolicy([]byte) (*TaskModelPolicy, error)
	DecodeSelection([]byte) (TaskModelPolicyRequest, error)
}

// TaskModelPolicyDigester returns lowercase SHA-256 for exact canonical bytes.
// Implementations are deterministic and concurrency safe, perform no IO and
// retain no input. The application validates the returned digest shape.
// Trusted composition supplies valid, non-panicking values, never typed nils.
type TaskModelPolicyDigester interface {
	Digest([]byte) (string, error)
}
