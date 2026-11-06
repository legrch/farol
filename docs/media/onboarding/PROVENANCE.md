# Verification record

Checked on 6 November 2026. The record documents how the tutorial was prepared, not a live setup success.

## Farol source

Repository: https://github.com/legrch/farol

- `src/ui/renderer/settings.tsx`, blob `0d31a9630e23edb1e62eb22f318aa3e35a45de75`: sign-in checks, workspace `access: "read"`, optional write/commands access, connection fields, attachment test and success states.
- `src/ui/renderer/shell.tsx`, blob `4e0acf3ef93b6f6dbb9351105568274f9d19a761`: Farol shell and Back to setup control.
- `src/ui/renderer/setup-gate.ts`, blob `bbe12899ec6c87cd314a02732d81180e3bf6f986`: step readiness text.
- `apps/desktop/renderer/setup-walkthrough.tsx`, blob `fce531a45a1dd570a94968d2eb93c0458cd08eb5`: tunnel/key/attachment walkthrough. Current externally verified Plugins labels are used where the older guide names Connectors.

## External forms

- https://platform.openai.com/settings/organization/tunnels : required Name and Description; Organizations and ChatGPT workspaces; optional Restrict client network access; Create.
- https://platform.openai.com/settings/organization/api-keys : Create new secret key form; Owned by; optional Name; Project; Expiration; Permissions Restricted; Tunnels Read and Use.
- https://chatgpt.com/plugins : Add → Add custom MCP server; Name; Connection Tunnel; Tunnel ID; Authentication No authentication; risk confirmation; Create as a plugin.

Creation controls were not submitted. Form drafts were closed. Current project/expiration option menus were not verified. The reference shows an older Default project choice and no Expiration field, so it does not establish current expiration options. Post-creation screens were not exercised in a live account. No account-specific screenshot or source response is redistributed.

## Supplied reference review

All 42 user-supplied captures were visually reviewed. Their October 2026 capture names indicate an older UI than the forms inspected on 6 November. No original pixels, private identifiers, names, email addresses, or credentials are included in this package.

Applied corrections:

- A selected ChatGPT workspace can appear as an ID rather than a friendly name. The demo uses an unmistakably synthetic UUID.
- After tunnel creation, copy its ID from the Tunnels table row. The recreated table contains only invented values.
- The key result is a Save your key dialog with Copy and Done. The secret is shown once; the demo uses DEMO_KEY_NOT_VALID. The restricted-permission summary is illustrative because the supplied reference used a full-access key.
- Paste the copied tunnel ID into Farol before creating/copying the key. This avoids losing the ID when the clipboard is replaced.
- Wait for Connected in Farol before creating the ChatGPT plugin.

Not adopted from the older reference:

- Full-key All permissions and ChatGPT Allow all tools. Neither is needed for this tutorial.
- Older Create MCP App / Create labels, or developer-mode changes. A separate Connect step is now established by current post-creation screenshots. Use the currently verified form labels and normal confirmations.
- Account-specific workspace/project options, account data, or any actual key.

## Presentation revision

The complete eight-part series was rebuilt in a unified light theme at the user’s request. Only styling changed; the corrected reference-based workflow, synthetic values, restricted permissions, and documented verification limits remain intact. No source screenshot pixels were recolored or reused.

## Current MCP form follow-up

Two additional user-supplied screenshots from 6 November confirm the Add menu and Add custom MCP server form labels. The plugin animation now also includes the initial Advanced OAuth settings panel, the form’s additional-content indicator, and the current blue Add control. Farol uses Tunnel and No authentication; the OAuth-only options are not configured. No real MCP server, credential, or plugin was created during this follow-up. The screenshots themselves are not redistributed.

## Current post-creation flow

Ten additional current screenshots were checked on 6 November. They establish a separate Connect dialog after Create as a plugin, a connected status, plugin search, the three-dot menu → Manage path, and Permission → Permissions. This replaces the earlier illustrative Install step. The data-sharing notice is recreated with the synthetic Farol name. Plugin metadata is invented and app/version identifiers are omitted.

The permission screen shows Always ask, Allow read-only tools, Allow low-risk tools (Default), and Allow all tools (Elevated risk). The animation leaves the default selected and makes no permission-changing click. Choosing a different level belongs to the owner; Allow all tools is not a setup requirement. No real credential, server, plugin, connection, or permission was created or changed while producing these assets.
