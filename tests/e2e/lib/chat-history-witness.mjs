import assert from "node:assert/strict";
import {
  conversationId,
  conversationOutput,
  conversationJournalWitness,
  waitConversationRead,
} from "./read-conversation-witness.mjs";

export const historyLimits = Object.freeze([
  "Controlled synthetic two-turn Chat then one clean same-build Dev restart only; no live provider, installation, cross-build migration or restored Send authority",
  "Actual React saved-answer reads use the current Go owner; original handles cannot be continued from history",
  "Private disposable roots and hidden windows do not prove containment of every native/OS network path",
]);

export function historyOriginals(report) {
  assert.equal(report.journeyPassed, true, "HISTORY_ORIGINAL_JOURNEY_MISSING");
  return [1, 2].map((i) => {
    const matches = report.observations.filter(
      (o) => o.label === `turn-${i}-explicit-ack-go-settled-released`,
    );
    assert.equal(matches.length, 1, "HISTORY_ORIGINAL_AMBIGUOUS");
    assert.equal(matches[0].go.acknowledged, true);
    assert.equal(matches[0].ui.answer, conversationOutput[i - 1].join("\n\n"));
    return matches[0];
  });
}

// This is an independent observation, never a capability for production boot.
export function historyRetirementWitness(journal, initial, originals) {
  assert.equal(originals.length, 2);
  const retirement = journal.retirement;
  assert.deepEqual(retirement?.Scope, initial.scope);
  assert.deepEqual(retirement.Root, initial.root);
  assert.equal(retirement.PreviousRevision, journal.writes.length);
  assert.equal(retirement.Revision, journal.writes.length + 1);
  assert.equal(retirement.Turns.length, 2);
  assert.notEqual(originals[0].go.resultId, originals[1].go.resultId);
  for (const original of originals) {
    const current = conversationJournalWitness(
      { ...journal, retirement: null },
      initial,
      original.ui,
      true,
    );
    assert.deepEqual(current, original.go, "HISTORY_ORIGINAL_JOURNAL_CHANGED");
    const turns = retirement.Turns.filter(
      (t) => t.Binding.OperationID === current.binding.OperationID,
    );
    assert.equal(turns.length, 1, "HISTORY_RETIRED_TURN_AMBIGUOUS");
    const turn = turns[0];
    assert.deepEqual(turn.Binding, current.binding);
    assert.deepEqual(turn.ResultPublication, current.publication);
    const last = journal.writes
      .filter(
        (w) => w.Entry.Binding.OperationID === current.binding.OperationID,
      )
      .at(-1);
    assert.deepEqual(turn.Snapshot, last.Entry.After);
    for (const [field, kind] of [
      ["AcknowledgedRevision", "acknowledge"],
      ["SettledRevision", "settle"],
      ["ReleasedRevision", "release"],
    ]) {
      const revisions = current.revisions.filter((r) => r.kind === kind);
      assert.equal(revisions.length, 1);
      assert.equal(turn[field], revisions[0].revision);
    }
    assert.equal(turn.Quiescence.Confirmed, true);
    assert.equal(turn.Quiescence.ResultID, current.resultId);
    assert.deepEqual(turn.Quiescence.Binding, turn.Snapshot.Binding);
  }
}

export function historyUiWitness(ui, originals, index = null) {
  assert.equal(ui.present, true, "HISTORY_UI_MISSING");
  assert.equal(ui.liveTurn, false, "HISTORY_RESTORED_LIVE_TURN");
  assert.equal(ui.textarea, false, "HISTORY_RESTORED_COMPOSER");
  assert.equal(
    ui.buttons.some((b) => /^(Send|Follow|Acknowledge)/u.test(b.name)),
    false,
    "HISTORY_EFFECT_CONTROL",
  );
  assert.deepEqual(ui.alerts, []);
  assert.doesNotMatch(ui.text, /unavailable|unknown|refused/iu);
  assert.ok(
    ui.text.includes("1–2 of 2 saved answers"),
    "HISTORY_COUNT_CHANGED",
  );
  const reads = ui.buttons.filter((b) => b.name.startsWith("Read turn "));
  assert.deepEqual(
    reads.map((b) => b.name).sort(),
    originals.map((o) => `Read turn ${o.go.binding.TurnGeneration}`).sort(),
  );
  assert.ok(reads.every((b) => !b.disabled));
  for (const name of ["Previous answers", "Next answers"])
    assert.deepEqual(
      ui.buttons.filter((b) => b.name === name),
      [{ name, disabled: true }],
    );
  if (index === null) assert.equal(ui.answer, null, "HISTORY_IMPLICIT_READ");
  else {
    assert.equal(
      ui.resultId,
      originals[index].go.resultId,
      "HISTORY_RESULT_ID_CROSSED",
    );
    assert.equal(
      ui.answer,
      conversationOutput[index].join("\n\n"),
      "HISTORY_RESULT_BYTES_CHANGED",
    );
    assert.equal(
      ui.heading,
      `Turn ${originals[index].go.binding.TurnGeneration}`,
    );
    assert.ok(ui.text.includes(`Conversation: ${conversationId}`));
  }
}

