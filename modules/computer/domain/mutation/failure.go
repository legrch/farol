package mutation

func NativeCode(code string) bool {
	switch code {
	case "WORKSPACE_INVALID_REQUEST", "WORKSPACE_POLICY_TOO_LARGE", "WORKSPACE_MUTATION_CANCELLED", "WORKSPACE_HELPER_UNTRUSTED", "WORKSPACE_INTERPRETER_UNTRUSTED", "WORKSPACE_PATH_REFUSED", "WORKSPACE_ROOT_CHANGED", "WORKSPACE_NOT_FOUND", "WORKSPACE_NOT_A_FILE", "WORKSPACE_FILE_TOO_LARGE", "WORKSPACE_MUTATION_CONFLICT", "WORKSPACE_NOT_TEXT", "WORKSPACE_EDIT_NO_MATCH", "WORKSPACE_EDIT_NOT_UNIQUE", "WORKSPACE_EDIT_OVERLAP", "WORKSPACE_HELPER_FAILED", "WORKSPACE_MUTATION_OUTCOME_UNKNOWN":
		return true
	}
	return false
}
func authorityCode(code string) bool {
	switch code {
	case "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "COMPUTER_PARTICIPANT_NOT_FOUND", "COMPUTER_APPROVAL_NOT_FOUND", "AUTHORITY_OWNER_MISMATCH", "AUTHORITY_TASK_MISMATCH", "AUTHORITY_COMPUTER_MISMATCH", "AUTHORITY_EXPIRED", "AUTHORITY_INFLATION_DENIED", "AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_PATH_DENIED", "AUTHORITY_NETWORK_DENIED", "AUTHORITY_COMMAND_DENIED", "AUTHORITY_MUTATION_OWNERSHIP_DENIED":
		return true
	}
	return false
}
func validFailure(f Failure, unknown bool) bool {
	if unknown {
		return f.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" && (f.Source == "native-workspace" || f.Source == "operation-store")
	}
	if f.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || !NativeCode(f.Code) && !authorityCode(f.Code) {
		return false
	}
	switch f.Source {
	case "native-workspace", "operation-store", "computer-approval", "task-admission", "task-grant", "owner-restriction", "role", "computer-policy", "native-host", "authority-store":
		return true
	}
	return false
}

// NativeFailure preserves the active TS adapter's mutation-specific mapping.
// A lost/malformed receipt, interruption or unclassified failure remains unknown.
func NativeFailure(code string) Failure {
	switch code {
	case "WORKSPACE_RACE_DETECTED":
		code = "WORKSPACE_MUTATION_CONFLICT"
	case "WORKSPACE_REQUEST_CANCELLED":
		code = "WORKSPACE_MUTATION_CANCELLED"
	case "WORKSPACE_HELPER_FAILED":
		code = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
	default:
		if !NativeCode(code) {
			code = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
		}
	}
	return Failure{Code: code, Source: "native-workspace"}
}
