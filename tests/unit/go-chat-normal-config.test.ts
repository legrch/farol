import { describe, expect, it } from "vitest";
import {
  configArgument,
  configPath,
} from "../e2e/fixtures/go-chat-normal-config.ts";

const file = "/private/tmp/controlled native/config.json";
describe("controlled Go Chat config arguments", () => {
  it("reads the named config with the actual Electron/debugger argument layout", () => {
    const arguments_ = [
      "/Applications/Electron.app/Contents/MacOS/Electron",
      "--inspect=0",
      "--remote-debugging-port=0",
      "/private/tmp/join.cjs",
      configArgument(file),
    ];
    expect(arguments_[2]).toBe("--remote-debugging-port=0");
    expect(configPath(arguments_)).toBe(file);
  });
  it("does not depend on where debugger flags are inserted", () => {
    expect(
      configPath([
        configArgument(file),
        "--inspect=0",
        "/private/tmp/join.cjs",
      ]),
    ).toBe(file);
  });
  it.each(
    [
      [],
      [file],
      ["Electron", "join.cjs", file],
      [configArgument(file), configArgument(file)],
      [configArgument(file), "--farol-go-chat-normal-config"],
    ].map((arguments_) => ({ arguments_ })),
  )(
    "refuses absent, positional or ambiguous config inputs: %j",
    ({ arguments_ }) => {
      expect(() => configPath(arguments_)).toThrow(
        "HARNESS_CONFIG_ARGUMENT_INVALID",
      );
    },
  );
  it.each([
    "",
    "config.json",
    "/private/tmp/../config.json",
    "/private/tmp/config.json\0",
  ])("rejects invalid config paths before a file read: %j", (value) => {
    expect(() => configArgument(value)).toThrow("HARNESS_CONFIG_PATH_INVALID");
    expect(() =>
      configPath(["--farol-go-chat-normal-config=" + value]),
    ).toThrow("HARNESS_CONFIG_PATH_INVALID");
  });
});