export async function readHistoryUi(window) {
  return window.evaluate(() => {
    const history = document.querySelector('[aria-label="Saved Chat answers"]');
    const answer = history?.querySelector('[aria-label="Saved answer"]');
    return {
      present: Boolean(history),
      liveTurn: Boolean(
        document.querySelector('[aria-label="Current Chat turn"]'),
      ),
      textarea: Boolean(history?.querySelector("textarea")),
      text: history?.textContent ?? "",
      buttons: [...(history?.querySelectorAll("button") ?? [])].map((b) => ({
        name: b.textContent.trim(),
        disabled: b.disabled,
      })),
      alerts: [...document.querySelectorAll('[role="alert"]')].map(
        (n) => n.textContent,
      ),
      answer: answer?.querySelector("p.notice")?.textContent ?? null,
      resultId: answer?.getAttribute("data-result-id") ?? null,
      heading: answer?.querySelector("h3")?.textContent ?? null,
    };
  });
}

export async function runHistoryReadJourney({
  window,
  originals,
  hidden,
  active,
  unchanged,
  report,
  save,
}) {
  report.observations = [];
  await window
    .getByRole("button", { name: "Home", exact: true })
    .click({ timeout: 5000 });
  const initial = await readHistoryUi(window);
  assert.equal(initial.answer, null);
  assert.equal(initial.liveTurn, false);
  assert.equal(
    initial.buttons.filter((b) => b.name.startsWith("Read turn ")).length,
    0,
  );
  const record = async (label, ui) => {
    active();
    await hidden();
    await unchanged();
    report.observations.push({ label, ui });
    await save();
  };
  const click = async (name) => {
    active();
    await hidden();
    await window
      .locator('[aria-label="Saved Chat answers"]')
      .getByRole("button", { name, exact: true })
      .click({ timeout: 5000 });
  };
  const wait = (predicate) =>
    waitConversationRead(() => readHistoryUi(window), predicate, active, {
      onFailure: async (failure) => {
        report.observationFailure = failure;
        await save();
      },
    });
  await record("reopened-no-automatic-read-or-live-handle", initial);
  await click("Load saved answers");
  let ui = await wait(
    (ui) =>
      ui.buttons.filter((b) => b.name.startsWith("Read turn ") && !b.disabled)
        .length === 2,
  );
  historyUiWitness(ui, originals);
  await record("explicit-catalogue", ui);
  for (let index = 0; index < originals.length; index++) {
    await click(`Read turn ${originals[index].go.binding.TurnGeneration}`);
    ui = await wait(
      (ui) =>
        ui.resultId === originals[index].go.resultId &&
        ui.buttons.every(
          (b) => !b.name.startsWith("Read turn ") || !b.disabled,
        ),
    );
    historyUiWitness(ui, originals, index);
    await record(`original-answer-${index + 1}`, ui);
  }
  await window
    .getByRole("button", { name: "Settings", exact: true })
    .click({ timeout: 5000 });
  await hidden();
  await window
    .getByRole("button", { name: "Home", exact: true })
    .click({ timeout: 5000 });
  ui = await readHistoryUi(window);
  assert.equal(ui.answer, null, "HISTORY_REMOUNT_REPLAYED_READ");
  assert.equal(ui.liveTurn, false);
  await record("home-remount-without-send-or-ack", ui);
  report.passed = true;
  await save();
}

