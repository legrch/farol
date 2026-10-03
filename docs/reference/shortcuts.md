# Keyboard shortcuts

These controls belong to the current TypeScript/Electron desktop. The matching
views and layout behavior are explained in [desktop design](../architecture/desktop-design.md).

| Control                             | Action                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| `Command+1` … `Command+4`           | Browser, Computer, Activity, Settings                   |
| `Control+Command+S`                 | Show/hide the sidebar; use an overlay at compact widths |
| `Command+K`                         | Quick switcher                                          |
| `Control+Tab` / `Control+Shift+Tab` | Next/previous conversation tab                          |
| `Command+Q`                         | Normal Quit and owned runtime drain                     |

Closing the last window leaves the app and utility runtime alive. A Dock action
or an exact same-build launch reopens one window. See
[profiles and lifetime](profiles.md#quit-and-state-retention).

Source ownership: [desktop main/menu](../../src/apps/desktop/main.ts) and
[shell](../../src/ui/shell.ts).

---

[Reference](README.md) · [Documentation](../README.md)
