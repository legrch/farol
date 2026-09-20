// S35-TA-9: who is allowed to speak on a privileged IPC channel.
//
// Every handler in `installIpc` compared `event.sender` with
// `window?.webContents` itself, six times, and then refused in four
// different shapes. Each copy was correct. The risk was never one of the
// six being wrong — it was the seventh handler, added later, whose author
// does not notice that the comparison is part of registering a channel at
// all. A named predicate makes the check something a reader can look for,
// and lets a test enumerate the registrations and refuse one that omits it.
//
// The predicate is deliberately small and total: it answers only "is this
// event from the one window this process owns", and it answers false for
// every state where it cannot be sure — no window yet, a window already
// destroyed, a sender from anywhere else. There is no third answer, because
// a handler that cannot tell must refuse.

/** The minimum of Electron's event this check needs. */
export type IpcSenderEvent = Readonly<{ sender: unknown }>;

/** The minimum of Electron's window this check needs. */
export type IpcTrustedWindow = Readonly<{ webContents: unknown }> | null;

/**
 * True only when the event came from the `webContents` of the window this
 * process owns right now.
 *
 * The cases that matter are the ones where there is nothing to compare
 * against. Before the window is created, and after it is gone, `window` is
 * null, so `window?.webContents` is `undefined`; this checks the window
 * first and refuses, rather than relying on the sender always being a real
 * object. Electron does always supply one, so that ordering fixes no live
 * hole — it forecloses a shape the types allow, in the one place a later
 * handler will copy from. During a
 * reopen there is briefly a NEW window, and an event still in flight from
 * the old one is not from the window this process owns now — so it is
 * refused, which is the safe direction for a channel that can change
 * settings or start a task.
 */
export function isTrustedIpcSender(
  event: IpcSenderEvent | null | undefined,
  window: IpcTrustedWindow | undefined,
): boolean {
  if (!window) return false;
  const trusted = window.webContents;
  if (trusted === null || trusted === undefined) return false;
  if (!event) return false;
  return event.sender === trusted;
}
