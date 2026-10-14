# Contribute a scoped change

Read [AGENTS.md](../../AGENTS.md) and the relevant owning contract before editing. Use [source setup](setup.md) for the declared toolchains. Distinguish accepted source, proposed design, fixture evidence and installed behavior.

Keep changes within the selected task and preserve unrelated work. Use English for source, UI, errors and implementation documentation. New desktop source belongs under `apps/desktop/`; existing TypeScript remains under `src/` until its owned capability switches. Architecture and boundary rules live in [the technical references](../reference/README.md).

Run representative targeted checks and inspect the complete owned diff before a coherent checkpoint commit. Use an English Conventional Commit without assistant or vendor attribution. For documentation work, run the [documentation checks](../tools/README.md) and review current labels, commands and capability claims against their owning source.

A stable integration range needs the applicable `task ci:fast`, aggregate and risk-based review gates. Package candidates use `task package` from clean committed bytes. Source checks do not prove a package, an installed journey or live-provider use. [Testing](../testing.md) defines those evidence limits.

Report the concrete change, exact source identity, checks performed and remaining risks. The selected task and Lead own review/integration boundaries. A review or local commit is not permission to install, activate or publish a release.

[Development](README.md) · [Documentation](../README.md)
