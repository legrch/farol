import { useId, useState, type ReactNode } from "react";

type Card = Readonly<{
  title: string;
  detail: string;
}>;
const tunnelCards: readonly Card[] = [
  {
    title: "Create a tunnel",
    detail: "On the Tunnels page",
  },
  {
    title: "Create a key",
    detail: "Permission: Restricted",
  },
  {
    title: "Copy both here",
    detail: "Tunnel ID and key",
  },
];
const chatgptCards: readonly Card[] = [
  {
    title: "Settings → Connectors",
    detail: "Open ChatGPT settings",
  },
  {
    title: "Enter your app details",
    detail: "No additional sign-in",
  },
  {
    title: "Test in ChatGPT",
    detail: "Return to Farol to test",
  },
];

const tunnelInstructions: readonly (readonly string[])[] = [
  [
    "Open OpenAI Tunnels and choose Create tunnel.",
    "Give the tunnel a name you can recognize. Use Farol Dev for a separate test connection.",
    "Choose the workspace that contains your ChatGPT app, then create the tunnel.",
  ],
  [
    "In OpenAI, open API keys and create a new key.",
    "Choose Restricted permissions. Allow Tunnels: Read and Use.",
    "Copy the key while it is shown. Paste it only into Farol’s Key field.",
  ],
  [
    "Copy the complete tunnel ID into Tunnel ID below.",
    "Paste the key into Key, then choose Connect once.",
    "When the connection is confirmed, choose Continue to add the app in ChatGPT.",
  ],
];
const appInstructions: readonly (readonly string[])[] = [
  [
    "In ChatGPT settings, open Apps or Connectors and choose to add an app.",
    "Use the Open ChatGPT Apps link below to open the app setup page.",
  ],
  [
    "Use the exact app name shown in Farol below. Keep a separate name for Dev if you already use Farol.",
    "Choose Tunnel and paste the exact tunnel ID shown below for this Mac. The app name alone does not select a Mac.",
    "For Dev, use a dedicated tunnel rather than a tunnel already used by another Farol instance.",
    "Set App authentication to None, then create the app. This is the connector setting, separate from your ChatGPT account sign-in.",
  ],
  [
    "Return to Farol. If Test in ChatGPT is available, run it once.",
    "If an earlier test is unconfirmed, choose Check for confirmation. This reads the saved result without sending a new message.",
    "Farol opens a separate ordinary Instant chat, selects your app and sends one test message.",
    "Wait for the result. If it cannot be confirmed, inspect the saved result before trying another action.",
  ],
];

/** Offline, always-open guidance. Navigation never runs a check or sends. */
export function SetupWalkthrough({
  kind = "tunnel",
  openLink,
}: {
  kind?: "tunnel" | "chatgpt";
  openLink: ReactNode;
}) {
  const cards = kind === "tunnel" ? tunnelCards : chatgptCards;
  const instructions = kind === "tunnel" ? tunnelInstructions : appInstructions;
  const label =
    kind === "tunnel" ? "Create a tunnel and a key" : "Add to ChatGPT";
  const [selected, setSelected] = useState(0);
  const regionId = useId();
  return (
    <div className="setup-walkthrough">
      <p className="walkthrough-hint">
        Follow the steps below. You can return to any instruction.
      </p>
      <ol className="walkthrough-cards" aria-label={`${label} walkthrough`}>
        {cards.map((card, index) => (
          <li key={card.title} data-active={selected === index}>
            <button
              type="button"
              className="walkthrough-step"
              aria-current={selected === index ? "step" : undefined}
              aria-expanded={selected === index}
              aria-controls={regionId}
              onClick={() => setSelected(index)}
            >
              <span className="walkthrough-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="walkthrough-step-copy">
                <strong>{card.title}</strong>
                <span>{card.detail}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <section
        id={regionId}
        className="walkthrough-detail"
        aria-label={`${label} instructions`}
      >
        <h4>
          {selected + 1}. {cards[selected]!.title}
        </h4>
        <ol>
          {instructions[selected]!.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        <div className="walkthrough-pagination">
          {selected > 0 && (
            <button
              type="button"
              className="text-button"
              aria-label="Previous instruction"
              onClick={() => setSelected(selected - 1)}
            >
              Previous
            </button>
          )}
          {selected < cards.length - 1 && (
            <button
              type="button"
              className="subtle walkthrough-next"
              aria-label="Next instruction"
              onClick={() => setSelected(selected + 1)}
            >
              Next
            </button>
          )}
        </div>
      </section>
      <div className="walkthrough-actions">{openLink}</div>
    </div>
  );
}
