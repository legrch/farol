/* Setup flows. Page structure follows the storyboard taken from the real screens: Farol's rail,
   OpenAI's settings navigation, ChatGPT's Customize and Settings pages, modals over the page.
   Only the palette is ours. All accounts, IDs, keys and results are synthetic. */
const TUNNEL = "tunnel_00000000000000000000000000000001";
const WS = "00000000-0000-0000-0000-000000000001";
const PATH = "/Users/demo/Documents/Farol Demo";
const ICON = "../../../../resources/brand/sunrise-dock/farol-sunrise.png";

const btn = (label, id = "", kind = "") =>
  `<span class="b ${kind}" ${id ? `id="${id}"` : ""}>${label}</span>`;
const pri = (label, id = "") => btn(label, id, "p");
const off = (label) => btn(label, "", "off");
const ok = (text) => `<div class="ok">✓ ${text}</div>`;
const wait = (text) => `<div class="pending"><i></i>${text}</div>`;
const field = (
  label,
  value,
  { id = "", hint = "", empty = false, mono = false } = {},
) =>
  `<div class="fd"><label>${label}</label><div class="in ${empty ? "empty" : ""} ${mono ? "mono" : ""}" ${id ? `id="${id}"` : ""}>${value}</div>${hint ? `<small>${hint}</small>` : ""}</div>`;
const typing = (text, p) =>
  text.slice(0, Math.round(text.length * Math.min(1, p * 1.3)));
const lights = `<span class="lights"><i></i><i></i><i></i></span>`;

/* ---- Farol ---- */
const STEPS = ["Sign in", "Workspaces", "Connect this Mac", "Add to ChatGPT"];
const progress = (done) =>
  `<div class="prog"><span>Overview</span>${STEPS.map((s, i) => (i < done ? `<span class="done">✓ ${s}</span>` : i === done ? `<b>${i + 1} ${s}</b>` : `<span>${i + 1} ${s}</span>`)).join("")}</div>`;
const farol = (
  crumb,
  body,
  { side = "Setup", connected = false, right = "" } = {},
) =>
  `<div class="window g"><div class="bar">${lights}${crumb.split(" / ")[0]}<span class="crumb">/ ${crumb.split(" / ")[1]}</span><span class="tools">${right || `⌕ Find a page<kbd>⌘ K</kbd>`}</span></div>
   <div class="side">${["Home", "ChatGPT", "Activity", "Setup"].map((x) => `<div class="${x === side ? "on" : ""}">${x}</div>`).join("")}
     <div class="bottom"><div class="${connected ? "dotok" : ""}">${connected ? "● Connected" : "○ Not connected"}</div><div class="${side === "Settings" ? "on" : ""}">Settings</div></div></div>
   <div class="content">${body}</div></div>`;
const setup = (page, done, body, connected = false) =>
  farol(`Setup / ${page}`, progress(done) + body, { connected });
const foot = (cont = false) =>
  `<div class="foot">${btn("Back")}${cont ? pri("Continue", "continue") : off("Continue")}</div>`;

const signPage = (status, cont = false) =>
  setup(
    "Sign in",
    0,
    `<h2>Sign in to ChatGPT</h2><p>Use your own ChatGPT account. Farol checks sign-in before you continue.</p>${status}${foot(cont)}`,
  );
const chatTab = (body, connected = false, crumb = "Sign in") =>
  farol(`ChatGPT / ${crumb}`, `<div class="center">${body}</div>`, {
    side: "ChatGPT",
    connected,
    right: `<span class="b" id="return">← Back to setup</span>`,
  });
