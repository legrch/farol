package port

// TaskRuntimeCatalogue is an observation, never policy or execution authority.
// Status is ready or unavailable; only fields belonging to that state are set.
type TaskRuntimeCatalogue struct {
	Status     string
	Source     string
	Scope      string
	ObservedAt int64
	Models     []TaskRuntimeModel
	Code       string
}

type TaskRuntimeModel struct {
	ID               string
	Model            string
	DisplayName      string
	Hidden           bool
	SupportedEfforts []string
	DefaultEffort    *string
}

// TaskModelCatalogueDecoder rejects unknown/duplicate keys, malformed Unicode,
// null/missing required fields and trailing values. Catalogue input is limited
// to one MiB including whitespace, narrower than an already parsed JS value.
// ModelOrder returns actual models-object keys in source order, after the
// caller validates the complete policy. Implementations perform no IO, are
// concurrency safe, retain no input, and return caller-owned values. Trusted
// composition supplies non-panicking adapters, never typed nils.
type TaskModelCatalogueDecoder interface {
	DecodeCatalogue([]byte) (TaskRuntimeCatalogue, error)
	ModelOrder(configJSON []byte, harness string) ([]string, error)
}
