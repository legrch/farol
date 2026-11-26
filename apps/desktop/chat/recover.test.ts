import { describe, expect, it, vi } from "vitest";
import {
  recoverChatGptConversation,
  recoverChatGptTaskJournal,
  recoverDeepTests,
} from "./recover";

type Task = { readonly id: string; readonly result?: string | null };

function journalHarness(
  options: Readonly<{
    freshStartup: boolean;
    load?: () => Promise<Task | null>;
    reconcile?: () => Promise<Task | null>;
    create?: () => never;
    record?: (result: string) => Promise<{ ok: boolean }>;
  }>,
) {
  const events: string[] = [];
  const journal = {
    load: vi.fn(async () => {
      events.push("load");
      return options.load ? options.load() : null;
    }),
    reconcileAfterRestart: vi.fn(async () => {
      events.push("reconcile");
      return options.reconcile ? options.reconcile() : null;
    }),
  };
  const ports = {
    freshStartup: options.freshStartup,
    create: options.create ?? (() => journal),
    recordObservation: vi.fn(async (result: string) => {
      events.push(`record:${result}`);
      return options.record ? options.record(result) : { ok: true };
    }),
    setJournal: vi.fn((value: typeof journal | null) => {
      events.push(value === null ? "journal:null" : "journal:set");
    }),
    setRecoverableTask: vi.fn((value: Task | null) => {
      events.push(`task:${value?.id ?? "null"}`);
    }),
    setObservationPersisted: vi.fn((value: boolean) => {
      events.push(`persisted:${value}`);
    }),
  };
  return { events, journal, ports };
}

