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
const chatgptFrames = (tunnelId: string): readonly Frame[] => [
  {
    caption: "Open ChatGPT Settings → Apps",
    page: "Apps",
    button: "Create app",
    fields: [],
    cursor: [16, 46],
  },
  {
    caption: "Choose Create app",
    page: "Create app",
    button: "Create",
    fields: [["Name", ""]],
    cursor: [82, 20],
  },
  {
    caption: "Name the app “Farol”",
    page: "Create app",
    button: "Create",
    fields: [["Name", "Farol"]],
    cursor: [48, 48],
  },
  {
    caption: "Choose Tunnel and enter your tunnel ID",
    page: "Create app",
    button: "Create",
    fields: [
      ["Name", "Farol"],
      ["Connection", "Tunnel"],
      ["Tunnel ID", tunnelId || "Your tunnel ID"],
    ],
    cursor: [48, 60],
  },
  {
    caption: "Set sign-in to None, then Create",
    page: "Create app",
    button: "Create",
    fields: [
      ["Name", "Farol"],
      ["Connection", "Tunnel"],
      ["Sign-in", "None"],
    ],
    cursor: [78, 78],
  },
  {
    caption: "Return to Farol and test in ChatGPT",
    page: "Apps",
    button: "Farol",
    fields: [["App", "Farol"]],
    cursor: [82, 45],
  },
];
/** Illustrations only. No provider pages, requests, credentials or screenshots. */
export function SetupWalkthrough({
  kind = "tunnel",
  tunnelId = "",
}: {
  kind?: "tunnel" | "chatgpt";
  tunnelId?: string;
}) {
  const frames = kind === "tunnel" ? tunnelFrames : chatgptFrames(tunnelId);
  const label =
    kind === "tunnel" ? "Create a tunnel and a key" : "Add to ChatGPT";
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
      () => setScene((value) => (value + 1) % frames.length),
      2400,
    );
    return () => window.clearInterval(timer);
  }, [reduced, paused, frames.length]);
  if (reduced)
    return (
      <ol
        className="walkthrough-static"
        aria-label={`${label}: numbered frames`}
      >
        {frames.map((frame, index) => (
          <li key={index}>
            <strong>
              {index + 1}. {frame.caption}
            </strong>
            <FrameView frame={frame} animated={false} kind={kind} />
          </li>
        ))}
      </ol>
    );
  const frame = frames[scene % frames.length]!;
  return (
    <figure className="setup-walkthrough" aria-label={`${label} walkthrough`}>
      <FrameView frame={frame} animated kind={kind} />
      <figcaption>
        <span>
          {scene + 1} / {frames.length}
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
function FrameView({
  frame,
  animated,
  kind,
}: {
  frame: Frame;
  animated: boolean;
  kind: "tunnel" | "chatgpt";
}) {
  return (
    <div
      className="walkthrough-scene"
      aria-hidden={animated ? "true" : undefined}
    >
      <div className="walkthrough-address">
        {kind === "chatgpt"
          ? "chatgpt.com › Settings › Apps"
          : `platform.openai.com › ${frame.page.includes("key") ? "API keys" : "Tunnels"}`}
      </div>
      <div className="walkthrough-body">
        <div className="walkthrough-nav">
          <span>{kind === "chatgpt" ? "General" : "Tunnels"}</span>
          <span>{kind === "chatgpt" ? "Apps" : "API keys"}</span>
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
