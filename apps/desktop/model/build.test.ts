import { describe, expect, it } from "vitest";

import {
  buildProviderBlockBody,
  buildSelectionBody,
  FAROL_MODEL_HOST_TUNING,
  tomlString,
  type FarolModelProviderSpec,
} from "./build";

const spec: FarolModelProviderSpec = {
  providerName: "farol",
  model: "chatgpt",
  displayName: 'Farol "Model"',
  baseUrl: "http://127.0.0.1:1/v1",
  wireApi: "responses",
  delivery: { mode: "env-key", envKeyName: "FAROL_KEY" },
};

describe("managed block text", () => {
  it("pins the host retry contract", () => {
    expect(FAROL_MODEL_HOST_TUNING).toEqual({
      requiresOpenAiAuth: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
      streamIdleTimeoutMs: 120_000,
    });
  });

  it("escapes strings as TOML basic strings", () => {
    expect(tomlString('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
  });

  it("builds the provider block with env_key in a fixed key order", () => {
    expect(buildProviderBlockBody(spec)).toBe(
      [
        "# BEGIN FAROL MANAGED BLOCK — do not edit by hand",
        "[model_providers.farol]",
        'name = "Farol \\"Model\\""',
        'base_url = "http://127.0.0.1:1/v1"',
        'env_key = "FAROL_KEY"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "stream_idle_timeout_ms = 120000",
        "# END FAROL MANAGED BLOCK",
      ].join("\n"),
    );
  });

  it("carries a literal token as experimental_bearer_token instead of env_key", () => {
    const body = buildProviderBlockBody({
      ...spec,
      delivery: { mode: "bearer-token", token: "tok" },
    });
    expect(body).toContain('experimental_bearer_token = "tok"');
    expect(body).not.toContain("env_key");
  });

  it("builds the selection region", () => {
    expect(buildSelectionBody(spec)).toBe(
      [
        "# BEGIN FAROL MANAGED MODEL_PROVIDER SELECTION — do not edit by hand",
        'model_provider = "farol"',
        'model = "chatgpt"',
        "# END FAROL MANAGED MODEL_PROVIDER SELECTION",
      ].join("\n"),
    );
  });
});
