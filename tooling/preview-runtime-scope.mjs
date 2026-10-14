/** Scope of runtime.cjs only: in-memory fixture state and loopback HTTP. */
const builtins = new Set(["node:http", "node:crypto", "node:events"]);
export function assertPreviewRuntimeHostScope(metafile) {
  const outputs = Object.values(metafile.outputs);
  if (outputs.length !== 1) throw new Error("PREVIEW_RUNTIME_SCOPE_INVALID");
  for (const imported of outputs[0].imports) {
    if (!imported.external || !builtins.has(imported.path))
      throw new Error("PREVIEW_RUNTIME_HOST_EFFECT_DEPENDENCY_REFUSED");
  }
}
