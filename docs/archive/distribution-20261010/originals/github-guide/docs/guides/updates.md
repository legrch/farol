# Update Farol

Apply a verified owner-beta update to an accepted installation, then check the new
app's startup and connection separately.

## Before you begin

Use an installation in the fixed `$HOME/Applications/Farol.app` slot with an
accepted installation receipt. A plain copied ZIP can lack this baseline; see
[installation requirements](../start/installation.md#understand-this-installation).
Keep the previous accepted app and retain operation evidence if recovery is pending.

The [status matrix](../reference/status.md) records the current release and
installed-journey qualification limits.

## Apply an update

1. Choose **Check for Updates…**. Eligible installed builds also check at startup
   and every six hours.
2. Wait for **Ready**. Farol verifies the archive, extracted package, and durable
   staging before offering restart.
3. Choose **Later** to keep working, or close browser documents and settle current
   work before **Restart & Update**.
4. Choose **Restart & Update** once. Farol reserves work admission, drains its owned
   connector, and waits for the exact helper readiness acknowledgment before Quit.

**Check:** the replacement app starts and its update state describes the resulting
installation. The helper's relaunch request alone does not prove successful startup.

Saved folders, configuration, and browser state use the existing product profile.
Verify connection attachment explicitly if it is needed again. Updating does not
send an automatic ChatGPT verification message.

## If restart is blocked

Read the reason shown by Farol. Settle the identified browser document, task,
Computer operation, or recovery obligation, then inspect the existing update state.
An idle owned connector can be drained during explicit restart; it is not treated
as permission to stop an unrelated service or native task.

For an unavailable baseline, helper identity uncertainty, or changed staged bytes,
use [update troubleshooting](troubleshooting.md#updates-are-unavailable-or-blocked).
Preserve the receipt and journal instead of clearing them.

## Recover or restore

- A settled update can offer **Restart & Restore Previous Version**.
- A proven interrupted pair can offer **Restart & Finish Recovery** after the
  original helper has been observed ended.

Use the action offered for the existing exact operation. An unreadable journal,
unknown helper, or changed bundle keeps work blocked. Do not invent another
operation ID or repeat an unknown apply.

For implementation and evidence details, see the
[installed updater](../reference/updates/runtime.md) and
[helper contract](../reference/updates/helper.md). Older preview-slot migration
uses the separate [maintenance procedure](../maintenance/preview-cutover.md).

---

[Practical guides](README.md) · [Documentation](../README.md)
