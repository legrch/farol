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
    "fb71e4fd5a9f91023fa61552b447ba46ba62e4eae686d5d03825f5ca8966bc17",
  lowerInstantPowerSliderScript:
    "f9beeeed37222bd172e0357a76db9c365ac983a1381c697c4bdf61851c732cdd",
  openInstantPowerPickerScript:
    "35d478bec310d848eee8d20d0b738deaf1b95a1cde830fdba05ef7e8a8d7932d",
  openTemporaryPersonalizationScript:
    "92ad5a2d24aafa0e1a440640c46fc2977e896334082ce5633b153b66f888de42",
  readinessProbe:
    "82cdd7f15ec2419ac3be52aa5aed83b1283959d5b4283a2d30d29641db9f299d",
  selectTemporaryPersonalizationScript:
    "f55e8364781ff44ae5c9d0de341bbc89bfab313104b1a8f53c5421598771084f",
  temporaryInstantProfileProbe:
    "5bb04585c39a0eb0b14118066372570d3a0acfe14e940edb17ceb797e4a5beee",
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
  prep2: () =>
    scripts.prepareTaskScript("hello", href, "Farol", 1700000000000, true),
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
  bind1: "5930fefdc98bce2d1c7d842331c1857ed41863b70d1daf8517be422ff276b3c8",
  bind2: "b3d199238ed7b13c2afd189608b5b66136e73029e45803029baaa38bcb11bc7a",
  verify: "159e6784dc1da3764f570e2ae4af6190dbbe2753f803bd05acc50461c6aedeb7",
  gate: "5895b4344e7668fdf4169b8e9daeb71f3708c24b18045c6ca75e4de378be2ee6",
  cdp: "83ee9736a998ddbcc620cfc4abfb8547ed6409e2edb3d2040eeb1e87c8fdea29",
  prep1: "667cd2f20d37c865de54a73c907cbb651ccd0eb5a91abf55733152e89b247dc1",
  prep2: "be828f90e5c33ebb6730c839b3b80357a8416909e26dd24e46125513e9855b0a",
  act1: "f8c2ca251e3a8f83f6fd6e08d3879e8c0b61e7afb1d8a43fbe3f93eac20588b5",
  act2: "9fbd680d3e46a027db462515e595c4f5844529429a1c73c6d62e964fcd754ea8",
  probe1: "f27ef5f5333b4e08da7f6a7b2e5c1c92881a219b94dc4f7b2da17cc4f9342b30",
  probe2: "ed170d2560bcd2e1f03cf1fe9542ec894324c10d5dac9152a785a58f1333a5b8",
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
