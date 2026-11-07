/* Step-by-step setup flows, drawn in the same style as the stories. All values are synthetic.
   The window never moves or zooms: each screen shows only what the step needs, at reading size. */
const TUNNEL = "tunnel_00000000000000000000000000000001";
const WS = "00000000-0000-0000-0000-000000000001";
const PATH = "/Users/demo/Documents/Farol Demo";

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
const STEPS = ["Sign in", "Workspaces", "Connect this Mac", "Add to ChatGPT"];
const progress = (done) =>
  `<div class="prog">${STEPS.map((s, i) => (i < done ? `<span class="done">✓ ${s}</span>` : i === done ? `<b>${i + 1} ${s}</b>` : `<span>${i + 1} ${s}</span>`)).join("")}</div>`;
const shell = (
  crumb,
  body,
  side = "Setup",
  items = ["Home", "ChatGPT", "Activity", "Setup"],
) =>
  `<div class="window g"><div class="bar"><span class="lights"><i></i><i></i><i></i></span>${crumb.split(" / ")[0]}<span class="crumb">${crumb.includes(" / ") ? "/ " + crumb.split(" / ")[1] : ""}</span></div>
   <div class="side">${items.map((x) => `<div class="${x === side ? "on" : ""}">${x}</div>`).join("")}</div>
   <div class="content">${body}</div></div>`;
const setup = (page, done, body) =>
  shell(`Setup / ${page}`, progress(done) + body);
const foot = (cont = false) =>
  `<div class="foot">${btn("Back")}${cont ? pri("Continue", "continue") : off("Continue")}</div>`;
const web = (url, body) =>
  `<div class="window g"><div class="bar url"><span class="lights"><i></i><i></i><i></i></span><span class="addr">${url}</span></div><div class="page">${body}</div></div>`;
const modal = (title, body, actions) =>
  `<div class="modal"><div class="mh">${title}<span>×</span></div><div class="mb">${body}</div>${actions ? `<div class="foot">${actions}</div>` : ""}</div>`;
const typing = (text, p) =>
  text.slice(0, Math.round(text.length * Math.min(1, p * 1.3)));

/* ---- Sign in ---- */
const signPage = (status, cont = false) =>
  setup(
    "Sign in",
    0,
    `<h2>Sign in to ChatGPT</h2><p>Use your own ChatGPT account. Farol checks sign-in before you continue.</p>${status}${foot(cont)}`,
  );
const chatTop = (body) =>
  web(
    "chatgpt.com",
    `<div class="back-link" id="return">← Back to setup</div><div class="center">${body}</div>`,
  );
