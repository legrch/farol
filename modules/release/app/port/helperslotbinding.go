package port

// HelperSlotBinding is the already validated request's immutable operation-slot
// value. Encoding it observes no directory and grants no publication authority.
type HelperSlotBinding struct {
	OperationID, InstallLocation string
	Source, Target               HelperBuild
}

// HelperSlotBindingCodec preserves the existing sorted compact ASCII JSON and
// trailing newline, bounded to 8192 bytes. Composition supplies a trusted,
// non-panicking, non-typed-nil codec; returned bytes are independently captured.
type HelperSlotBindingCodec interface {
	SlotBinding(HelperSlotBinding) ([]byte, error)
}