const OVERVIEW = [
  ["Sign in", "Sign in with your ChatGPT account"],
  ["Workspaces", "Choose folders for ChatGPT"],
  ["Connect this Mac", "Connect this Mac with your tunnel"],
  ["Add to ChatGPT", "Add Farol and test the connection"],
];
const signin = [
  {
    n: 1,
    cap: "Open Setup and choose Start setup",
    target: "start",
    s: () =>
      setup(
        "Overview",
        0,
        `<h2>Welcome to Farol</h2><p>Let ChatGPT work with workspaces on this Mac. Setup takes about five minutes, and every step checks itself.</p><p><strong>0 of 4 steps ready.</strong> Your progress is saved as you go.</p>
        <div class="list">${OVERVIEW.map(([a, b], i) => `<div><em>${i + 1}</em><strong>${a}</strong><span>${b}</span></div>`).join("")}</div>${pri("Start setup", "start")}`,
      ),
  },
  {
    n: 2,
    cap: "Choose Sign in. Farol opens its ChatGPT tab",
    target: "signin",
    s: () =>
      signPage(
        `<p>Sign in to your ChatGPT account, then return here.</p>${pri("Sign in", "signin")}<div class="detail" style="margin-top:12px"><strong>Your next step</strong><p>Sign in to ChatGPT, then return to Setup.</p></div>`,
      ),
  },
  {
    n: 3,
    cap: "Choose your usual sign-in method. Google is shown here",
    target: "google",
    s: () =>
      chatTab(
        `<div class="card"><h3>Log in or sign up</h3><p>Welcome back to ChatGPT</p>${btn("Continue with Google", "google", "wide")}${btn("Continue with Apple", "", "wide")}${btn("Continue with Microsoft", "", "wide")}<p class="small" style="margin-top:10px">Sign-in options and screens may vary by account.</p></div>`,
      ),
  },
  {
    n: 3,
    cap: "Use your own account. This example has no real login details",
    target: "account",
    s: () =>
      chatTab(
        `<div class="card"><h3>Choose an account</h3><p>to continue to OpenAI</p>${btn("Demo User · demo@example.com", "account", "wide")}<p class="small" style="margin-top:10px">Illustration only. Use your own account when signing in.</p></div>`,
      ),
  },
  {
    n: 4,
    cap: "After signing in, choose Back to setup",
    target: "return",
    s: () =>
      chatTab(
        `<h3>What can I help with?</h3><div class="ask">Ask anything</div><p>Signed in. Return to Setup to check your sign-in.</p>`,
      ),
  },
  {
    n: 5,
    cap: "Choose Check sign-in once, then wait for the result",
    target: "check",
    s: () =>
      signPage(
        `<p>You’re signed in. Check sign-in to continue.</p>${pri("Check sign-in", "check")}`,
      ),
  },
  {
    n: 5,
    cap: "Farol checks sign-in. Wait for the confirmation",
    hold: 1.6,
    s: () => signPage(wait("Checking sign-in…")),
  },
  {
    n: 6,
    cap: "When Sign-in checked appears, choose Continue",
    target: "continue",
    s: () =>
      signPage(
        `${ok("Sign-in checked")}<p>Your ChatGPT sign-in is confirmed. Continue to choose workspaces.</p>`,
        true,
      ),
  },
];

/* ---- Workspaces ---- */
const wsHead = `<h2>Choose workspaces</h2><p>Farol enforces the workspace access you approve here. ChatGPT manages action confirmations.</p>`;
const COMMANDS = `<p class="small" style="margin-top:10px">Commands lets ChatGPT run Git, tests and builds in approved workspaces, including Git history, hooks and your Git configuration. Command access is shared by all workspaces.</p>`;
const wsRow = ({
  access = "Read only",
  state = "",
  commands = false,
  menu = "",
} = {}) =>
  `<div class="row"><div class="rt"><strong>Farol Demo</strong><span class="mono">${PATH}</span></div>
    <div class="rc"><label>Access</label><div class="sel" id="access">${access} ⌄</div>${menu}
    <label class="chk" id="commands"><i class="${commands ? "on" : ""}">${commands ? "✓" : ""}</i>Commands</label></div>
    <div class="rb">${state}<span class="link" id="remove">Remove Farol Demo</span></div></div>`;
const wsPage = (row, cont = false, add = true) =>
  setup(
    "Workspaces",
    1,
    `${wsHead}${row}${add ? `<div class="gap">${btn("+ Add workspace", "add")}</div>` : ""}${COMMANDS}${foot(cont)}`,
  );
const EMPTY = `<div class="row none"><p>Add a workspace to continue.</p></div>`;
const picker = (selected) =>
  setup(
    "Workspaces",
    1,
    `${wsHead}${EMPTY}<div class="gap">${btn("+ Add workspace")}</div>${COMMANDS}${foot()}<div class="shade" style="left:-136px;top:-34px"></div>`,
  ).replace(
    `<div class="content">`,
    `<div class="opan"><div class="oh">Documents<span>⌕ Search</span></div><div class="ol"><div>Recents</div><div>Applications</div><div>Desktop</div><div><b>Documents</b></div><div>Downloads</div></div><div class="or">${["Archive", "Farol Demo", "Taxes", "Photos"].map((x) => `<div class="${selected && x === "Farol Demo" ? "on" : ""}" ${x === "Farol Demo" ? 'id="folder"' : ""}>▸ ${x}</div>`).join("")}</div><div class="foot">${btn("Cancel")}${selected ? pri("Open", "open") : off("Open")}</div></div><div class="content">`,
  );
