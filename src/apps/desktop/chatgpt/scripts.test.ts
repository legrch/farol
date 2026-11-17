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
    "469d68ebb42d45916ec3130fde45ce92f510d91a7447f08a7f3390888de18809",
  selectTemporaryPersonalizationScript:
    "f55e8364781ff44ae5c9d0de341bbc89bfab313104b1a8f53c5421598771084f",
  temporaryInstantProfileProbe:
    "9bf8f38b17543aa6635b8ea09df7f7335379513bca9baa93ee1d1f187bbb9a08",
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
  bind1: "1c138fb6865e1d6a84469f3a78e30b9cf8a7df3b6b9de6ff4a693b199f6a5907",
  bind2: "fa3c3ae2a6ca7480cbf57a34e2d0ffcd130f32c33fe7618bbdbccbbeb75c9b2e",
  verify: "c0e37668f1d3974f3f82ae07f19c2843bff9e2b1da6e2cdf0f0bcbeb65460750",
  gate: "127945a82ee99a6c2f12a6a87734d544a367c10e0a32b75f89308f12e643fbd8",
  cdp: "784f7d96676e57ebd587ecf263f93e0c337dac767a0fe4b3da75371edba0e801",
  prep1: "667cd2f20d37c865de54a73c907cbb651ccd0eb5a91abf55733152e89b247dc1",
  prep2: "5971358efba5ae1d476b4c1cc6b017770f53923c2ff6adf5aa2f5f784335bbda",
  act1: "ab292fe777377bc25c8eb9f949d6280651b2fda2c3b021678fb69645ec3e7e51",
  act2: "82b50b35208460b51e7b074c58e404b815055fa2b7fa28e4a1309684dba13e9e",
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
