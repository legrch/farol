// The public core gate owns these protocol files and every default Go package.
// Root composition delegates them here instead of executing them twice.
export const coreProtocolFiles = Object.freeze([
  "tests/contract/desktop-wire.test.ts",
  "tests/architecture/go-architecture.test.ts",
]);

export function coreTestSteps({ nested, node, go }) {
  return [
    {
      id: "generated-wire",
      executable: node,
      args: ["tooling/generate-desktop-wire.mjs", "--check"],
    },
    {
      id: "go-imports",
      executable: node,
      args: ["tooling/check-go-architecture.mjs"],
    },
    { id: "root-go-race", executable: go, args: ["test", "-race", "./..."] },
    { id: "root-go-vet", executable: go, args: ["vet", "./..."] },
    ...(nested
      ? [
          {
            id: "nested-go-race",
            executable: go,
            args: ["test", "-race", "./..."],
            cwd: "resources/native/go",
          },
          {
            id: "nested-go-vet",
            executable: go,
            args: ["vet", "./..."],
            cwd: "resources/native/go",
          },
        ]
      : [
          {
            id: "nested-go-absent",
            message: "Nested release Go module absent from this accepted base.",
          },
        ]),
    {
      id: "protocol",
      executable: node,
      args: ["node_modules/vitest/vitest.mjs", "run", ...coreProtocolFiles],
    },
    {
      id: "desktop-types",
      executable: node,
      args: [
        "node_modules/typescript/bin/tsc",
        "--noEmit",
        "--project",
        "tooling/tsconfig.desktop-core.json",
      ],
    },
    {
      id: "all-types",
      executable: node,
      args: ["node_modules/typescript/bin/tsc", "--noEmit"],
    },
  ];
}
