#!/usr/bin/env node
// Ignore the supplied dev.mjs argument: use actual launchPreview with synthetic
// bounded app/Go descendants, never a build, profile, provider or credentials.
await import("./terminal-owner.mjs");
