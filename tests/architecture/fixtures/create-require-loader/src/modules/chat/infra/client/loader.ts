import { createRequire } from "node:module";

const load = createRequire(import.meta.url);

export const backdoor = load("../../../agent/infra/native/host");