const signin = [
  {
    n: 1,
    cap: "Open Setup and choose Start setup",
    target: "start",
    s: () =>
      shell(
        "Setup / Overview",
        `<h2>Welcome to Farol</h2><p>Let ChatGPT work with workspaces on this Mac. Setup takes about five minutes, and every step checks itself.</p>
        <div class="list">${[
          ["Sign in", "Sign in with your ChatGPT account"],
          ["Workspaces", "Choose folders for ChatGPT"],
          ["Connect this Mac", "Connect this Mac with your tunnel"],
          ["Add to ChatGPT", "Add Farol and test the connection"],
        ]
          .map(
            ([a, b], i) =>
              `<div><em>${i + 1}</em><strong>${a}</strong><span>${b}</span></div>`,
          )
          .join("")}</div>${pri("Start setup", "start")}`,
      ),
  },
  {
    n: 2,
    cap: "Choose Sign in. Farol opens its ChatGPT tab",
    target: "signin",
    s: () =>
      signPage(
        `<p>Sign in to your ChatGPT account, then return here.</p>${pri("Sign in", "signin")}`,
      ),
  },
  {
    n: 3,
    cap: "Choose your usual sign-in method and your own account",
    target: "google",
    s: () =>
      chatTop(
        `<div class="card"><h3>Log in or sign up</h3>${btn("Continue with Google", "google", "wide")}${btn("Continue with Apple", "", "wide")}${btn("Continue with Microsoft", "", "wide")}</div>`,
      ),
  },
  {
    n: 4,
    cap: "After signing in, choose Back to setup",
    target: "return",
    s: () =>
      chatTop(
        `<h3>What can I help with?</h3><div class="ask">Ask anything</div><p>Signed in. Return to Setup to check your sign-in.</p>`,
      ),
  },
  {
    n: 5,
    cap: "Choose Check sign-in once",
    target: "check",
    s: () =>
      signPage(
        `<p>You’re signed in. Check sign-in to continue.</p>${pri("Check sign-in", "check")}`,
      ),
  },
  {
    n: 5,
    cap: "Wait for the confirmation",
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
const wsRow = ({
  access = "Read only",
  state = "",
  commands = false,
  id = "access",
  menu = "",
} = {}) =>
  `<div class="row"><div class="rt"><strong>Farol Demo</strong><span class="mono">${PATH}</span></div>
    <div class="rc"><label>Access</label><div class="sel" id="${id}">${access} ⌄</div>${menu}
    <label class="chk" id="commands"><i class="${commands ? "on" : ""}">${commands ? "✓" : ""}</i>Commands</label></div>
    <div class="rb">${state}<span class="link" id="remove">Remove Farol Demo</span></div></div>`;
const wsPage = (row, cont = false, add = true) =>
  setup(
    "Workspaces",
    1,
    `${wsHead}${row}${add ? `<div class="gap">${btn("+ Add workspace", "add")}</div>` : ""}${foot(cont)}`,
  );
const pickerRows = (selected) =>
  ["Documents", "Farol Demo", "Taxes", "Photos"]
    .map(
      (x) =>
        `<div class="${selected && x === "Farol Demo" ? "on" : ""}" ${x === "Farol Demo" ? 'id="folder"' : ""}>▸ ${x}</div>`,
    )
    .join("");
const picker = (selected) =>
  setup(
    "Workspaces",
    1,
    `${wsHead}<div class="sheet"><div class="sh">Choose a folder</div><div class="files">${pickerRows(selected)}</div><div class="foot">${btn("Cancel")}${selected ? pri("Open", "open") : off("Open")}</div></div>`,
  );
const workspace = [
  {
    n: 1,
    cap: "Choose + Add workspace",
    target: "add",
    s: () =>
      wsPage(`<div class="row none"><p>Add a workspace to continue.</p></div>`),
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

/* ---- Edits and commands ---- */
const accessMenu = `<div class="menu" style="top:24px;left:52px"><div>✓ Read only</div><div id="rw">Read &amp; write</div></div>`;
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
        wsRow({
          access: "Read &amp; write",
          state: wait("Checking workspace…"),
        }),
      ),
  },
  {
    n: 3,
    cap: "Wait for Works before using the new access",
    hold: 1.5,
    s: () =>
      wsPage(wsRow({ access: "Read &amp; write", state: ok("Works") }), true),
  },
  {
    n: 4,
    cap: "Enable Commands only if you need Git, tests or builds",
    target: "commands",
    s: () =>
      wsPage(wsRow({ access: "Read &amp; write", state: ok("Works") }), true),
  },
  {
    n: 4,
    cap: "Command access applies to all approved workspaces",
    hold: 1.8,
    s: () =>
      wsPage(
        wsRow({
          access: "Read &amp; write",
          commands: true,
          state: wait("Checking workspace…"),
        }),
      ),
  },
  {
    n: 5,
    cap: "Works confirms the check. ChatGPT still manages approvals",
    hold: 2.2,
    s: () =>
      wsPage(
        wsRow({
          access: "Read &amp; write",
          commands: true,
          state: ok("Works"),
        }),
        true,
      ),
  },
];

/* ---- Connect page ---- */
const connectForm = ({
  id = "",
  key = "",
  status = "",
  action = "off",
  cont = false,
  saved = false,
} = {}) =>
  setup(
    "Connect this Mac",
    2,
    `<h2>Connect this Mac</h2><p>You need two things from OpenAI: a tunnel ID and its key.</p>
    ${field("Tunnel ID", id, { id: "tunnelid", mono: true })}
    ${field("Key", key || "Paste your key", { id: "key", empty: !key, mono: !!key, hint: saved ? "Key saved on this Mac. Paste a new key only to replace it." : "Your key is saved privately on this Mac." })}
    <div class="gap">${action === "on" ? pri("Connect", "connect") : action === "busy" ? off("Connecting…") : action === "done" ? btn("Disconnect") : off("Connect")}${status}</div>${foot(cont)}`,
  );

/* ---- Tunnel ---- */
const tunnelPage = (body) =>
  web("platform.openai.com/settings/organization/tunnels", body);
const tunnelModal = ({
  name = "",
  desc = "",
  ws = "",
  menu = false,
  create = false,
} = {}) =>
  tunnelPage(
    modal(
      "Create tunnel",
      field("Name *", name || "e.g. West Coast MCP tunnel", {
        id: "name",
        empty: !name,
      }) +
        field(
          "Description *",
          desc || "Add a short description to help your team.",
          { id: "desc", empty: !desc },
        ) +
        field("Organizations", "Demo organization ⌄") +
        `<div class="relative">${field("ChatGPT workspaces", ws || "Search workspaces by name or ID ⌄", { id: "workspace", empty: !ws, mono: !!ws })}${menu ? `<div class="menu" style="top:50px;left:0;right:0"><div id="wsopt" class="mono">${WS}</div></div>` : ""}</div>`,
      btn("Cancel") + (create ? pri("Create", "create") : off("Create")),
    ),
  );
const DESC = "Connect my demo Mac to approved sample folders.";
const tunnelRow = (copied) =>
  tunnelPage(`<div class="pagehead"><h2>Tunnels</h2>${pri("Create tunnel")}</div>${ok("Tunnel created successfully.")}
    <div class="table"><div class="th"><span>Tunnel</span><span>ID</span></div><div class="tr"><span><strong>Farol Demo</strong><br>Demo Mac access</span><span class="mono">${TUNNEL}</span>${btn(copied ? "Copied" : "Copy", "copy")}</div></div>`);
const tunnel = [
  {
    n: 1,
    cap: "In Farol, choose Open OpenAI Tunnels",
    target: "open",
    s: () =>
      setup(
        "Connect this Mac",
        2,
        `<h2>Connect this Mac</h2><p>You need two things from OpenAI: a tunnel ID and its key.</p><div class="list"><div><em>1</em><strong>Create a tunnel</strong><span>On the Tunnels page</span></div><div><em>2</em><strong>Create a key</strong><span>Permission: Restricted</span></div><div><em>3</em><strong>Copy both here</strong><span>Tunnel ID and key</span></div></div>${pri("Open OpenAI Tunnels", "open")}`,
      ),
  },
  {
    n: 2,
    cap: "On the OpenAI Tunnels page, choose Create tunnel",
    target: "create",
    s: () =>
      tunnelPage(
        `<div class="pagehead"><h2>Tunnels</h2>${pri("Create tunnel", "create")}</div><div class="center"><h3>No tunnels yet</h3><p>Create your first tunnel to connect MCP servers behind a firewall.</p></div>`,
      ),
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
    cap: "Review the organization, then open ChatGPT workspaces",
    target: "workspace",
    s: () => tunnelModal({ name: "Farol Demo", desc: DESC }),
  },
  {
    n: 5,
    cap: "Choose your workspace. It may appear as an ID",
    target: "wsopt",
    s: () => tunnelModal({ name: "Farol Demo", desc: DESC, menu: true }),
  },
  {
    n: 6,
    cap: "Review your selection, then choose Create once",
    target: "create",
    s: () =>
      tunnelModal({ name: "Farol Demo", desc: DESC, ws: WS, create: true }),
  },
  {
    n: 7,
    cap: "Copy the complete tunnel ID from its row",
    target: "copy",
    s: () => tunnelRow(false),
  },
  {
    n: 7,
    cap: "Before copying a key, return to Farol and paste this ID",
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
    cap: "The tunnel ID is in Farol. Next, create the restricted key",
    hold: 1.8,
    s: () => connectForm({ id: TUNNEL }),
  },
];

/* ---- Restricted key ---- */
const keyPage = (body) =>
  web("platform.openai.com/settings/organization/api-keys", body);
const keyFirst = (name, perm = "") =>
  keyPage(
    modal(
      "Create new secret key",
      field("Name", name || "My Test Key", { id: "keyname", empty: !name }) +
        field("Project", "Your project ⌄", {
          hint: "Choose a project and expiration under your organization's policy.",
        }) +
        `<div class="fd"><label>Permissions</label><div class="seg"><span>All</span><span id="restricted" class="${perm === "r" ? "on" : ""}">Restricted</span><span>Read only</span></div></div>`,
      btn("Cancel") + off("Create secret key"),
    ),
  );
const permRow = (name, value, id = "") =>
  `<div class="perm"><span>${name}</span><span class="sel" ${id ? `id="${id}"` : ""}>${value} ⌄</span></div>`;
const keyPerms = (
  value,
  { menu = false, read = false, use = false, create = false } = {},
) =>
  keyPage(
    modal(
      "Create new secret key",
      `<div class="relative">${permRow("Files", "None")}${permRow("Batch", "None")}${permRow("Tunnels", value, "tunnels")}${permRow("Datasets", "None")}
      ${menu ? `<div class="menu" style="top:112px;right:0;width:150px"><div id="readperm">${read ? "✓ " : ""}Read</div><div id="useperm">${use ? "✓ " : ""}Use</div></div>` : ""}</div>`,
      btn("Cancel") +
        (create
          ? pri("Create secret key", "createkey")
          : off("Create secret key")),
    ),
  );
const keySave = (copied) =>
  keyPage(
    modal(
      "Save your key",
      `<p>Please save your secret key in a safe place since you won’t be able to view it again.</p><div class="copy"><span class="mono">sk-demo-invalid-not-a-real-key</span>${btn(copied ? "Copied" : "Copy", "copy")}</div>`,
      copied ? pri("Done", "done") : off("Done"),
    ),
  );
const key = [
  {
    n: 1,
    cap: "Open API keys and choose Create new secret key",
    target: "newkey",
    s: () =>
      keyPage(
        `<div class="pagehead"><h2>API keys</h2>${pri("+ Create new secret key", "newkey")}</div><div class="center"><p>Create an API key to access the OpenAI API.</p></div>`,
      ),
  },
  {
    n: 2,
    cap: "Name the key so you can recognize this connection",
    target: "keyname",
    s: () => keyFirst(""),
  },
  {
    n: 2,
    cap: "Name the key so you can recognize this connection",
    hold: 0.9,
    s: (p) => keyFirst(typing("Farol Demo", p)),
  },
  {
    n: 3,
    cap: "With project and expiry set, choose Restricted",
    target: "restricted",
    s: () => keyFirst("Farol Demo"),
  },
  {
    n: 4,
    cap: "Under Tunnels, open the selector. Leave the rest at None",
    target: "tunnels",
    s: () => keyPerms("None"),
  },
  {
    n: 5,
    cap: "Select Read",
    target: "readperm",
    s: () => keyPerms("None", { menu: true }),
  },
  {
    n: 5,
    cap: "Also select Use. They are two separate permissions",
    target: "useperm",
    s: () => keyPerms("Read", { menu: true, read: true }),
  },
  {
    n: 6,
    cap: "All selected here means Read and Use for Tunnels only",
    hold: 2,
    s: () => keyPerms("All selected", { create: true }),
  },
  {
    n: 6,
    cap: "Review the settings, then choose Create secret key",
    target: "createkey",
    s: () => keyPerms("All selected", { create: true }),
  },
  {
    n: 7,
    cap: "Choose Copy. The real secret is shown only once",
    target: "copy",
    s: () => keySave(false),
  },
  {
    n: 8,
    cap: "Keep the key private, then choose Done",
    target: "done",
    s: () => keySave(true),
  },
  {
    n: 9,
    cap: "Return to Farol. Paste the key only into its Key field",
    hold: 2,
    s: () => connectForm({ id: TUNNEL }),
  },
];

/* ---- Connect ---- */
const DOTS = "••••••••••••••••";
const connect = [
  {
    n: 1,
    cap: "Paste the key into Key. The value stays masked",
    target: "key",
    s: () => connectForm({ id: TUNNEL }),
  },
  {
    n: 2,
    cap: "Choose Connect once",
    target: "connect",
    s: () => connectForm({ id: TUNNEL, key: DOTS, action: "on" }),
  },
  {
    n: 3,
    cap: "Wait for the check. Do not repeat a pending action",
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
    n: 4,
    cap: "Continue once it says Connected to this Mac",
    target: "continue",
    s: () =>
      connectForm({
        id: TUNNEL,
        key: DOTS,
        action: "done",
        cont: true,
        saved: true,
        status: ok("Connected to this Mac"),
      }),
  },
];

/* ---- Add to ChatGPT ---- */
const plugins = (body) => web("chatgpt.com/plugins", body);
const pluginHead = (menu = false) =>
  `<div class="pagehead"><h2>Plugins</h2><div class="relative">${btn("Add ⌄", "add")}${menu ? `<div class="menu" style="top:34px;right:0;width:190px"><div>Create plugin</div><div>Upload plugin archive</div><div id="custom">Add custom MCP server</div></div>` : ""}</div></div>`;
const mcpForm = ({
  name = "Custom Tool",
  tunnel = false,
  id = "",
  auth = "OAuth",
  risk = false,
  checked = false,
  create = false,
} = {}) =>
  plugins(
    modal(
      "Add custom MCP server",
      field("Name", name, { id: "pname" }) +
        `<div class="fd"><label>Connection</label><div class="seg"><span class="${tunnel ? "" : "on"}">Server URL</span><span id="ptype" class="${tunnel ? "on" : ""}">Tunnel</span></div></div>` +
        field(
          tunnel ? "Tunnel ID" : "URL",
          tunnel ? id || "tunnel_…" : "https://example.com/mcp",
          { id: "pid", mono: tunnel, empty: tunnel && !id },
        ) +
        field("Authentication", `${auth} ⌄`, { id: "pauth" }) +
        (risk
          ? `<label class="chk risk" id="risk"><i class="${checked ? "on" : ""}">${checked ? "✓" : ""}</i>I understand and want to continue. Custom MCP servers introduce risk.</label>`
          : ""),
      btn("Cancel") +
        (create
          ? pri("Create as a plugin", "createp")
          : off("Create as a plugin")),
    ),
  );
const permissions = () =>
  web(
    "chatgpt.com/settings/plugins-settings",
    `<div class="pagehead"><h2>Permissions</h2></div><p>Choose when ChatGPT needs your approval to use tools.</p><div class="choices">${[
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
    ]
      .map(
        ([a, b, tag]) =>
          `<div class="${tag === "Default" ? "on" : ""}"><i></i><span><strong>${a}</strong>${tag ? `<em>${tag}</em>` : ""}<br>${b}</span></div>`,
      )
      .join("")}</div>`,
  );
const FULL = { name: "Farol", tunnel: true, id: TUNNEL };
const pluginRow = (menu) =>
  plugins(
    `${pluginHead()}<div class="in search">⌕ Farol</div><div class="table"><div class="tr"><span><strong>Farol</strong><br>Demo user · Local workspace tools</span><span></span><div class="relative">${btn("···", "more")}${menu ? `<div class="menu" style="top:34px;right:0;width:120px"><div>Try now</div><div id="manage">Manage</div><div>Uninstall</div></div>` : ""}</div></div></div>`,
  );
const plugin = [
  {
    n: 1,
    cap: "Open ChatGPT’s Plugins and choose Add",
    target: "add",
    s: () =>
      plugins(
        `${pluginHead()}<p>Connect plugins to let ChatGPT work across your tools.</p>`,
      ),
  },
  {
    n: 2,
    cap: "Choose Add custom MCP server",
    target: "custom",
    s: () =>
      plugins(
        `${pluginHead(true)}<p>Connect plugins to let ChatGPT work across your tools.</p>`,
      ),
  },
  {
    n: 3,
    cap: "Use the exact app name shown in Farol",
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
  {
    n: 6,
    cap: "Open Authentication and choose No authentication",
    target: "pauth",
    s: () => mcpForm(FULL),
  },
  {
    n: 7,
    cap: "Read the risk warning. Continue only if you trust this connection",
    target: "risk",
    s: () => mcpForm({ ...FULL, auth: "No authentication", risk: true }),
  },
  {
    n: 8,
    cap: "After reviewing the details, choose Create as a plugin",
    target: "createp",
    s: () =>
      mcpForm({
        ...FULL,
        auth: "No authentication",
        risk: true,
        checked: true,
        create: true,
      }),
  },
  {
    n: 9,
    cap: "Read the data-sharing notice, then choose Connect once",
    target: "connectp",
    s: () =>
      plugins(
        modal(
          "Connect Farol",
          `<p>ChatGPT may share relevant memories (if enabled) and chats with this app to support interactions with it. Farol’s use of this data is subject to their terms and privacy policy.</p>`,
          btn("Cancel") + pri("Connect Farol", "connectp"),
        ),
      ),
  },
  {
    n: 10,
    cap: "Find your plugin and open its menu",
    target: "more",
    s: () => pluginRow(false),
  },
  {
    n: 11,
    cap: "Choose Manage, then open Permission",
    target: "manage",
    s: () => pluginRow(true),
  },
  {
    n: 12,
    cap: "Recommended: keep Allow low-risk tools (Default)",
    hold: 3.2,
    s: () => permissions(),
  },
  {
    n: 13,
    cap: "Return to Farol and run the connection test once",
    hold: 1.2,
    s: () => permissions(),
  },
];

/* ---- Test ---- */
const testForm = (status, action) =>
  setup(
    "Add to ChatGPT",
    3,
    `<h2>Add Farol to ChatGPT</h2><p>Create the app in ChatGPT with your tunnel, then test it end to end.</p>
    <div class="facts"><div><span>Name</span>Farol</div><div><span>Connection</span><b class="mono">Tunnel · ${TUNNEL}</b></div></div>${status}<div class="gap">${action}</div>`,
  );
const testChat = (status) =>
  web(
    "chatgpt.com",
    `<div class="back-link" id="return">← Back to setup</div><div class="card wide"><h3>Farol checks the connection</h3><ul><li>Opens a separate ordinary chat</li><li>Selects Instant and your Farol plugin</li><li>Sends one test message</li><li>Waits for confirmation from this Mac</li></ul>${status}</div>`,
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
    cap: "Wait for the original result. Do not start another test",
    hold: 2.2,
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
        `${ok("Connected")}${ok("Everything works")}<p>Farol reached this Mac and verified access to the approved workspace. No file contents were read.</p>`,
        pri("Start using Farol", "finish"),
      ),
  },
  {
    n: 5,
    cap: "Setup is complete. Use Farol in your normal ChatGPT workflow",
    hold: 2.8,
    s: () =>
      shell(
        "Home",
        `<h2>Ready to use Farol</h2><p>Ask ChatGPT to work only with the folders and permissions you approved.</p><div class="in mono">Try: “List the files in my Farol Demo workspace.”</div><p class="gap">Start with non-sensitive sample files. Review any requested changes.</p>`,
        "Home",
      ),
  },
];

