import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "@babel/parser";
import { expect, it, vi } from "vitest";
import {
  InstalledUpdateCommandSchema,
  isRetiredInstalledUpdateCommand,
} from "../../src/modules/release/contract/installed-update";

// Actual host dispatcher with controlled ports. No Electron, helper, profile,
// journal mutation or installation is performed by this fixture.
const source = fs.readFileSync("src/apps/desktop/main.ts", "utf8");
const tree = parse(source, { sourceType: "module", plugins: ["typescript"] });
const declaration = tree.program.body.find(
  (node) =>
    node.type === "FunctionDeclaration" &&
    node.id?.name === "installedUpdateCommand",
);
if (!declaration || declaration.start === null || declaration.end === null)
  throw Error("UPDATE_DISPATCHER_MISSING");
const body = stripTypeScriptTypes(
  source.slice(declaration.start, declaration.end),
);

it.each(["rollback", "recover"])(
  "refuses a direct retired %s command without an ACK or changing retained state",
  async (kind) => {
    const retained = Object.freeze({
      phase: "failed",
      code: "UPDATE_HANDOFF_UNKNOWN",
      recoveryRequired: true,
    });
    const restore = vi.fn();
    const context = {
      InstalledUpdateCommandSchema,
      isRetiredInstalledUpdateCommand,
      installedUpdater: { restore },
      installedUpdateView: retained,
      quitInProgress: false,
    };
    const command = vm.runInNewContext(
      `${body}; installedUpdateCommand`,
      context,
    );
    for (const value of [{ kind }, { kind, staleField: true }]) {
      expect(InstalledUpdateCommandSchema.safeParse(value).success).toBe(false);
      expect(await command(value)).toEqual({
        phase: "unavailable",
        code: "UPDATE_FORWARD_ONLY",
      });
      expect(context.installedUpdateView).toBe(retained);
      expect(restore).not.toHaveBeenCalled();
    }
  },
);
