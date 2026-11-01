import type { RendererFacade, WindowSnapshot } from "./contract";
import { PreviousSelfTests } from "./previous-self-tests";

export function DeepTestPrompt({
  snapshot,
  facade,
}: Readonly<{ snapshot: WindowSnapshot; facade: RendererFacade }>) {
  const evidence = snapshot.evidence?.value;
  const attempts =
    evidence?.kind === "chatgpt.deep-test-status" ? evidence.attempts : [];
  return (
    <section>
      <button
        type="button"
        onClick={() =>
          void facade.configure(
            { kind: "chatgpt.deep-test-status" },
            `deep-test:status:${crypto.randomUUID()}`,
          )
        }
      >
        Review test results
      </button>
      {attempts.map((attempt) => (
        <div key={attempt.operationId}>
          <p>
            {attempt.state} · {attempt.operationId}
            {attempt.code ? ` · ${attempt.code}` : ""}
          </p>
          <button
            type="button"
            onClick={() =>
              void facade.configure(
                {
                  kind: "chatgpt.ack-deep-test",
                  operationId: attempt.operationId,
                },
                `deep-test:ack:${attempt.operationId}`,
              )
            }
          >
            Acknowledge result
          </button>
        </div>
      ))}
      <PreviousSelfTests
        facade={facade}
        workspaces={
          snapshot.configuration?.status === "ready"
            ? snapshot.configuration.settings.computer.workspaces
            : []
        }
      />
    </section>
  );
}