describe("task journal recovery", () => {
  it("reconciles after a restart and records a retained result", async () => {
    const task = { id: "a", result: "done" };
    const h = journalHarness({
      freshStartup: false,
      reconcile: async () => task,
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual([
      "reconcile",
      "journal:set",
      "task:a",
      "record:done",
      "persisted:true",
    ]);
    expect(h.journal.load).not.toHaveBeenCalled();
    expect(h.ports.setJournal).toHaveBeenCalledWith(h.journal);
  });

  it("keeps the journal and offers no task when nothing was retained", async () => {
    const h = journalHarness({ freshStartup: false });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual(["reconcile", "journal:set", "task:null"]);
    expect(h.ports.recordObservation).not.toHaveBeenCalled();
    expect(h.ports.setObservationPersisted).not.toHaveBeenCalled();
  });

  it("does not record a retained task that has no result", async () => {
    const h = journalHarness({
      freshStartup: false,
      reconcile: async () => ({ id: "b", result: null }),
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual(["reconcile", "journal:set", "task:b"]);
  });

  it("publishes the persisted flag from the recorded outcome", async () => {
    const h = journalHarness({
      freshStartup: false,
      reconcile: async () => ({ id: "c", result: "x" }),
      record: async () => ({ ok: false }),
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events.at(-1)).toBe("persisted:false");
  });

  it("loads without reconciling on a fresh start and drops the writer when history was retained", async () => {
    const h = journalHarness({
      freshStartup: true,
      load: async () => ({ id: "d", result: "x" }),
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual(["load", "journal:null", "task:null"]);
    expect(h.journal.reconcileAfterRestart).not.toHaveBeenCalled();
    expect(h.ports.recordObservation).not.toHaveBeenCalled();
  });

  it("keeps the writer on a fresh start with no retained history", async () => {
    const h = journalHarness({ freshStartup: true });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual(["load", "journal:set", "task:null"]);
  });

  it("publishes the task before the observation is recorded", async () => {
    let seenDuringRecord: string[] = [];
    const h = journalHarness({
      freshStartup: false,
      reconcile: async () => ({ id: "e", result: "x" }),
      record: async () => {
        seenDuringRecord = [...h.events];
        return { ok: true };
      },
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(seenDuringRecord).toEqual([
      "reconcile",
      "journal:set",
      "task:e",
      "record:x",
    ]);
  });

  it("clears all three values when the reconcile fails", async () => {
    const h = journalHarness({
      freshStartup: false,
      reconcile: async () => {
        throw new Error("unreadable");
      },
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual([
      "reconcile",
      "journal:null",
      "task:null",
      "persisted:false",
    ]);
  });

  it("clears all three values when the record fails after publishing", async () => {
    const h = journalHarness({
      freshStartup: false,
      reconcile: async () => ({ id: "f", result: "x" }),
      record: async () => {
        throw new Error("write failed");
      },
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual([
      "reconcile",
      "journal:set",
      "task:f",
      "record:x",
      "journal:null",
      "task:null",
      "persisted:false",
    ]);
  });

  it("clears all three values when the journal cannot be created", async () => {
    const h = journalHarness({
      freshStartup: false,
      create: () => {
        throw new Error("root refused");
      },
    });
    await recoverChatGptTaskJournal(h.ports);
    expect(h.events).toEqual(["journal:null", "task:null", "persisted:false"]);
  });
});

describe("deep test recovery", () => {
  it("answers ready with the recovered attempts", async () => {
    const attempts = [{ id: 1 }];
    await expect(recoverDeepTests(async () => attempts)).resolves.toEqual({
      ready: true,
      tests: attempts,
    });
  });

  it("answers ready with none when nothing is outstanding", async () => {
    await expect(recoverDeepTests(async () => [])).resolves.toEqual({
      ready: true,
      tests: [],
    });
  });

  it("answers not ready, without attempts, when the scan fails", async () => {
    const outcome = await recoverDeepTests(async () => {
      throw new Error("DEEP_TEST_RECOVERY_UNAVAILABLE");
    });
    expect(outcome).toEqual({ ready: false });
    expect("tests" in outcome).toBe(false);
  });
});

type Conversation = {
  readonly state: string;
  readonly conversationUrl: string | null;
};

function conversationHarness(
  load: () => Promise<Conversation | null>,
  canonical: (url: string) => string | null = (url) => url,
  create?: () => never,
) {
  const events: string[] = [];
  const store = {
    load: vi.fn(async () => {
      events.push("load");
      return load();
    }),
  };
  const ports = {
    create: create ?? (() => store),
    canonicalUrl: vi.fn(canonical),
    setStore: vi.fn((value: typeof store | null) => {
      events.push(value === null ? "store:null" : "store:set");
    }),
    setConversation: vi.fn((value: Conversation | null) => {
      events.push(`conversation:${value?.state ?? "null"}`);
    }),
  };
  return { events, store, ports };
}

describe("conversation recovery", () => {
  const retained = {
    state: "retained",
    conversationUrl: "https://chatgpt.test/c/1",
  };

  it("answers the canonical address of a retained conversation", async () => {
    const h = conversationHarness(async () => retained);
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: "https://chatgpt.test/c/1",
    });
    expect(h.events).toEqual(["store:set", "load", "conversation:retained"]);
    expect(h.ports.canonicalUrl).toHaveBeenCalledWith(
      "https://chatgpt.test/c/1",
    );
  });

  it("publishes the store before the load and the conversation after it", async () => {
    let seenDuringLoad: string[] = [];
    const h = conversationHarness(async () => {
      seenDuringLoad = [...h.events];
      return retained;
    });
    await recoverChatGptConversation(h.ports);
    expect(seenDuringLoad).toEqual(["store:set", "load"]);
  });

  it("starts at home with the store kept when nothing is stored", async () => {
    const h = conversationHarness(async () => null);
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events).toEqual(["store:set", "load", "conversation:null"]);
    expect(h.ports.canonicalUrl).not.toHaveBeenCalled();
  });

  it("starts at home with the conversation kept when it is not retained", async () => {
    const h = conversationHarness(async () => ({
      state: "cleared",
      conversationUrl: null,
    }));
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events).toEqual(["store:set", "load", "conversation:cleared"]);
  });

  it("treats a retained record without an address as corrupt", async () => {
    const h = conversationHarness(async () => ({
      state: "retained",
      conversationUrl: null,
    }));
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events).toEqual([
      "store:set",
      "load",
      "conversation:retained",
      "store:null",
      "conversation:null",
    ]);
  });

  it("treats a non-canonical address as corrupt", async () => {
    const h = conversationHarness(
      async () => retained,
      () => "https://chatgpt.test/",
    );
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events.slice(-2)).toEqual(["store:null", "conversation:null"]);
  });

  it("treats an address that cannot be canonicalized as corrupt", async () => {
    const h = conversationHarness(
      async () => retained,
      () => null,
    );
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events.slice(-2)).toEqual(["store:null", "conversation:null"]);
  });

  it("treats a failing canonicalization as corrupt", async () => {
    const h = conversationHarness(
      async () => retained,
      () => {
        throw new Error("refused");
      },
    );
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events.slice(-2)).toEqual(["store:null", "conversation:null"]);
  });

  it("clears the store and conversation when the load fails", async () => {
    const h = conversationHarness(async () => {
      throw new Error("unreadable");
    });
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events).toEqual([
      "store:set",
      "load",
      "store:null",
      "conversation:null",
    ]);
  });

  it("clears both when the store cannot be created", async () => {
    const h = conversationHarness(
      async () => null,
      undefined,
      () => {
        throw new Error("root refused");
      },
    );
    await expect(recoverChatGptConversation(h.ports)).resolves.toEqual({
      retainedUrl: null,
    });
    expect(h.events).toEqual(["store:null", "conversation:null"]);
  });
});
