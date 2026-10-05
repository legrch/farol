package port

// ModelPolicy is a consumer-owned value mapping of existing settings.tasks.
// Composition parses the strict configuration boundary before mapping it here;
// Resolve also validates all names, bounds and default memberships. No defaults,
// runtime catalogue, grants or mutable configuration owner are introduced.
type ModelPolicy struct {
	DefaultHarness string
	Harnesses      map[string]ModelHarnessPolicy
}

type ModelHarnessPolicy struct {
	DefaultModel string
	Models       map[string]ConfiguredModel
}

type ConfiguredModel struct {
	Model         string
	DefaultEffort *string
}

// Nil preserves omission; a pointer to an empty string is an invalid request.
type ModelRequest struct {
	Harness, Model, Effort *string
	RequestedMode          *string
}

// BrowserModelProfile is trusted compiled capability metadata, never DOM text,
// observation, availability or admission proof. RuntimeModel names the existing
// configured ID; ModelID is the independently mapped canonical browser ID.
// DefaultEffort, when nonempty, is a resolved route value explicitly supported
// by at least one pair. Requests/configured defaults match only Requested.
type BrowserModelProfile struct {
	ID, Executor, RuntimeModel, ModelID string
	DefaultEffort, Mode                 string
	Efforts                             []BrowserModelEffort
	Required                            RequiredControls
}

type BrowserModelEffort struct {
	Requested, Resolved string
}

// ModelSelectionCapture contains only detached scalar values. Later settings or
// profile edits cannot change it. The owner pins its own value copy on the
// original read intent; this capture supplies no execution or admission grant.
type ModelSelectionCapture struct {
	Selection  Selection
	Resolution ModelResolution
	Required   RequiredControls
}