const workspace = [
  {
    n: 1,
    cap: "Choose + Add workspace",
    target: "add",
    s: () => wsPage(EMPTY),
  },
  {
    n: 2,
    cap: "Select a small folder with non-sensitive sample files",
    target: "folder",
    s: () => picker(false),
  },
  {
    n: 2,
    cap: "Choose Open to add the selected folder",
    target: "open",
    s: () => picker(true),
  },
  {
    n: 3,
    cap: "New workspaces start with Read only. Farol checks access",
    hold: 1.6,
    s: () =>
      wsPage(wsRow({ state: wait("Checking workspace…") }), false, false),
  },
  {
    n: 4,
    cap: "Wait for Works. Read only leaves files unchanged",
    hold: 1.8,
    s: () => wsPage(wsRow({ state: ok("Works") }), true),
  },
  {
    n: 5,
    cap: "Choose Continue after every listed workspace says Works",
    target: "continue",
    s: () => wsPage(wsRow({ state: ok("Works") }), true),
  },
];
const accessMenu = `<div class="menu" style="top:26px;left:50px"><div>✓ Read only</div><div id="rw">Read &amp; write</div></div>`;
const RW = "Read &amp; write";
const access = [
  {
    n: 1,
    cap: "Keep Read only unless you need ChatGPT to edit files",
    target: "access",
    s: () => wsPage(wsRow({ state: ok("Works") }), true),
  },
  {
    n: 2,
    cap: "For approved file edits, choose Read & write",
    target: "rw",
    s: () => wsPage(wsRow({ state: ok("Works"), menu: accessMenu }), true),
  },
  {
    n: 2,
    cap: "Farol saves the change and checks workspace access",
    hold: 1.5,
    s: () =>
      wsPage(
        wsRow({ access: RW, state: wait("Checking workspace…") }),
        false,
        false,
      ),
  },
  {
    n: 3,
    cap: "Wait for Works before using the new access",
    hold: 1.5,
    s: () => wsPage(wsRow({ access: RW, state: ok("Works") }), true),
  },
  {
    n: 4,
    cap: "Enable Commands only if you need Git, tests or builds",
    target: "commands",
    s: () => wsPage(wsRow({ access: RW, state: ok("Works") }), true),
  },
  {
    n: 4,
    cap: "Command access applies to all approved workspaces",
    hold: 1.8,
    s: () =>
      wsPage(
        wsRow({
          access: RW,
          commands: true,
          state: wait("Checking workspace…"),
        }),
        false,
        false,
      ),
  },
  {
    n: 5,
    cap: "Works confirms the check. ChatGPT still manages action approvals",
    hold: 2.2,
    s: () =>
      wsPage(wsRow({ access: RW, commands: true, state: ok("Works") }), true),
  },
];

/* ---- Connect this Mac ---- */
const connectForm = ({
  id = "",
  key = "",
  status = "",
  action = "off",
  cont = false,
  saved = false,
  connected = false,
} = {}) =>
  setup(
    "Connect this Mac",
    2,
    `<h2>Connect this Mac</h2><p>You need two things from OpenAI: a tunnel ID and its key.</p><h3>3. Copy both here</h3>
    ${field("Tunnel ID", id, { id: "tunnelid", mono: true })}
    ${field("Key", key || "Paste your key", { id: "key", empty: !key, mono: !!key, hint: saved ? "Key saved on this Mac. Paste a new key only to replace it." : "Your key is saved privately on this Mac." })}
    <div class="gap">${action === "on" ? pri("Connect", "connect") : action === "busy" ? off("Connecting…") : action === "done" ? btn("Disconnect") : off("Connect")}${status}</div>
    ${action === "off" || action === "on" ? `<p class="small" style="margin-top:8px">Enter your tunnel ID and key, then connect.</p>` : ""}${foot(cont)}`,
    connected,
  );

/* ---- OpenAI Platform ---- */
const NAV = [
  "General",
  "API keys",
  "Admin keys",
  "People",
  "Projects",
  "Billing",
  "Limits",
  "Tunnels",
  "Usage",
  "Service health",
  "Data controls",
  "Security",
  "Webhooks",
];
const platform = (kind, action, body, overlay = "") =>
  `<div class="window g"><div class="bar url">${lights}<span class="addr">platform.openai.com/settings/organization/${kind === "Tunnels" ? "tunnels" : "api-keys"}</span></div>
    <div class="site"><div class="sn"><div>← Back to project</div><div class="label"></div>${NAV.map((x) => `<div class="${x === kind ? "on" : ""}">${x}</div>`).join("")}<div class="org">Demo organization</div></div>
    <div class="sm"><div class="pagehead"><h2>${kind}</h2>${action}</div>${body}</div>${overlay ? `<div class="shade"></div>${overlay}` : ""}</div></div>`;
const modal = (title, body, actions, extra = "") =>
  `<div class="modal ${extra}"><div class="mh">${title}<span>×</span></div><div class="mb">${body}</div>${actions ? `<div class="foot">${actions}</div>` : ""}</div>`;
const tunnelEmpty = `<div class="searchbox">⌕ Search…</div><div class="center"><h3>No tunnels yet</h3><p>Create your first tunnel to connect MCP servers behind a firewall.</p></div>`;
const tunnelsPage = (overlay = "", id = "") =>
  platform("Tunnels", pri("Create tunnel", id), tunnelEmpty, overlay);
const tunnelModal = ({ name = "", desc = "", ws = "", menu = false } = {}) =>
  tunnelsPage(
    modal(
      "Create tunnel",
      field("Name *", name || "e.g. West Coast MCP tunnel", {
        id: "name",
        empty: !name,
      }) +
        field(
          "Description *",
          desc || "Add a short description to help your team.",
          {
            id: "desc",
            empty: !desc,
            hint: "Required. Add a short description to help your team.",
          },
        ) +
        field("Organizations", "Demo organization ⌄", {
          hint: "Select one or more organizations, or search for an exact organization ID.",
        }) +
        `<div class="relative">${field("ChatGPT workspaces", ws || "Search workspaces by name or ID ⌄", { id: "workspace", empty: !ws, mono: !!ws, hint: "Select ChatGPT workspaces, or search for an exact workspace ID." })}${menu ? `<div class="menu" style="top:54px;left:0;right:0"><div class="empty">⌕ Search workspaces by name or ID</div><div id="wsopt" class="mono">${WS}</div></div>` : ""}</div>
     <div class="perm" style="border:0;border-top:1px solid var(--line);margin-top:2px"><span>Optional security</span></div><label class="chk risk"><i></i>Restrict client network access</label>`,
      btn("Cancel") + (ws ? pri("Create", "create") : off("Create")),
    ),
  );
