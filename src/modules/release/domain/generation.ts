import {
  failure,
  success,
  type Result,
} from "../../../pkg/kernel/domain/result";

export type ReleaseErrorCode =
  | "RELEASE_CLOSED"
  | "RELEASE_DUPLICATE_WORK"
  | "RELEASE_UNKNOWN_WORK"
  | "RELEASE_INVALID_PHASE"
  | "RELEASE_SAME_GENERATION"
  | "RELEASE_DRAIN_REQUIRED";

export type ReleaseState = Readonly<{
  phase: "open" | "draining" | "verifying";
  activeGeneration: string;
  previousGeneration: string | null;
  candidateGeneration: string | null;
  acceptedWork: readonly string[];
  lastOutcome: "none" | "activated" | "rolled_back";
}>;

export function createReleaseState(activeGeneration: string): ReleaseState {
  return {
    phase: "open",
    activeGeneration,
    previousGeneration: null,
    candidateGeneration: null,
    acceptedWork: [],
    lastOutcome: "none",
  };
}

export function admitWork(
  state: ReleaseState,
  workId: string,
): Result<ReleaseState, ReleaseErrorCode> {
  if (state.phase !== "open") return failure("RELEASE_CLOSED");
  if (state.acceptedWork.includes(workId))
    return failure("RELEASE_DUPLICATE_WORK");
  return success({ ...state, acceptedWork: [...state.acceptedWork, workId] });
}

export function releaseWork(
  state: ReleaseState,
  workId: string,
): Result<ReleaseState, ReleaseErrorCode> {
  if (!state.acceptedWork.includes(workId))
    return failure("RELEASE_UNKNOWN_WORK");
  return success({
    ...state,
    acceptedWork: state.acceptedWork.filter(
      (candidate) => candidate !== workId,
    ),
  });
}

export function prepareUpdate(
  state: ReleaseState,
  candidateGeneration: string,
): Result<ReleaseState, ReleaseErrorCode> {
  if (state.phase !== "open") return failure("RELEASE_INVALID_PHASE");
  if (state.activeGeneration === candidateGeneration)
    return failure("RELEASE_SAME_GENERATION");
  return success({ ...state, phase: "draining", candidateGeneration });
}

export function switchGeneration(
  state: ReleaseState,
): Result<ReleaseState, ReleaseErrorCode> {
  if (state.phase !== "draining" || state.candidateGeneration === null) {
    return failure("RELEASE_INVALID_PHASE");
  }
  if (state.acceptedWork.length > 0) return failure("RELEASE_DRAIN_REQUIRED");
  return success({
    ...state,
    phase: "verifying",
    previousGeneration: state.activeGeneration,
    activeGeneration: state.candidateGeneration,
  });
}

export function verifyGeneration(
  state: ReleaseState,
  accepted: boolean,
): Result<ReleaseState, ReleaseErrorCode> {
  if (state.phase !== "verifying" || state.previousGeneration === null) {
    return failure("RELEASE_INVALID_PHASE");
  }
  return success({
    ...state,
    phase: "open",
    activeGeneration: accepted
      ? state.activeGeneration
      : state.previousGeneration,
    previousGeneration: null,
    candidateGeneration: null,
    lastOutcome: accepted ? "activated" : "rolled_back",
  });
}
