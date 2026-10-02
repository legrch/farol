import { z } from "zod";

export const ChatGptUpdateIdleSchema = z.strictObject({
  state: z.enum(["idle", "running", "draft", "unknown"]),
});

// Public DOM only. Return a classification, never composer or conversation text.
// Missing controls are uncertainty; absence of a Stop button alone is not idle.
export const chatGptUpdateIdleProbe = `(() => {
  const visible = (e) => {
    if (!(e instanceof HTMLElement)) return false;
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse" ||
        !(Number(s.opacity) > 0) || typeof e.checkVisibility !== "function" ||
        e.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) !== true)
      return false;
    const width = globalThis.innerWidth, height = globalThis.innerHeight;
    return [r.width, r.height, r.left, r.top, r.right, r.bottom, width, height].every(Number.isFinite) &&
      r.width > 0 && r.height > 0 && width > 0 && height > 0 &&
      r.right > 0 && r.bottom > 0 && r.left < width && r.top < height;
  };
  const any = (s) => [...document.querySelectorAll(s)].some(visible);
  if (any('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"],button[aria-label="Stop recording"],button[aria-label="Stop dictation"],button[aria-label="End voice chat"],button[aria-label="End conversation"],[aria-busy="true"],[data-is-streaming="true"]'))
    return { state: "running" };
  const composers = [...new Set([
    ...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-virtualkeyboard="true"]')
  ])].filter(visible);
  if (composers.length !== 1) return { state: "unknown" };
  const c = composers[0], form = c.closest('form');
  if (!form || c.getAttribute('aria-disabled') === 'true' || c.disabled === true || c.matches(':disabled') ||
      (!(c instanceof HTMLTextAreaElement) && c.getAttribute('contenteditable') !== 'true'))
    return { state: "unknown" };
  // Native form ownership can associate controls outside the form subtree.
  // Keep descendant controls conservative and include each external owner once.
  const controls = (selector) => [...new Set([
    ...form.querySelectorAll(selector),
    ...[...document.querySelectorAll(selector)].filter(e => e.form === form)
  ])];
  const text = c instanceof HTMLTextAreaElement ? c.value : c.textContent || '';
  if (text.length > 0 || controls('input[type="file"]').some(e => e.files && e.files.length) ||
      [...form.querySelectorAll('[data-testid="attachment-preview"],[data-testid="composer-attachment"],[data-testid*="file-chip"],[data-testid*="attachment-chip"]')].some(visible))
    return { state: "draft" };
  // Custom button handlers can submit the form without native submit semantics.
  // ARIA disabledness or an own disabled property cannot disable such handlers.
  if ([...form.querySelectorAll('[role~="button"]')].filter(visible)
      .some(e => !(e instanceof HTMLButtonElement)))
    return { state: "unknown" };
  const sends = controls('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"]').filter(visible);
  const voice = [...form.querySelectorAll('button[aria-label="Start Voice"],button[aria-label="Start voice mode"],button[aria-label="Start Voice Mode"]')].filter(visible);
  // Any unknown enabled button can submit through an application handler,
  // including type=button/reset and controls associated outside the form.
  // Only the known non-submit voice entry is excluded from that uncertainty.
  const actions = controls('button,input[type="submit"],input[type="image"]').filter(visible);
  if (actions.some(e => !sends.includes(e) && e.disabled !== true &&
      !(voice.includes(e) && e instanceof HTMLButtonElement && e.type === "button")))
    return { state: "unknown" };
  // Disabled Send alone does not prove that a voice session has ended. Require
  // a positive entry control; a generic voice toggle may also exist while active.
  // Native disabledness also includes a disabled ancestor fieldset, except
  // controls in its first legend. The control's own property misses that state.
  const voiceReady = voice.length === 1 && voice[0] instanceof HTMLButtonElement &&
    !voice[0].disabled && !voice[0].matches(':disabled') && voice[0].getAttribute('aria-disabled') !== 'true';
  const sendInactive = sends.length === 0 ||
    (sends.length === 1 && sends[0] instanceof HTMLButtonElement && sends[0].disabled);
  if (!voiceReady || !sendInactive || typeof document.elementFromPoint !== "function")
    return { state: "unknown" };
  // Native CSS visibility does not establish clipping or occlusion. The positive
  // entry control must own a hit within its current viewport intersection.
  const box = voice[0].getBoundingClientRect();
  const x = (Math.max(0, box.left) + Math.min(globalThis.innerWidth, box.right)) / 2;
  const y = (Math.max(0, box.top) + Math.min(globalThis.innerHeight, box.bottom)) / 2;
  return { state: voice[0].contains(document.elementFromPoint(x, y)) ? "idle" : "unknown" };
})()`;

export type BrowserUpdateCheck =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>;

export type BrowserUpdateAdmission =
  | Readonly<{ ok: false; code: string }>
  | Readonly<{
      ok: true;
      recheck(): Promise<BrowserUpdateCheck>;
      release(): void;
    }>;
