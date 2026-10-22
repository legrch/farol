import { useEffect, useState, type ReactNode } from "react";

type Card = Readonly<{
  title: string;
  detail: string;
  screen: string;
  action: string;
  lines: readonly [string, string];
}>;
const tunnelCards: readonly Card[] = [
  {
    title: "Create a tunnel",
    detail: "On the Tunnels page",
    screen: "Tunnels",
    action: "Create tunnel",
    lines: ["Name: Farol", "Workspace"],
  },
  {
    title: "Create a key",
    detail: "Permission: Restricted",
    screen: "API keys",
    action: "Create key",
    lines: ["Restricted", "Tunnels: Read and Use"],
  },
  {
    title: "Copy both here",
    detail: "Tunnel ID and key",
    screen: "Connect this Mac",
    action: "Copy",
    lines: ["Tunnel ID", "Key: ••••••••"],
  },
];
const chatgptCards: readonly Card[] = [
  {
    title: "Settings → Connectors",
    detail: "Open ChatGPT settings",
    screen: "Settings",
    action: "Connectors",
    lines: ["General", "Connectors"],
  },
  {
    title: "Add Farol: name, Tunnel, ID",
    detail: "Sign-in: None",
    screen: "Add Farol",
    action: "Create",
    lines: ["Name: Farol", "Tunnel · Tunnel ID"],
  },
  {
    title: "Test in ChatGPT",
    detail: "Return to Farol to test",
    screen: "Farol",
    action: "Test",
    lines: ["ChatGPT → This Mac", "Workspace access"],
  },
];

/** Offline drawings only. Never receives credentials, IDs or provider page contents. */
export function SetupWalkthrough({
  kind = "tunnel",
  openLink,
}: {
  kind?: "tunnel" | "chatgpt";
  openLink: ReactNode;
}) {
  const cards = kind === "tunnel" ? tunnelCards : chatgptCards;
  const label =
    kind === "tunnel" ? "Create a tunnel and a key" : "Add to ChatGPT";
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const [scene, setScene] = useState(0);
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    change();
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (reduced || scene >= cards.length) return;
    const timer = window.setTimeout(() => setScene((value) => value + 1), 1600);
    return () => window.clearTimeout(timer);
  }, [reduced, scene, replay, cards.length]);
  const playing = !reduced && scene < cards.length;
  return (
    <div className="setup-walkthrough" data-playing={playing}>
      <ol className="walkthrough-cards" aria-label={`${label} walkthrough`}>
        {cards.map((card, index) => {
          const active = playing && scene === index;
          return (
            <li key={card.title} data-active={active}>
              <ScreenDrawing card={card} active={active} key={replay} />
              <strong>
                {index + 1} · {card.title}
              </strong>
              <span>{card.detail}</span>
            </li>
          );
        })}
      </ol>
      <div className="walkthrough-actions">
        {openLink}
        <button
          type="button"
          className="text-button"
          aria-label={`Replay ${label} walkthrough`}
          disabled={reduced}
          onClick={() => {
            setScene(0);
            setReplay((value) => value + 1);
          }}
        >
          <span aria-hidden="true">↻ </span>Replay
        </button>
      </div>
    </div>
  );
}

function ScreenDrawing({ card, active }: { card: Card; active: boolean }) {
  return (
    <svg
      className="walkthrough-drawing"
      viewBox="0 0 190 58"
      aria-hidden="true"
    >
      <path d="M0 16H190M42 16V58" />
      <path d="M8 25H32M8 33H27M8 41H30" />
      <text x="8" y="11">
        {card.screen}
      </text>
      <rect x="116" y="3" width="68" height="11" rx="3" />
      <text x="150" y="11" textAnchor="middle">
        {card.action}
      </text>
      <rect x="48" y="23" width="134" height="12" rx="3" />
      <rect x="48" y="40" width="134" height="12" rx="3" />
      {card.lines.map((line, index) => (
        <text key={line} x="53" y={31 + index * 17}>
          {line}
        </text>
      ))}
      {active && (
        <path
          className="walkthrough-cursor"
          d="m150 10 1 14 4-4 4 6 3-2-4-6 6-1Z"
        />
      )}
    </svg>
  );
}