export function historyWitnessSelfTest(pass, reject) {
  const originals = [1, 2].map((i) => ({
    go: { binding: { TurnGeneration: i }, resultId: `result-${i}` },
  }));
  const base = {
    present: true,
    liveTurn: false,
    textarea: false,
    text: `1–2 of 2 saved answers Conversation: ${conversationId}`,
    alerts: [],
    buttons: [
      { name: "Read turn 1", disabled: false },
      { name: "Read turn 2", disabled: false },
      { name: "Previous answers", disabled: true },
      { name: "Next answers", disabled: true },
    ],
    answer: null,
  };
  pass(() => historyUiWitness(base, originals));
  const answer = {
    ...base,
    answer: conversationOutput[0].join("\n\n"),
    resultId: "result-1",
    heading: "Turn 1",
  };
  pass(() => historyUiWitness(answer, originals, 0));
  for (const changed of [
    { present: false },
    { liveTurn: true },
    { textarea: true },
    { text: "1–3 of 3 saved answers" },
    { text: base.text + " unavailable" },
    { answer: "wrong" },
    { resultId: "result-2" },
    { heading: "Turn 2" },
    { buttons: [...base.buttons, { name: "Send follow-up", disabled: false }] },
    { buttons: base.buttons.slice(1) },
  ])
    reject(() => historyUiWitness({ ...answer, ...changed }, originals, 0));
  reject(() => historyUiWitness(answer, originals));
  // Pure synthetic journal fixtures; no host receipt or provider authority.
  const initial = {
    version: 3,
    scope: { ProfileID: "profile", BackendGeneration: "original" },
    root: { Device: 1, Inode: 2, OwnerUID: 501 },
    incarnations: ["original"],
    retirement: null,
    writes: [],
  };
  const journal = structuredClone(initial),
    prior = [],
    turns = [];
  for (let i = 1; i <= 2; i++) {
    const binding = {
      ...initial.scope,
      OwnerID: "owner",
      SessionID: "session",
      TaskID: "task",
      TurnID: `turn-${i}`,
      OperationID: `operation-${i}`,
      TurnGeneration: i,
    };
    const snapshot = {
      Identity: { ...binding, Generation: i },
      Phase: "delivered",
      Binding: { Document: { ConversationID: conversationId } },
      SendIntent: true,
      Accepted: true,
      HasResult: true,
      Result: {
        ID: `result-${i}`,
        Outcome: "completed",
        Code: "PROVIDER_COMPLETED",
      },
      DeliveryAcknowledged: true,
      LifecycleSettled: true,
    };
    const publication = {
      Version: 1,
      Root: initial.root,
      StorageRoot: { ...initial.root, Inode: 3 },
      Digest: Array(32).fill(i),
      EncodedBytes: 2048,
    };
    const quiescence = {
      Confirmed: true,
      ResultID: snapshot.Result.ID,
      Binding: snapshot.Binding,
    };
    const revisions = [];
    for (const kind of ["finish", "acknowledge", "settle", "release"]) {
      const revision = journal.writes.length + 1;
      journal.writes.push({
        Scope: initial.scope,
        PreviousRevision: revision - 1,
        Revision: revision,
        Entry: {
          Binding: binding,
          Kind: kind,
          After: snapshot,
          Quiescence: quiescence,
          ...(kind === "finish" ? { ResultPublication: publication } : {}),
        },
      });
      revisions.push({ revision, kind });
    }
    prior.push({
      label: `turn-${i}-explicit-ack-go-settled-released`,
      ui: {
        taskId: "task",
        turnId: binding.TurnID,
        answer: conversationOutput[i - 1].join("\n\n"),
      },
      go: {
        binding,
        resultId: snapshot.Result.ID,
        publication,
        acknowledged: true,
        revisions,
      },
    });
    turns.push({
      Binding: binding,
      Snapshot: snapshot,
      ResultPublication: publication,
      Quiescence: quiescence,
      AcknowledgedRevision: revisions[1].revision,
      SettledRevision: revisions[2].revision,
      ReleasedRevision: revisions[3].revision,
    });
  }
  journal.retirement = {
    Scope: initial.scope,
    Root: initial.root,
    PreviousRevision: 8,
    Revision: 9,
    Turns: turns,
  };
  pass(() => historyRetirementWitness(journal, initial, prior));
  pass(() =>
    assert.deepEqual(
      historyOriginals({ journeyPassed: true, observations: prior }),
      prior,
    ),
  );
  reject(() => historyOriginals({ journeyPassed: false, observations: prior }));
  reject(() =>
    historyOriginals({
      journeyPassed: true,
      observations: [...prior, prior[0]],
    }),
  );
  for (const change of [
    (j) => {
      j.retirement = null;
    },
    (j) => {
      j.retirement.Scope.BackendGeneration = "crossed";
    },
    (j) => {
      j.retirement.Root.Inode = 99;
    },
    (j) => {
      j.retirement.PreviousRevision++;
    },
    (j) => {
      j.retirement.Turns.pop();
    },
    (j) => {
      j.retirement.Turns[0].Binding.OperationID = "crossed";
    },
    (j) => {
      j.retirement.Turns[0].AcknowledgedRevision = 0;
    },
    (j) => {
      j.retirement.Turns[0].ReleasedRevision = 0;
    },
    (j) => {
      j.retirement.Turns[0].ResultPublication.Digest[0]++;
    },
    (j) => {
      j.retirement.Turns[0].Quiescence.Confirmed = false;
    },
    (j) => {
      j.writes.pop();
    },
  ])
    reject(() => {
      const changed = JSON.parse(JSON.stringify(journal));
      change(changed);
      historyRetirementWitness(changed, initial, prior);
    });
}
