# External setup links

Use [Getting started](getting-started.md) for the connection sequence. Farol's
sidebar Setup displays the exact external instructions owned by
[resources/setup-media.json](../resources/setup-media.json) and
[src/ui/setup-media.ts](../src/ui/setup-media.ts).

| Page                                                                              | Used for                                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [Organization tunnels](https://platform.openai.com/settings/organization/tunnels) | Create the Secure MCP Tunnel for the intended ChatGPT workspace and the restricted runtime key |
| [ChatGPT apps/connectors](https://chatgpt.com/plugins)                            | Attach the tunnel from the intended ChatGPT workspace with its supported Developer mode        |

The key's in-app instructions specify **Tunnels Read and Use**. Farol does not
create the external tunnel, issue a key, or attach an app on your behalf. Save the
exact selected app name for that tunnel/generation and perform the explicit
attachment check.

These URLs are the product's bundled setup destinations. Account/workspace
availability and external UI changes still need current verification; a passing
setup-media test checks the bundled text/URL contract, not access to those pages.
No credentials or cookies are bundled with the instructions.

---

[Documentation index](README.md) · [Project overview](../README.md)
