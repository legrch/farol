package authority

import "time"

func AuthorizeIdentity(p Participant, identity Identity) error {
	if p.Grant.OwnerID != identity.OwnerID {
		return fail("AUTHORITY_OWNER_MISMATCH", TaskGrantSource)
	}
	if p.Grant.SessionID != identity.SessionID || p.Grant.TaskID != identity.TaskID || p.Grant.TaskEpoch != identity.TaskEpoch {
		return fail("AUTHORITY_TASK_MISMATCH", TaskGrantSource)
	}
	return nil
}
func authorizePolicy(policy Policy, action Action, now time.Time, source string) error {
	if now.After(policy.ExpiresAt) {
		return Fail("AUTHORITY_EXPIRED", source)
	}
	op := action.Operation
	if op.Kind == NetworkUse {
		if policy.Network == ApprovedNetwork {
			return nil
		}
		return Fail("AUTHORITY_NETWORK_DENIED", source)
	}
	if !capabilitiesInclude(policy.Capabilities, []Capability{op.Kind}) {
		return Fail("AUTHORITY_CAPABILITY_DENIED", source)
	}
	if (op.Kind == Verify && policy.Commands != VerificationCommands && policy.Commands != WorkspaceCommands) || (op.Kind == Shell && policy.Commands != WorkspaceCommands) {
		return Fail("AUTHORITY_COMMAND_DENIED", source)
	}
	if _, denied := deniedBy(policy.ExcludedPaths, op); denied {
		return Fail("AUTHORITY_PATH_DENIED", source)
	}
	for _, scope := range policy.Workspaces {
		if scope.WorkspaceID == op.WorkspaceID && containsPath(scope, op.Path) && (!(op.Kind == Write || (op.Kind == Shell && op.Write)) || scope.Access == WriteAccess) {
			return nil
		}
	}
	return Fail("AUTHORITY_PATH_DENIED", source)
}
func AuthorizeTask(p Participant, action Action, now time.Time) error {
	if err := AuthorizeIdentity(p, action.Identity); err != nil {
		return err
	}
	op := action.Operation
	if (op.Kind == Write || (op.Kind == Shell && op.Write)) && p.MutationOwnership != TaskOwnership {
		return Fail("AUTHORITY_MUTATION_OWNERSHIP_DENIED", "role")
	}
	if op.Kind != NetworkUse {
		if exclusion, denied := deniedBy(p.Grant.ExcludedPaths, op); denied {
			return Fail("AUTHORITY_PATH_DENIED", DenialSource(exclusion.RestrictionSource))
		}
	}
	err := authorizePolicy(p.Grant.Policy, action, now, "task-grant")
	if failure, ok := err.(*Failure); ok && failure.Code == "AUTHORITY_PATH_DENIED" && op.Kind != NetworkUse {
		if scope, found := FindScope(p.Grant, op.WorkspaceID); found {
			return Fail(failure.Code, DenialSource(scope.RestrictionSource))
		}
	}
	return err
}
func AuthorizeComputer(p Participant, a Approval, action Action, now time.Time) error {
	if err := AuthorizeTask(p, action, now); err != nil {
		return err
	}
	if a.OwnerID != p.Grant.OwnerID {
		return Fail("AUTHORITY_OWNER_MISMATCH", "computer-policy")
	}
	if a.ComputerID != p.Grant.ComputerID || a.Generation != p.Grant.ComputerGeneration {
		return Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
	return authorizePolicy(approvalPolicy(a), action, now, "computer-policy")
}
func AuthorizeNativeHost(p Participant, host NativeHost, action Action, now time.Time) error {
	if err := AuthorizeTask(p, action, now); err != nil {
		return err
	}
	if host.OwnerID != action.OwnerID {
		return Fail("AUTHORITY_OWNER_MISMATCH", "native-host")
	}
	if host.TaskID != action.TaskID || host.TaskEpoch != action.TaskEpoch {
		return Fail("AUTHORITY_TASK_MISMATCH", "native-host")
	}
	return authorizePolicy(host.Policy, action, now, "native-host")
}