const DESC = "Connect my demo Mac to approved sample folders.";
const tunnelRow = (copied) =>
  platform(
    "Tunnels",
    pri("Create tunnel"),
    `${ok("Tunnel created successfully.")}
    <div class="table"><div class="th"><span>Tunnel</span><span>ID</span></div><div class="tr"><span><strong>Farol Demo</strong><br>Demo Mac access</span><span class="mono">${TUNNEL}</span>${btn(copied ? "Copied" : "Copy", "copy")}</div></div>`,
  );
const walk = setup(
  "Connect this Mac",
  2,
  `<h2>Connect this Mac</h2><p>You need two things from OpenAI: a tunnel ID and its key.</p><h3>1. Create a tunnel and a key</h3>
    <div class="walk"><div class="on"><strong>1 Create a tunnel</strong>On the Tunnels page</div><div><strong>2 Create a key</strong>Permission: Restricted</div><div><strong>3 Copy both here</strong>Tunnel ID and key</div></div>
    <div class="detail"><strong>1. Create a tunnel</strong><p>Open OpenAI Tunnels and choose Create tunnel. Give the tunnel a name you will recognize, then copy its ID.</p>${pri("Open OpenAI Tunnels", "open")}</div>${foot()}`,
);
const tunnel = [
  {
    n: 1,
    cap: "In Farol, choose Open OpenAI Tunnels",
    target: "open",
    s: () => walk,
  },
  {
    n: 2,
    cap: "On the OpenAI Tunnels page, choose Create tunnel",
    target: "newt",
    s: () => tunnelsPage("", "newt"),
  },
  {
    n: 3,
    cap: "Give this Mac’s tunnel a recognizable name",
    target: "name",
    s: () => tunnelModal(),
  },
  {
    n: 3,
    cap: "Give this Mac’s tunnel a recognizable name",
    hold: 0.9,
    s: (p) => tunnelModal({ name: typing("Farol Demo", p) }),
  },
  {
    n: 4,
    cap: "Add the required description. These are sample values",
    target: "desc",
    s: () => tunnelModal({ name: "Farol Demo" }),
  },
  {
    n: 4,
    cap: "Add the required description. These are sample values",
    hold: 1.5,
    s: (p) => tunnelModal({ name: "Farol Demo", desc: typing(DESC, p) }),
  },
  {
    n: 5,
    cap: "Review the organization, then choose your ChatGPT workspace",
    target: "workspace",
    s: () => tunnelModal({ name: "Farol Demo", desc: DESC }),
  },
  {
    n: 5,
    cap: "Choose your ChatGPT workspace. It may appear as an ID",
    target: "wsopt",
    s: () => tunnelModal({ name: "Farol Demo", desc: DESC, menu: true }),
  },
  {
    n: 6,
    cap: "Review your selection and optional restriction, then Create",
    target: "create",
    s: () => tunnelModal({ name: "Farol Demo", desc: DESC, ws: WS }),
  },
  {
    n: 7,
    cap: "Copy the complete tunnel ID from its row",
    target: "copy",
    s: () => tunnelRow(false),
  },
  {
    n: 7,
    cap: "Before copying a key, return to Farol and paste this tunnel ID",
    hold: 1.5,
    s: () => tunnelRow(true),
  },
  {
    n: 8,
    cap: "Paste the tunnel ID before a key replaces your clipboard",
    target: "tunnelid",
    s: () => connectForm(),
  },
  {
    n: 8,
    cap: "The tunnel ID is now in Farol. Next, create the restricted key",
    hold: 1.8,
    s: () => connectForm({ id: TUNNEL }),
  },
];

/* ---- Restricted key ---- */
const keysPage = (overlay = "", id = "") =>
  platform(
    "API keys",
    pri("+ Create new secret key", id),
    `<div class="searchbox">⌕ Search…</div><div class="center"><h3>Create an API key to access the OpenAI API</h3></div>`,
    overlay,
  );
const keyFirst = (name, restricted = false) =>
  keysPage(
    modal(
      "Create new secret key",
      `<div class="fd"><label>Owned by</label><div class="seg"><span class="on">You</span><span>Service account</span></div><small>This API key is tied to your user and can make requests against the selected project.</small></div>` +
        field(
          "Name <span class='small'>Optional</span>",
          name || "My Test Key",
          { id: "keyname", empty: !name },
        ) +
        field("Project", "[your selected project]") +
        field("Expiration", "[your selected expiration]") +
        `<div class="fd"><label>Permissions</label><div class="seg"><span class="${restricted ? "" : "on"}">All</span><span id="restricted" class="${restricted ? "on" : ""}">Restricted</span><span>Read only</span></div></div>`,
      btn("Cancel") + off("Create secret key"),
    ),
  );
