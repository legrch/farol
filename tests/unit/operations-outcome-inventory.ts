import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";

// Include implementations for open `code: string` contracts as well as closed
// result types. This is a conservative superset of the observed result surface;
// new source files below these owners are discovered without editing this list.
const roots = [
  "src/pkg/product-settings",
  "src/modules/computer/contract",
  "src/modules/chat/contract",
  "src/modules/release",
  "modules/computer",
  "modules/chat",
  "modules/task",
  "modules/release",
  "transport/desktop",
  "apps/desktop",
  "src/apps/desktop",
];
const fields = new Set([
  "status",
  "state",
  "phase",
  "outcome",
  "code",
  "error",
  "reason",
]);
const isCode = (value: string) =>
  /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|chat_browser_[a-z_]+|computer_mcp_[a-z_]+)$/u.test(
    value,
  );

type Node = {
  type?: string;
  value?: unknown;
  name?: string;
  [key: string]: unknown;
};
function walk(value: unknown, visit: (node: Node) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child) => walk(child, visit));
    return;
  }
  const node = value as Node;
  visit(node);
  for (const [key, child] of Object.entries(node))
    if (
      ![
        "loc",
        "start",
        "end",
        "comments",
        "leadingComments",
        "trailingComments",
        "innerComments",
      ].includes(key)
    )
      walk(child, visit);
}

export function declaredOperationOutcomes(): Map<string, Set<string>> {
  const inventory = new Map<string, Set<string>>();
  const add = (value: string, file: string) => {
    if (!value || ["ACCESS_TOKEN", "O_NOFOLLOW", "O_CLOEXEC"].includes(value))
      return;
    const sources = inventory.get(value) ?? new Set<string>();
    sources.add(file);
    inventory.set(value, sources);
  };
  const sources = new Set<string>();
  const discover = (root: string) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.posix.join(root, entry.name);
      if (
        entry.isDirectory() &&
        !["apps/desktop/renderer", "apps/desktop/operations"].includes(file)
      )
        discover(file);
      else if (
        /\.(?:ts|go)$/u.test(file) &&
        !/(?:_test\.go|\.test\.ts)$/u.test(file)
      )
        sources.add(file);
    }
  };
  roots.forEach(discover);
  for (const file of sources) {
    const source = fs.readFileSync(file, "utf8");
    if (file.endsWith(".go")) {
      // Tokenize Go comments and strings together so comments cannot introduce
      // fake codes. Go's closed typed outcome constants use string literals.
      for (const match of source.matchAll(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|`[^`]*`/gu,
      )) {
        if (!match[0].startsWith('"')) continue;
        const value = match[0].slice(1, -1);
        if (typeof value === "string" && isCode(value)) add(value, file);
      }
      const uncommented = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
      for (const match of uncommented.matchAll(
        /\b\w+\s+(?:[A-Za-z]*(?:Phase|Outcome|State|Status|Code|Reason)|Cleanup)\s*=\s*"([^"\n]+)"/gu,
      ))
        add(match[1]!, file);
      continue;
    }
    const tree = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
    });
    // Excerpt state/reason classify redaction, not operation outcomes. Their
    // generic values must not be promoted into the operation result mapping.
    let auditExcerpt: { start: number; end: number } | undefined;
    if (file === "apps/desktop/bridge/wire.ts")
      walk(tree, (node) => {
        if (
          node.type === "TSInterfaceDeclaration" &&
          (node.id as Node)?.name === "ComputerProcessAuditExcerpt" &&
          typeof node.start === "number" &&
          typeof node.end === "number"
        )
          auditExcerpt = { start: node.start, end: node.end };
      });
    walk(tree, (node) => {
      if (
        node.type === "TSPropertySignature" &&
        auditExcerpt &&
        typeof node.start === "number" &&
        typeof node.end === "number" &&
        node.start >= auditExcerpt.start &&
        node.end <= auditExcerpt.end
      )
        return;
      if (
        node.type === "StringLiteral" &&
        typeof node.value === "string" &&
        isCode(node.value)
      )
        add(node.value, file);
      if (
        node.type === "NewExpression" &&
        (node.callee as Node)?.name === "BridgeError"
      ) {
        walk(node.arguments, (literal) => {
          if (
            literal.type === "StringLiteral" &&
            typeof literal.value === "string"
          )
            add(literal.value, file);
        });
      }
      if (node.type !== "ObjectProperty" && node.type !== "TSPropertySignature")
        return;
      const key = node.key as Node | undefined;
      if (!key || !fields.has(key.name ?? String(key.value))) return;
      // Only closed schemas/types and literal result fields; never traverse
      // function bodies or unrelated payload objects under an open error field.
      const collectType = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        const type = value as Node;
        if (type.type === "TSTypeAnnotation") collectType(type.typeAnnotation);
        else if (type.type === "TSUnionType")
          (type.types as unknown[]).forEach(collectType);
        else if (type.type === "TSLiteralType") {
          const literal = type.literal as Node;
          if (
            literal.type === "StringLiteral" &&
            typeof literal.value === "string"
          )
            add(literal.value, file);
        }
      };
      if (node.type === "TSPropertySignature") collectType(node.typeAnnotation);
      else if (
        typeof (node.value as Node)?.value === "string" &&
        ["error", "code", "reason"].includes(key.name ?? String(key.value))
      ) {
        const literal = (node.value as Node).value as string;
        if (literal !== "custom") add(literal, file);
      } else if (
        /contract\.ts$|release\/domain\/installed-update\.ts$/u.test(file)
      ) {
        let value = node.value as Node | undefined;
        while (value?.type === "CallExpression") {
          const callee = value.callee as Node;
          const property = callee.property as Node | undefined;
          const receiver = callee.object as Node | undefined;
          if (
            receiver?.type === "Identifier" &&
            receiver.name === "z" &&
            ["enum", "literal"].includes(property?.name ?? "")
          ) {
            walk(value.arguments, (literal) => {
              if (
                literal.type === "StringLiteral" &&
                typeof literal.value === "string"
              )
                add(literal.value, file);
            });
            break;
          }
          value = receiver;
        }
      }
    });
  }
  return inventory;
}
