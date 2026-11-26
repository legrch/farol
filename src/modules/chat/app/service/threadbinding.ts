import type { HandoffWorkspace } from "../port/handoff";
import { identifier, object, titleName } from "./handoffvalidation";
import { sandboxType } from "./turnrequest";

type Fields = Record<string, unknown> | null;

/** The provider thread is the journalled thread, in the approved project and root. */
export function threadBound(
  thread: Fields,
  threadId: string,
  projectId: string,
  root: string,
): thread is Record<string, unknown> {
  return (
    thread?.id === threadId &&
    thread?.projectId === projectId &&
    thread?.cwd === root
  );
}

export function threadModelBound(
  thread: Fields,
  model: string | undefined,
): boolean {
  return thread?.model === model;
}

/** A title the provider reports must be absent, null, or a valid thread name. */
export function threadNameInvalid(thread: Record<string, unknown>): boolean {
  return (
    thread.name !== undefined && thread.name !== null && !titleName(thread.name)
  );
}

/** The current name of a bound title thread, or `undefined` when it is unverified. */
export function boundTitleName(
  thread: Fields,
  expected: Readonly<{
    threadId: string;
    projectId: string;
    root: string;
    model: string | undefined;
  }>,
): string | null | undefined {
  if (
    !expected.model ||
    !thread ||
    !threadBound(
      thread,
      expected.threadId,
      expected.projectId,
      expected.root,
    ) ||
    thread.model !== expected.model ||
    threadNameInvalid(thread)
  )
    return undefined;
  return typeof thread.name === "string" ? thread.name : null;
}

/** Observed names are bounded text; anything else leaves the outcome unknown. */
export function observedNameInvalid(name: unknown): boolean {
  return (
    name !== undefined &&
    name !== null &&
    (typeof name !== "string" || name.length > 1_000 || name.includes("\0"))
  );
}

export function observedModel(thread: Record<string, unknown>): string | null {
  return typeof thread.model === "string" && thread.model.length <= 120
    ? thread.model
    : null;
}

/** The thread id a `thread/start` reply proves, or null when any binding differs. */
export function startedThreadId(
  started: Fields,
  expected: Readonly<{
    projectId: string;
    model: string;
    workspace: HandoffWorkspace;
  }>,
): string | null {
  const thread = object(started?.thread);
  if (
    !identifier(thread?.id) ||
    thread?.projectId !== expected.projectId ||
    started?.cwd !== expected.workspace.root ||
    started?.model !== expected.model ||
    started?.approvalPolicy !== expected.workspace.execution.approvalPolicy ||
    object(started?.sandbox)?.type !== sandboxType(expected.workspace.execution)
  )
    return null;
  return thread.id;
}