const PERMS = [
  "Fine-tuning",
  "Files",
  "Videos",
  "Vector Stores",
  "Prompts",
  "Batch",
  "Tunnels",
  "Datasets",
  "Safety",
];
const keyPerms = (count, menu = false) => {
  const value = count === 2 ? "All selected" : count === 1 ? "Read" : "None";
  return keysPage(
    modal(
      "Create new secret key",
      `<div class="relative">${PERMS.map((x) => `<div class="perm"><span>${x}</span><span class="sel" ${x === "Tunnels" ? 'id="tunnels"' : ""}>${x === "Tunnels" ? value : "None"} ⌄</span></div>`).join("")}
      ${menu ? `<div class="menu" style="top:262px;right:0;width:150px"><div id="readperm">${count >= 1 ? "✓ " : ""}Read</div><div id="useperm">${count === 2 ? "✓ " : ""}Use</div></div>` : ""}</div><div class="count">${count} selected permission${count === 1 ? "" : "s"}</div>`,
      btn("Cancel") +
        (count === 2 && !menu
          ? pri("Create secret key", "createkey")
          : off("Create secret key")),
    ),
  );
};
const keySave = (copied) =>
  keysPage(
    modal(
      "Save your key",
      `<p>Please save your secret key in a safe place since you won’t be able to view it again. Keep it secure, as anyone with your API key can make requests on your behalf.</p>
     <div class="copy"><span class="mono">DEMO_KEY_NOT_VALID</span>${btn(copied ? "Copied" : "Copy", "copy")}</div><div class="fd" style="margin-top:10px"><label>Permissions</label><small>Tunnels: Read + Use only</small></div>`,
      pri("Done", "done"),
      "short",
    ),
  );
const key = [
  {
    n: 1,
    cap: "Open API keys and choose Create new secret key",
    target: "newkey",
    s: () => keysPage("", "newkey"),
  },
  {
    n: 2,
    cap: "Name the key so you can recognize this Farol connection",
    target: "keyname",
    s: () => keyFirst(""),
  },
  {
    n: 2,
    cap: "Name the key so you can recognize this Farol connection",
    hold: 0.9,
    s: (p) => keyFirst(typing("Farol Demo", p)),
  },
  {
    n: 3,
    cap: "Choose a project and expiration, then choose Restricted",
    hold: 2,
    target: "restricted",
    s: () => keyFirst("Farol Demo"),
  },
  {
    n: 4,
    cap: "Scroll to Tunnels. Keep unrelated permissions at None",
    target: "tunnels",
    s: () => keyPerms(0),
  },
  {
    n: 5,
    cap: "Under Tunnels, select Read",
    target: "readperm",
    s: () => keyPerms(0, true),
  },
  {
    n: 5,
    cap: "Also select Use. These are two separate permissions",
    target: "useperm",
    s: () => keyPerms(1, true),
  },
  {
    n: 6,
    cap: "All selected here means Read and Use for Tunnels only",
    hold: 2,
    s: () => keyPerms(2, true),
  },
  {
    n: 6,
    cap: "Review the key settings, then choose Create secret key",
    target: "createkey",
    s: () => keyPerms(2),
  },
  {
    n: 7,
    cap: "In Save your key, choose Copy. The real secret is shown only once",
    target: "copy",
    s: () => keySave(false),
  },
  {
    n: 8,
    cap: "Keep the real key private, then choose Done",
    target: "done",
    s: () => keySave(true),
  },
  {
    n: 9,
    cap: "Return to Farol. The tunnel ID is filled; paste the key next",
    hold: 2,
    s: () => connectForm({ id: TUNNEL }),
  },
];

const DOTS = "••••••••••••••••";
const connect = [
  {
    n: 1,
    cap: "Return to Farol with your copied key",
    hold: 1.2,
    s: () => connectForm({ id: TUNNEL }),
  },
  {
    n: 2,
    cap: "Paste the key into Key. The value stays masked",
    target: "key",
    s: () => connectForm({ id: TUNNEL }),
  },
  {
    n: 3,
    cap: "Choose Connect once",
    target: "connect",
    s: () => connectForm({ id: TUNNEL, key: DOTS, action: "on" }),
  },
  {
    n: 4,
    cap: "Wait for the connection check. Do not repeat a pending action",
    hold: 2,
    s: () =>
      connectForm({
        id: TUNNEL,
        key: DOTS,
        action: "busy",
        status: wait("Checking…"),
      }),
  },
  {
    n: 5,
    cap: "Wait for Connected to this Mac, then continue",
    target: "continue",
    s: () =>
      connectForm({
        id: TUNNEL,
        key: DOTS,
        action: "done",
        cont: true,
        saved: true,
        connected: true,
        status: ok("Connected to this Mac"),
      }),
  },
];

/* ---- ChatGPT plugins ---- */
const pluginWin = (url, nav, main, overlay = "") =>
  `<div class="window g"><div class="bar url">${lights}<span class="addr">${url}</span></div><div class="site"><div class="sn">${nav}</div><div class="sm">${main}</div>${overlay ? `<div class="shade"></div>${overlay}` : ""}</div></div>`;
