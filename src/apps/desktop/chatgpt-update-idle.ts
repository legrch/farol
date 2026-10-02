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
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const any = (s) => [...document.querySelectorAll(s)].some(visible);
  if (any('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="Stop"],button[aria-label="Stop recording"],button[aria-label="Stop dictation"],button[aria-label="End voice chat"],button[aria-label="End conversation"],[aria-busy="true"],[data-is-streaming="true"]'))
    return { state: "running" };
  const composers = [...new Set([
    ...document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],[contenteditable="true"][data-virtualkeyboard="true"]')
  ])].filter(visible);
  if (composers.length !== 1) return { state: "unknown" };
  const c = composers[0], form = c.closest('form');
  if (!form || c.getAttribute('aria-disabled') === 'true' || c.disabled === true ||
      (!(c instanceof HTMLTextAreaElement) && c.getAttribute('contenteditable') !== 'true'))
    return { state: "unknown" };
  const text = c instanceof HTMLTextAreaElement ? c.value : c.textContent || '';
  if (text.length > 0 || [...form.querySelectorAll('input[type="file"]')].some(e => e.files && e.files.length) ||
      [...form.querySelectorAll('[data-testid="attachment-preview"],[data-testid="composer-attachment"],[data-testid*="file-chip"],[data-testid*="attachment-chip"]')].some(visible))
    return { state: "draft" };
  const sends = [...form.querySelectorAll('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"]')].filter(visible);
  // Disabled Send alone does not prove that a voice session has ended. Require
  // a positive entry control; a generic voice toggle may also exist while active.
  const voice = [...form.querySelectorAll('button[aria-label="Start voice mode"],button[aria-label="Start Voice Mode"]')].filter(visible);
  const voiceReady = voice.length === 1 && voice[0] instanceof HTMLButtonElement &&
    !voice[0].disabled && voice[0].getAttribute('aria-disabled') !== 'true';
  const sendInactive = sends.length === 0 ||
    (sends.length === 1 && sends[0] instanceof HTMLButtonElement && sends[0].disabled);
  if (voiceReady && sendInactive)
    return { state: "idle" };
  return { state: "unknown" };
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