/* ---- Everyday: narrow or remove access ---- */
const narrowMenu = `<div class="menu" style="top:24px;left:52px"><div id="ro">Read only</div><div>✓ Read &amp; write</div></div>`;
const manage = [
  {
    n: 1,
    cap: "Task done? Open the workspace's Access",
    target: "access",
    s: () =>
      wsPage(wsRow({ access: "Read &amp; write", state: ok("Works") }), true),
  },
  {
    n: 2,
    cap: "Choose Read only to stop further edits",
    target: "ro",
    s: () =>
      wsPage(
        wsRow({
          access: "Read &amp; write",
          state: ok("Works"),
          menu: narrowMenu,
        }),
        true,
      ),
  },
  {
    n: 3,
    cap: "Wait for the saved access check",
    hold: 1.5,
    s: () => wsPage(wsRow({ state: wait("Checking workspace…") })),
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
    s: () =>
      wsPage(`<div class="row none"><p>Add a workspace to continue.</p></div>`),
  },
];

/* ---- Updates ---- */
const settings = (body) =>
  shell("Settings / General", body, "General", ["General"]);
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
    s: () => updateCard(OFFER, wait("Downloading and verifying…")),
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

/* ---- Timeline: hold, glide to the target, outline it, click. The frame itself never moves. ---- */
const MOVE = 0.55;
const AIM = 0.25;
const CLICK = 0.3;
const END = 2;
const READ = 1.1;
function compile(flow) {
  let at = 0;
  let from = [640, 380];
  const steps = flow.map((step) => {
    const hold = step.hold ?? READ;
    stage.innerHTML = step.s(1);
    let to = from;
    let box = null;
    if (step.target) {
      const target = document.getElementById(step.target);
      if (!target) throw new Error(`Missing target ${step.target}`);
      box = target.getBoundingClientRect();
      to = [box.left + box.width / 2, box.top + box.height / 2];
    }
    const length = hold + (step.target ? MOVE + AIM + CLICK : 0);
    const compiled = { ...step, at, hold, from, to, box, length };
    at += length;
    from = to;
    return compiled;
  });
  return { steps, seconds: at + END };
}
const compiled = {};
window.prepareGuides = () => {
  for (const [name, flow] of Object.entries(window.FLOWS))
    compiled[name] = compile(flow);
  stage.innerHTML = "";
  return Object.fromEntries(
    Object.entries(compiled).map(([k, v]) => [k, v.seconds]),
  );
};
window.drawGuide = (name, t) => {
  const { steps } = compiled[name];
  const step = steps.findLast((s) => s.at <= t) ?? steps[0];
  const local = t - step.at;
  const p = Math.min(1, local / step.hold);
  let [x, y] = step.from;
  let overlay = "";
  if (step.target && local > step.hold) {
    const move = ease(Math.min(1, (local - step.hold) / MOVE));
    x += (step.to[0] - x) * move;
    y += (step.to[1] - y) * move;
    if (local > step.hold + MOVE) {
      const b = step.box;
      overlay += `<div class="aim" style="left:${b.left - 4}px;top:${b.top - 4}px;width:${b.width + 8}px;height:${b.height + 8}px"></div>`;
    }
    if (local > step.hold + MOVE + AIM) {
      const r = 6 + 16 * ((local - step.hold - MOVE - AIM) / CLICK);
      overlay += `<div class="ripple" style="left:${x - r}px;top:${y - r}px;width:${2 * r}px;height:${2 * r}px"></div>`;
    }
  }
  const pointer = `<svg class="cursor" style="left:${x}px;top:${y}px" viewBox="0 0 14 20"><path d="M1 1v15l4-3.6 2.6 6 2.6-1.1-2.6-6H13z" fill="var(--text)" stroke="var(--bg)" stroke-width="1.2"/></svg>`;
  stage.innerHTML = step.s(p) + overlay + pointer + caption(step.n, step.cap);
};