const customize = (installed) =>
  `<h4>Customize</h4><div class="on">Plugins</div><div>Skills</div><div class="label">Installed</div>${installed ? "<div>Farol</div>" : ""}`;
const INTRO = `<p>Connect plugins to let ChatGPT work across your tools</p>`;
const pluginHead = (menu, extra = "") =>
  `<div class="pagehead"><h2>Plugins</h2><div class="headtools">${extra}${btn("Add ⌄", "add", "p")}${menu ? `<div class="menu" style="top:36px;right:0;width:200px"><div>Create plugin</div><div>Upload plugin archive</div><div id="custom">Add custom MCP server</div></div>` : ""}</div></div>`;
const pluginHome = (menu = false, overlay = "") =>
  pluginWin(
    "chatgpt.com/plugins",
    customize(false),
    `${pluginHead(menu)}${INTRO}<div class="tabs"><span>Public</span><b>Personal</b></div><h3>Created by you</h3>`,
    overlay,
  );
const mcpForm = ({
  name = "",
  tunnel = false,
  id = false,
  auth = false,
  menu = false,
  checked = false,
} = {}) =>
  pluginHome(
    false,
    modal(
      "Add custom MCP server",
      `<div class="iconline"><b>+</b><span>Icon (optional)<br><span class="small">PNG only. Best results at 256 x 256 px or larger. Max file size: 10 KB</span></span></div>` +
        field("Name", name || "Custom Tool", { id: "pname", empty: !name }) +
        field("Description (optional)", "Explain what it does in a few words", {
          empty: true,
        }) +
        `<div class="conn"><span>Connection</span><div class="seg"><span class="${tunnel ? "" : "on"}">Server URL</span><span id="ptype" class="${tunnel ? "on" : ""}">Tunnel</span></div></div>` +
        `<div class="fd"><div class="in ${id ? "mono" : "empty"}" id="pid">${id ? TUNNEL : tunnel ? "tunnel_…" : "https://example.com/mcp"}</div></div>` +
        `<div class="relative">${field("Authentication", `${auth ? "No authentication" : "OAuth"} ⌄`, { id: "pauth" })}${menu ? `<div class="menu" style="top:54px;left:0;right:0"><div>OAuth</div><div id="noauth">No authentication</div><div>OAuth or no authentication</div></div>` : ""}</div>` +
        (auth
          ? `<div class="warnline">△ Custom MCP servers introduce risk. Learn more</div><div class="riskbox"><i id="risk" class="${checked ? "on" : ""}">${checked ? "✓" : ""}</i><span><strong>I understand and want to continue</strong>Only connect to MCP servers you trust. An untrusted server may access or steal information shared through app use, or trick ChatGPT into using tools in unintended ways.</span></div>`
          : `<div class="adv"><strong>Advanced OAuth settings ›</strong><br>Review discovered OAuth settings, or enter them manually.</div>`),
      auth
        ? btn("Cancel") +
            (checked
              ? pri("Create as a plugin", "createp")
              : off("Create as a plugin"))
        : "",
    ),
  );
const connectDialog = (pending) =>
  pluginHome(
    false,
    modal(
      "Connect Farol",
      `<p>ChatGPT may share relevant memories (if enabled) and chats with this app to support interactions with it. Farol’s use of this data is subject to their terms and privacy policy.</p>
     <p>If you have <strong>Suggested prompts</strong> enabled, data from this app may be used to proactively provide helpful information or suggestions.</p>
     <p>Information from this app may be used to improve our models if it is used to inform your conversations with ChatGPT and you have <strong>Improve the model for everyone</strong> enabled. You can disconnect Farol in settings to stop the access.</p>`,
      btn("Cancel") +
        (pending ? off("Connecting…") : pri("Connect Farol", "connectp")),
      "short",
    ),
  );
const catalog = ({ search = "", menu = false, toast = false } = {}) => {
  const box = `<div class="searchbox" id="psearch">⌕ ${search || "Search plugins"}</div>`;
  const body = search
    ? `<div class="pluginrow"><img class="appico" src="${ICON}"><div class="grow"><strong>Farol</strong>Demo user · Local workspace tools</div><div class="relative">${btn("···", "more")}${menu ? `<div class="menu" style="top:34px;right:0;width:130px"><div>Try now</div><div id="manage">Manage</div><div>Uninstall</div></div>` : ""}</div></div>`
    : `<div class="tabs"><b>Public</b><span>Personal</span></div><h3>Popular</h3>`;
  return (
    pluginWin(
      "chatgpt.com/plugins",
      customize(true),
      `${pluginHead(false, box)}${INTRO}${body}`,
      "",
    ) +
    (toast
      ? `<div class="toast" style="right:40px;top:104px">✓ Farol is now connected ×</div>`
      : "")
  );
};
const SETNAV = [
  "General",
  "Appearance",
  "Notifications",
  "Profile",
  "Security and login",
  "Account",
  "Archived chats",
  "Parental controls",
  "Voice",
  "Storage",
  "Personalization",
];
const settingsNav = `<h4>Settings</h4><div>⌕ Search</div><div class="label">Personal</div>${SETNAV.map((x) => `<div>${x}</div>`).join("")}`;
const pluginSettings = () =>
  pluginWin(
    "chatgpt.com/settings/plugins-settings",
    settingsNav,
    `<div class="crumbs">Plugin settings › Farol</div>
    <div class="pluginrow"><img class="appico" src="${ICON}"><div class="grow"><strong>Farol</strong>Local workspace tools</div></div>
    <div class="permrow2" id="permission"><div><strong>Permission</strong><span>Choose when ChatGPT should ask for permission when using this plugin</span></div><div>Allow low-risk ›</div></div>
    <h3>About</h3><div class="about">${[
      ["Connected on", "Nov 6, 2026"],
      ["Developer", "Demo user"],
      ["Version", "dev mode"],
      ["Authorization supported", "None"],
      ["Authorization used", "None"],
      ["Review status", "DEVELOPMENT"],
    ]
      .map(([a, b]) => `<div><span>${a}</span>${b}</div>`)
      .join("")}</div>`,
  );
