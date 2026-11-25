// ChatGPT state recovery at startup: the task journal, the deep-test attempts
// and the retained conversation. Main keeps every owner; each step reports its
// outcome and no failure aborts startup, because each falls back to an empty
// state that the rest of the profile already handles. Nothing here retries.
//
// Two steps publish through setter ports, not a returned value: between their
// awaits a Quit can run, and it must see exactly the assignments that had
// already happened, in the order they happened.

export type ChatGptTaskJournalPorts<
  Journal extends {
    load(): Promise<Task | null>;
    reconcileAfterRestart(): Promise<Task | null>;
  },
  Task extends { readonly result?: Result | null | undefined },
  Result,
> = Readonly<{
  freshStartup: boolean;
  create: () => Journal;
  recordObservation: (result: Result) => Promise<Readonly<{ ok: boolean }>>;
  setJournal: (journal: Journal | null) => void;
  setRecoverableTask: (task: Task | null) => void;
  setObservationPersisted: (persisted: boolean) => void;
}>;

// A fresh generation keeps legacy history read-only: it loads without
// reconciling, drops the writer when anything was retained, and offers nothing
// for redelivery. Otherwise the journal reconciles after the restart and a
// retained result is recorded as an observation. A failure anywhere clears all
// three published values.
export async function recoverChatGptTaskJournal<
  Journal extends {
    load(): Promise<Task | null>;
    reconcileAfterRestart(): Promise<Task | null>;
  },
  Task extends { readonly result?: Result | null | undefined },
  Result,
>(ports: ChatGptTaskJournalPorts<Journal, Task, Result>): Promise<void> {
  try {
    const journal = ports.create();
    const retained = ports.freshStartup
      ? await journal.load()
      : await journal.reconcileAfterRestart();
    ports.setJournal(ports.freshStartup && retained !== null ? null : journal);
    const task = ports.freshStartup ? null : retained;
    ports.setRecoverableTask(task);
    if (!ports.freshStartup && task?.result) {
      const recorded = await ports.recordObservation(task.result);
      ports.setObservationPersisted(recorded.ok);
    }
  } catch {
    ports.setJournal(null);
    ports.setRecoverableTask(null);
    ports.setObservationPersisted(false);
  }
}

export type DeepTestRecovery<Attempt> =
  | Readonly<{ ready: true; tests: readonly Attempt[] }>
  | Readonly<{ ready: false }>;

// The recovered attempts are known only when the whole scan succeeded; a
// failure answers not ready and leaves the caller's attempts as they were.
export async function recoverDeepTests<Attempt>(
  recover: () => Promise<readonly Attempt[]>,
): Promise<DeepTestRecovery<Attempt>> {
  try {
    return { ready: true, tests: await recover() };
  } catch {
    return { ready: false };
  }
}

export type ChatGptConversationPorts<
  Store extends { load(): Promise<Conversation | null> },
  Conversation extends {
    readonly state: string;
    readonly conversationUrl: string | null;
  },
> = Readonly<{
  create: () => Store;
  canonicalUrl: (url: string) => string | null;
  setStore: (store: Store | null) => void;
  setConversation: (conversation: Conversation | null) => void;
}>;

// `retainedUrl` is the canonical address of a retained conversation, or null
// when the profile starts at its home. A retained record without an address,
// or whose address is not already canonical, is corrupt: the store and the
// conversation are cleared and the profile starts at home.
export async function recoverChatGptConversation<
  Store extends { load(): Promise<Conversation | null> },
  Conversation extends {
    readonly state: string;
    readonly conversationUrl: string | null;
  },
>(
  ports: ChatGptConversationPorts<Store, Conversation>,
): Promise<Readonly<{ retainedUrl: string | null }>> {
  try {
    const store = ports.create();
    ports.setStore(store);
    const conversation = await store.load();
    ports.setConversation(conversation);
    if (conversation?.state !== "retained") return { retainedUrl: null };
    const url = conversation.conversationUrl;
    if (url === null) throw new Error("CHATGPT_CONVERSATION_STATE_CORRUPT");
    const canonical = ports.canonicalUrl(url);
    if (canonical !== url)
      throw new Error("CHATGPT_CONVERSATION_STATE_CORRUPT");
    return { retainedUrl: canonical };
  } catch {
    ports.setStore(null);
    ports.setConversation(null);
    return { retainedUrl: null };
  }
}
