import { describe, expect, it } from "vitest";

import type { QuitStage } from "../../../src/apps/desktop/quit-drain";
import {
  initialQuitProgress,
  presentQuitProgress,
  reduceQuitProgress,
} from "./progress";

const run = (stages: QuitStage[]) =>
  stages.reduce(reduceQuitProgress, initialQuitProgress);

describe("Quit progress shows only what the drain reports", () => {
  it("groups still-running owners in plain words", () => {
    const state = run([
      { stage: "drain-entered" },
      { stage: "collect-end", closers: 3 },
      { stage: "closer-begin", closer: 0, name: "connector" },
      { stage: "closer-begin", closer: 1, name: "host-check" },
      { stage: "closer-begin", closer: 2, name: "host-check" },
      {
        stage: "closer-end",
        closer: 1,
        name: "host-check",
        result: "confirmed",
      },
    ]);
    const view = presentQuitProgress(state, 41.2);
    expect(view.lines).toEqual([
      "ChatGPT connection is stopping",
      "Connection check is stopping",
    ]);
    expect(view.footer).toContain("within 42 s");
  });

  it("names an owner that failed to confirm and the preparation phase", () => {
    expect(
      presentQuitProgress(run([{ stage: "preparation-begin" }]), 50).lines,
    ).toEqual(["Preparing the update"]);
    const failed = run([
      { stage: "closer-begin", closer: 0, name: "go-core" },
      { stage: "closer-end", closer: 0, name: "go-core", result: "failed" },
    ]);
    expect(presentQuitProgress(failed, 3).lines).toEqual([
      "Farol core did not confirm it stopped",
    ]);
  });

  it("maps unknown names to local helpers and never claims a reason", () => {
    const state = run([
      { stage: "closer-begin", closer: 0, name: "local-runtime-3" },
    ]);
    expect(presentQuitProgress(state, 10).lines).toEqual([
      "Local helper is stopping",
    ]);
  });
});