const CHOICES = [
  ["Always ask", "Ask before reading or making changes"],
  [
    "Allow read-only tools",
    "Read without asking, but ask before making changes",
  ],
  [
    "Allow low-risk tools",
    "Automatically approve low-risk tools, but sensitive tools may be denied",
    "Default",
  ],
  [
    "Allow all tools",
    "Use tools without asking. This comes with elevated risk",
    "Elevated risk",
  ],
];
const permissions = () =>
  pluginWin(
    "chatgpt.com/settings/plugins-settings",
    settingsNav,
    `<div class="crumbs">Plugin settings › Farol › Permissions</div><h2>Permissions</h2><p>Choose when ChatGPT needs your approval to use tools</p>
    <div class="choices">${CHOICES.map(([a, b, tag]) => `<div class="${tag === "Default" ? "on" : ""}"><i></i><span><strong>${a}</strong>${tag ? `<em>${tag}</em>` : ""}<br>${b}</span></div>`).join("")}</div>`,
  );
const FORM = { name: "Farol", tunnel: true, id: true };
const plugin = [
  {
    n: 1,
    cap: "Once Farol shows Connected, open ChatGPT’s Plugins and choose Add",
    target: "add",
    s: () => pluginHome(),
  },
  {
    n: 2,
    cap: "Choose Add custom MCP server",
    target: "custom",
    s: () => pluginHome(true),
  },
  {
    n: 3,
    cap: "Use Farol, or the exact app name shown in your Farol setup",
    target: "pname",
    s: () => mcpForm(),
  },
  {
    n: 4,
    cap: "Choose Tunnel as the connection type",
    target: "ptype",
    s: () => mcpForm({ name: "Farol" }),
  },
  {
    n: 5,
    cap: "Paste the same tunnel ID you entered in Farol",
    target: "pid",
    s: () => mcpForm({ name: "Farol", tunnel: true }),
  },
  { n: 6, cap: "Open Authentication", target: "pauth", s: () => mcpForm(FORM) },
  {
    n: 6,
    cap: "Choose No authentication. Your ChatGPT account stays signed in",
    target: "noauth",
    s: () => mcpForm({ ...FORM, menu: true }),
  },
  {
    n: 7,
    cap: "Read the risk warning. Continue only if you trust this connection",
    hold: 2.4,
    target: "risk",
    s: () => mcpForm({ ...FORM, auth: true }),
  },
  {
    n: 8,
    cap: "After reviewing the details, choose Create as a plugin",
    target: "createp",
    s: () => mcpForm({ ...FORM, auth: true, checked: true }),
  },
  {
    n: 9,
    cap: "Read the data-sharing notice. Choose Connect Farol only if you want to proceed",
    hold: 3,
    target: "connectp",
    s: () => connectDialog(false),
  },
  {
    n: 9,
    cap: "Wait for the original connection to finish. Do not submit it again",
    hold: 1.3,
    s: () => connectDialog(true),
  },
  {
    n: 10,
    cap: "After Farol is connected, find it using Search plugins",
    target: "psearch",
    s: () => catalog({ toast: true }),
  },
  {
    n: 11,
    cap: "Find your plugin and open its three-dot menu",
    target: "more",
    s: () => catalog({ search: "Farol" }),
  },
  {
    n: 12,
    cap: "Choose Manage to review this plugin’s settings",
    target: "manage",
    s: () => catalog({ search: "Farol", menu: true }),
  },
  {
    n: 13,
    cap: "Open Permission to review when ChatGPT should ask you",
    target: "permission",
    s: () => pluginSettings(),
  },
  {
    n: 14,
    cap: "Recommended: keep the default, Allow low-risk tools",
    hold: 3.2,
    s: () => permissions(),
  },
  {
    n: 14,
    cap: "Allow all tools has Elevated risk. It is optional",
    hold: 2.2,
    s: () => permissions(),
  },
  {
    n: 15,
    cap: "Return to Farol and run the connection test once",
    hold: 1.6,
    s: () => testForm("", pri("Test in ChatGPT", "test")),
  },
];

