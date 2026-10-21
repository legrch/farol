import { useEffect, useState } from "react";

type Frame = Readonly<{
  caption: string;
  page: string;
  button: string;
  fields: readonly (readonly [string, string])[];
  cursor: readonly [number, number];
}>;
const tunnelFrames: readonly Frame[] = [
  {
    caption: "Open OpenAI → Tunnels",
    page: "Tunnels",
    button: "Create tunnel",
    fields: [],
    cursor: [82, 20],
  },
  {
    caption: "Press Create tunnel",
    page: "Create tunnel",
    button: "Create",
    fields: [
      ["Name", ""],
      ["ChatGPT workspace", ""],
    ],
    cursor: [82, 20],
  },
  {
    caption: "Name it “Farol”",
    page: "Create tunnel",
    button: "Create",
    fields: [
      ["Name", "Farol"],
      ["Description", "Farol on my Mac"],
    ],
    cursor: [48, 48],
  },
  {
    caption: "Choose your ChatGPT workspace, then Create",
    page: "Create tunnel",
    button: "Create",
    fields: [
      ["Name", "Farol"],
      ["ChatGPT workspace", "My workspace"],
    ],
    cursor: [78, 78],
  },
  {
    caption: "Copy the tunnel ID",
    page: "Tunnels",
    button: "Copy",
    fields: [["Farol", "Your tunnel ID"]],
    cursor: [82, 45],
  },
  {
    caption: "Open API keys",
    page: "API keys",
    button: "Create new secret key",
    fields: [],
    cursor: [16, 46],
  },
  {
    caption: "Create a Restricted key named “Farol”",
    page: "Create new secret key",
    button: "Create secret key",
    fields: [
      ["Name", "Farol"],
      ["Permissions", "Restricted"],
    ],
    cursor: [48, 48],
  },
  {
    caption: "Allow Tunnels: Read and Use, then Create",
    page: "Create new secret key",
    button: "Create secret key",
    fields: [
      ["Name", "Farol"],
      ["Permissions", "Restricted"],
      ["Tunnels", "Read and Use"],
    ],
    cursor: [78, 78],
  },
  {
    caption: "Copy the key — it is shown only once",
    page: "API keys",
    button: "Copy",
    fields: [["Farol", "••••••••••••"]],
    cursor: [82, 45],
  },
];
/** Illustrations only. No provider pages, requests, credentials or screenshots. */
export function SetupWalkthrough() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [scene, setScene] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    change();
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (reduced || paused) return;
    const timer = window.setInterval(
      () => setScene((value) => (value + 1) % tunnelFrames.length),
      2400,
    );
    return () => window.clearInterval(timer);
  }, [reduced, paused]);
  if (reduced)
    return (
      <ol
        className="walkthrough-static"
        aria-label="Create a tunnel and a key: numbered frames"
      >
        {tunnelFrames.map((frame, index) => (
          <li key={index}>
            <strong>
              {index + 1}. {frame.caption}
            </strong>
            <FrameView frame={frame} animated={false} />
          </li>
        ))}
      </ol>
    );
  const frame = tunnelFrames[scene]!;
  return (
    <figure
      className="setup-walkthrough"
      aria-label="Create a tunnel and a key walkthrough"
    >
      <FrameView frame={frame} animated />
      <figcaption>
        <span>
          {scene + 1} / {tunnelFrames.length}
        </span>{" "}
        {frame.caption}
      </figcaption>
      <button
        type="button"
        className="text-button"
        onClick={() => setPaused((value) => !value)}
      >
        {paused ? "Play walkthrough" : "Pause walkthrough"}
      </button>
      <span className="description">Illustrated guide</span>
    </figure>
  );
}
function FrameView({ frame, animated }: { frame: Frame; animated: boolean }) {
  return (
    <div
      className="walkthrough-scene"
      aria-hidden={animated ? "true" : undefined}
    >
      <div className="walkthrough-address">
        platform.openai.com ›{" "}
        {frame.page.includes("key") ? "API keys" : "Tunnels"}
      </div>
      <div className="walkthrough-body">
        <div className="walkthrough-nav">
          <span>Tunnels</span>
          <span>API keys</span>
          <span>Usage</span>
          <span>Settings</span>
        </div>
        <div className="walkthrough-content">
          <div className="walkthrough-heading">
            <strong>{frame.page}</strong>
            <span className="walkthrough-button">{frame.button}</span>
          </div>
          {frame.fields.length === 0 ? (
            <p className="description">Your organization</p>
          ) : (
            <dl>
              {frame.fields.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value || "…"}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
      {animated && (
        <svg
          className="walkthrough-cursor"
          style={{ left: `${frame.cursor[0]}%`, top: `${frame.cursor[1]}%` }}
          viewBox="0 0 20 24"
        >
          <path d="M2 2v18l5-5 4 7 4-2-4-7h7Z" />
        </svg>
      )}
    </div>
  );
}
