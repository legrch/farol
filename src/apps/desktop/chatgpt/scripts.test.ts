import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import * as scripts from "./scripts";

// The page scripts are source text injected into the ChatGPT page. These
// digests were taken from the scripts as they were defined inside
// chatgpt-route.ts, so they pin the text byte for byte across the move. A
// deliberate script change updates the digest in the same commit.
const digest = (text: string): string =>
  crypto.createHash("sha256").update(text).digest("hex");

const href = "https://chatgpt.com/c/x";

const exportedText: Readonly<Record<string, string>> = {
  dismissInstantPowerPickerScript:
    "199e5a4418ab6668b653735038470e786b1fd7ce2558f9eb01e0ac51dcea5ddb",
  focusInstantPowerSliderScript:
    "ae8aeccf259a258e89ec817fdf41bda43dd053e68284deab5dd0a036086745ad",
  instantModelLabelPattern:
    "943e8e6f467c1c76e5aa90957ade135275a250036c2382718be51aa4934184ce",
  lowerInstantPowerSliderScript:
    "f9beeeed37222bd172e0357a76db9c365ac983a1381c697c4bdf61851c732cdd",
  openInstantPowerPickerScript:
    "e6d934185bf457a79b1e9e476380682783477d1af228b465746548bcb9012b38",
  openTemporaryPersonalizationScript:
    "92ad5a2d24aafa0e1a440640c46fc2977e896334082ce5633b153b66f888de42",
  readinessProbe:
    "ce41b74cbdbc9440798e321666225180c7b51ff8559ca5df6dbc54ac877c8c44",
  selectTemporaryPersonalizationScript:
    "f55e8364781ff44ae5c9d0de341bbc89bfab313104b1a8f53c5421598771084f",
  temporaryInstantProfileProbe:
    "28e4dd8aa126454c51ad9fb06ba0ce9a26636ed5e6060046f77796f16cfbdd86",
  toggleChatGptSidebarScript:
    "ed50835e8df388cf5cbb28ee5c57937318b7f3223a7c56d23cef0460e52d5be2",
};

const builtText: Readonly<Record<string, () => string>> = {
  collapse: () => scripts.collapseChatGptSidebarScript(),
  bind1: () => scripts.bindChatGptAppScript("Farol", href),
  bind2: () => scripts.bindChatGptAppScript("Farol", href, true),
  verify: () => scripts.verifyChatGptAppScript("Farol", href),
  gate: () => scripts.installManualAppGateScript("Farol"),
  cdp: () => scripts.connectionCheckDocumentProbe("Farol", href),
  prep1: () => scripts.prepareTaskScript("hello `x` ${y}", href),
  prep2: () => scripts.prepareTaskScript("hello", href, "Farol", 5000, true),
  act1: () => scripts.activateTaskScript(href),
  act2: () =>
    scripts.activateTaskScript(href, "Farol", true, true, "deep", true),
  probe1: () => scripts.taskProbeScript("p", ["a", "b"]),
  probe2: () =>
    scripts.taskProbeScript(
      "p",
      ["a"],
      { semantic: true, userId: "u", assistantId: "a" },
      "Farol",
    ),
};

const builtDigests: Readonly<Record<string, string>> = {
  collapse: "1e54a77ba9d64ad187edc5b25b56cf35ef4f016c4b3b8da154b502e42e5aa524",
  bind1: "846bd7520e255fd168a2f38bf8e59ff72f3f09fc37e666c82c38a25540538eb0",
  bind2: "2d5a9a87699536dfb6dc9596f5034b52854be2ac23f583714b075ff0e06362a9",
  verify: "e28440b0df3b14d04f30e4bc3daa79f0abff3b296d8a94eab49760f21d000dfa",
  gate: "8a3a89332fc3f9a43861d3e50bbe5ca3aea090a6aab3208f3b444a14bcc156a9",
  cdp: "1c33e1b3dc787dabd01bdb0efac3233496ea1b17617d17d11dff79404a7907d0",
  prep1: "937957211a45635b7f799b78b17ac3a70f76363998e33384f7161357f38db20a",
  prep2: "86e79c7ed3b419547e30ed164886faffaaf2293952aa9ca0295b057db158d009",
  act1: "ab292fe777377bc25c8eb9f949d6280651b2fda2c3b021678fb69645ec3e7e51",
  act2: "7b9a431a7a9a012269a97ceaa9be42ffeca0bab5cc53badda45d9ac2bc158027",
  probe1: "636d4d065f23242cfecae36c46d19dfc9c76172140be3bfa0d54def7f26dbaff",
  probe2: "fce32d97548d3bdcd8447683eb3083ad79aff73859fe8cd6f9ab89a8ace55eb0",
};

describe("page scripts", () => {
  it.each(Object.keys(exportedText))("keeps the text of %s", (name) => {
    const value = (scripts as unknown as Record<string, unknown>)[name];
    expect(digest(String(value))).toBe(exportedText[name]);
  });

  it.each(Object.keys(builtDigests))("keeps the built text of %s", (name) => {
    expect(digest(builtText[name]?.() ?? "missing")).toBe(builtDigests[name]);
  });
});