/* ---- Test ---- */
const testForm = (status, action) =>
  setup(
    "Add to ChatGPT",
    3,
    `<h2>4. Add Farol to ChatGPT</h2><p>Create the app in ChatGPT with your tunnel, then test it end to end.</p>
    <div class="facts"><div><span>Name</span>Farol</div><div><span>Connection</span><b class="mono">Tunnel · ${TUNNEL}</b></div><div><span>App authentication</span>No additional sign-in</div></div>
    <h3 style="margin-top:12px">2. Check the connection</h3><p>Farol opens a separate chat, selects Instant and sends one test message to your app. The reply confirms that ChatGPT can reach this Mac, without reading file contents.</p>${status}<div class="gap">${action}</div>`,
    true,
  );
const testChat = (status) =>
  chatTab(
    `<div class="card wide"><h3>Farol checks the connection</h3><ul><li>Opens a separate ordinary chat</li><li>Selects Instant and your Farol plugin</li><li>Sends one test message</li><li>Waits for confirmation from this Mac</li></ul>${status}</div>`,
    true,
    "Connection check",
  );
const test = [
  {
    n: 1,
    cap: "Review the details, then choose Test in ChatGPT once",
    target: "test",
    s: () => testForm("", pri("Test in ChatGPT", "test")),
  },
  {
    n: 2,
    cap: "Farol prepares one separate Instant chat for the test",
    hold: 1,
    s: () => testForm(wait("Preparing the test…"), off("Test in ChatGPT")),
  },
  {
    n: 2,
    cap: "Wait for the original result. Do not start another test",
    hold: 2,
    s: () => testChat(wait("Testing…")),
  },
  {
    n: 3,
    cap: "Return to Setup after the connection check finishes",
    target: "return",
    s: () => testChat(ok("Connection check finished")),
  },
  {
    n: 4,
    cap: "Everything works confirms access. Choose Start using Farol",
    target: "finish",
    s: () =>
      testForm(
        `${ok("Everything works")}<p>Farol reached this Mac and verified access to the approved workspace. No file contents were read.</p>`,
        pri("Start using Farol", "finish"),
      ),
  },
  {
    n: 5,
    cap: "Setup is complete. Use Farol in your normal ChatGPT workflow",
    hold: 2.8,
    s: () =>
      farol(
        "Home / Ready",
        `<h2>Ready to use Farol</h2><p>Ask ChatGPT to work only with the folders and permissions you approved.</p><div class="in mono">Try: “List the files in my Farol Demo workspace.”</div><p class="gap">Start with non-sensitive sample files. Review any requested changes.</p>`,
        { side: "Home", connected: true },
      ),
  },
];

/* ---- Everyday: narrow or remove access ---- */
const narrowMenu = `<div class="menu" style="top:26px;left:50px"><div id="ro">Read only</div><div>✓ Read &amp; write</div></div>`;
const manage = [
  {
    n: 1,
    cap: "Task done? Open the workspace's Access",
    target: "access",
    s: () => wsPage(wsRow({ access: RW, state: ok("Works") }), true),
  },
  {
    n: 2,
    cap: "Choose Read only to stop further edits",
    target: "ro",
    s: () =>
      wsPage(wsRow({ access: RW, state: ok("Works"), menu: narrowMenu }), true),
  },
  {
    n: 3,
    cap: "Wait for the saved access check",
    hold: 1.5,
    s: () =>
      wsPage(wsRow({ state: wait("Checking workspace…") }), false, false),
  },
  {
    n: 4,
    cap: "No longer needed? Choose Remove",
    target: "remove",
    s: () => wsPage(wsRow({ state: ok("Works") }), true),
  },
  {
    n: 5,
    cap: "The grant is gone. Your files stay on disk",
    hold: 2.6,
    s: () => wsPage(EMPTY),
  },
];

/* ---- Updates ---- */
const settings = (body) =>
  farol("Settings / General", body, { side: "Settings", connected: true });
const updateCard = (status, action) =>
  settings(
    `<h2>Updates</h2><div class="facts"><div><span>Installed version</span>0.5.18</div>${status}</div><div class="gap">${action}</div>`,
  );
const OFFER = `<div><span>Update available</span>0.5.19</div>`;
const updates = [
  {
    n: 1,
    cap: "Open Settings → General → Check for updates",
    target: "check",
    s: () => updateCard("", pri("Check for updates", "check")),
  },
  {
    n: 2,
    cap: "Review the offered version, then choose Download Update",
    target: "download",
    s: () => updateCard(OFFER, pri("Download Update", "download")),
  },
  {
    n: 3,
    cap: "Wait for the download and its verification",
    hold: 2,
    s: () => updateCard(OFFER, wait("Downloading update…")),
  },
  {
    n: 4,
    cap: "Finish active work, then choose Install and Relaunch once",
    target: "install",
    s: () => updateCard(OFFER, pri("Install and Relaunch", "install")),
  },
  {
    n: 5,
    cap: "After relaunch, check the version and connection",
    hold: 2.6,
    s: () =>
      settings(
        `<h2>Updates</h2><div class="facts"><div><span>Installed version</span>0.5.19</div></div>${ok("Connected to this Mac")}`,
      ),
  },
];

window.FLOWS = {
  signin,
  workspace,
  access,
  tunnel,
  key,
  connect,
  plugin,
  test,
  manage,
  updates,
};
