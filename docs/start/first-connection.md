# Connect ChatGPT to Farol

Use Setup to connect the ChatGPT workspace you intend to use and approve a folder.
At the end, check the local connection receipt before asking ChatGPT to read files.

## Before you begin

[Open Farol](installation.md). Have a supported ChatGPT account/workspace and a
small folder you can share. If you want a disposable exercise, prepare the folder
in [your first workspace](first-workspace.md#prepare-a-small-folder).

The connection depends on your actual ChatGPT account and external setup pages.
The beta's complete live journey remains incompletely qualified; consult
[current status](../reference/status.md) if a prerequisite is unavailable.

## Connect ChatGPT

1. Open sidebar **Setup**.
2. In **Sign in**, sign in if you want embedded ChatGPT in Browser. You can skip
   embedded login when you only want Computer access from external ChatGPT.
3. In **Folders**, choose your folder with the native picker. Use **Read only**,
   review exclusions, and check that folder on this build.
4. In **Connection**, follow the displayed instructions to create a Secure MCP
   Tunnel for your intended workspace and a Restricted runtime key with
   **Tunnels Read and Use**. Save the tunnel ID and key in the designated fields.
5. In **Add to ChatGPT**, attach the tunnel as a ChatGPT app and save its exact
   display name in Farol. Reuse the app attached to this tunnel.

**Check:** the saved folder has current access evidence and the connection uses
that tunnel and attached app. Skipping a setup step does not mark it verified.

Keep the runtime key in its designated private setting. Do not paste it into a
prompt, repository, or support message. The [setup link reference](../reference/setup-links.md)
explains which external pages the product opens.

## Verify the attachment

Choose one method deliberately:

- **Check inside Farol** opens a temporary Instant conversation. Farol checks the
  exact app selection and sends one verification message.
- **Check manually in external ChatGPT** displays the unused challenge. You send
  that challenge in the intended external conversation; Farol observes the local
  receipt and does not send it for you.

**Check:** Setup observes a matching local MCP receipt. A chip label, sign-in page,
or ordinary model reply alone does not establish attachment.

If a check is pending or its Send outcome is unknown, keep its original operation.
Do not retarget it or send it again. Follow
[connection troubleshooting](../guides/troubleshooting.md#the-connection-check-is-pending).

## Next

[Read your first workspace](first-workspace.md). Broader access can wait until you
have completed that read-only exercise.

---

[Start](README.md) · [Documentation](../README.md)
