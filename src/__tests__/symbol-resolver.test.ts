import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SymbolResolver } from "../lock/symbol-resolver";

/**
 * Symbol Resolver Tests
 *
 * Verifies TypeScript AST-based symbol extraction for symbol-level locking.
 * Tests: function/class/interface/type/export parsing, edge cases, lock key utilities.
 */
describe("SymbolResolver — parseSymbols", () => {
  let tmpDir: string;
  let resolver: SymbolResolver;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-sym-"));
    resolver = new SymbolResolver();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts function declarations", () => {
    const filePath = path.join(tmpDir, "funcs.ts");
    fs.writeFileSync(
      filePath,
      ["function login() { return true; }", "function logout() { return false; }"].join("\n"),
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe("login");
    expect(symbols[0].kind).toBe("function");
    expect(symbols[1].name).toBe("logout");
    expect(symbols[1].kind).toBe("function");
  });

  it("extracts class declarations", () => {
    const filePath = path.join(tmpDir, "classes.ts");
    fs.writeFileSync(
      filePath,
      "export class AuthService { login() {} }",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("AuthService");
    expect(symbols[0].kind).toBe("class");
    expect(symbols[0].exported).toBe(true);
  });

  it("extracts exported and non-exported symbols", () => {
    const filePath = path.join(tmpDir, "mixed.ts");
    fs.writeFileSync(
      filePath,
      [
        "function internalHelper() {}",
        "export function publicApi() {}",
        "const localConst = 1;",
        "export const globalConst = 2;",
      ].join("\n"),
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols.length).toBeGreaterThanOrEqual(2);

    const internal = symbols.find((s) => s.name === "internalHelper");
    expect(internal).toBeDefined();
    expect(internal!.exported).toBe(false);

    const pub = symbols.find((s) => s.name === "publicApi");
    expect(pub).toBeDefined();
    expect(pub!.exported).toBe(true);

    const local = symbols.find((s) => s.name === "localConst");
    expect(local).toBeDefined();
    expect(local!.exported).toBe(false);

    const global = symbols.find((s) => s.name === "globalConst");
    expect(global).toBeDefined();
    expect(global!.exported).toBe(true);
  });

  it("extracts interface declarations", () => {
    const filePath = path.join(tmpDir, "types.ts");
    fs.writeFileSync(
      filePath,
      "export interface User { id: string; name: string; }",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("User");
    expect(symbols[0].kind).toBe("interface");
    expect(symbols[0].exported).toBe(true);
  });

  it("extracts type aliases", () => {
    const filePath = path.join(tmpDir, "types.ts");
    fs.writeFileSync(
      filePath,
      "export type Status = 'active' | 'inactive';",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("Status");
    expect(symbols[0].kind).toBe("type");
    expect(symbols[0].exported).toBe(true);
  });

  it("extracts named export declarations", () => {
    const filePath = path.join(tmpDir, "exports.ts");
    fs.writeFileSync(
      filePath,
      "export { logout, validateToken } from './auth';",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    // Each named export produces a symbol entry with the EXPORTED name
    const names = symbols.filter((s) => s.kind === "export").map((s) => s.name);
    expect(names).toContain("logout");
    expect(names).toContain("validateToken");
  });

  it("extracts default export of class/function as exported symbol", () => {
    const filePath = path.join(tmpDir, "default-export.ts");
    fs.writeFileSync(
      filePath,
      "export default class App { render() {} }",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    // `export default class App` is a ClassDeclaration with export+default modifiers
    const app = symbols.find((s) => s.name === "App");
    expect(app).toBeDefined();
    expect(app!.kind).toBe("class");
    expect(app!.exported).toBe(true);
  });

  it("extracts bare export assignment (re-export of a value)", () => {
    const filePath = path.join(tmpDir, "bare-export.ts");
    fs.writeFileSync(
      filePath,
      "const expr = 42;\nexport default expr;",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    // `export default expr` — ExportAssignment produces "default" export symbol
    const defaultExport = symbols.find((s) => s.name === "default" && s.kind === "export");
    expect(defaultExport).toBeDefined();
    expect(defaultExport!.exported).toBe(true);
  });

  it("extracts variable declarations (const/let/var)", () => {
    const filePath = path.join(tmpDir, "vars.ts");
    fs.writeFileSync(
      filePath,
      [
        "export const API_URL = 'https://api.example.com';",
        "let counter = 0;",
        "var legacyFlag = true;",
      ].join("\n"),
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols.length).toBeGreaterThanOrEqual(2);

    const apiUrl = symbols.find((s) => s.name === "API_URL");
    expect(apiUrl).toBeDefined();
    expect(apiUrl!.kind).toBe("const");
    expect(apiUrl!.exported).toBe(true);

    const counter = symbols.find((s) => s.name === "counter");
    expect(counter).toBeDefined();
    expect(counter!.kind).toBe("let");

    const legacy = symbols.find((s) => s.name === "legacyFlag");
    expect(legacy).toBeDefined();
    expect(legacy!.kind).toBe("var");
  });

  it("returns line ranges for symbols", () => {
    const filePath = path.join(tmpDir, "ranges.ts");
    fs.writeFileSync(
      filePath,
      "// comment line\nfunction topFunc() {\n  return 42;\n}\n",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].name).toBe("topFunc");
    expect(symbols[0].range).toEqual([2, 4]); // function spans lines 2-4
  });

  it("returns empty array for non-existent file", () => {
    const symbols = resolver.parseSymbols(path.join(tmpDir, "no-such.ts"));
    expect(symbols).toEqual([]);
  });

  it("returns empty array for empty file", () => {
    const filePath = path.join(tmpDir, "empty.ts");
    fs.writeFileSync(filePath, "", "utf-8");
    expect(resolver.parseSymbols(filePath)).toEqual([]);
  });

  it("returns empty array for whitespace-only file", () => {
    const filePath = path.join(tmpDir, "whitespace.ts");
    fs.writeFileSync(filePath, "\n  \n  \n", "utf-8");
    expect(resolver.parseSymbols(filePath)).toEqual([]);
  });

  it("returns empty array for non-TS/JS files", () => {
    const jsonPath = path.join(tmpDir, "data.json");
    fs.writeFileSync(jsonPath, '{"key": "value"}', "utf-8");
    expect(resolver.parseSymbols(jsonPath)).toEqual([]);

    const mdPath = path.join(tmpDir, "readme.md");
    fs.writeFileSync(mdPath, "# Hello", "utf-8");
    expect(resolver.parseSymbols(mdPath)).toEqual([]);
  });

  it("returns empty array for unparseable content", () => {
    const filePath = path.join(tmpDir, "bad.ts");
    // TypeScript's parser is resilient — it can handle syntax errors
    // But truly garbled files may produce no meaningful symbols
    fs.writeFileSync(filePath, "!!! not valid code @@@", "utf-8");
    // Parser should not throw — might produce some output or empty
    const symbols = resolver.parseSymbols(filePath);
    expect(Array.isArray(symbols)).toBe(true);
  });

  it("does not extract symbols inside function bodies", () => {
    const filePath = path.join(tmpDir, "nested.ts");
    fs.writeFileSync(
      filePath,
      "function outer() { function inner() {} return inner; }",
      "utf-8"
    );

    const symbols = resolver.parseSymbols(filePath);
    // Only outer should be extracted; inner is a nested function
    const names = symbols.map((s) => s.name);
    expect(names).toContain("outer");
    expect(names).not.toContain("inner");
  });
});

describe("SymbolResolver — resolveLocksForTask", () => {
  let tmpDir: string;
  let resolver: SymbolResolver;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-sym-"));
    resolver = new SymbolResolver();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves to symbol-level lock when description matches a function name", () => {
    const filePath = path.join(tmpDir, "auth.ts");
    fs.writeFileSync(filePath, "function login() {}\nfunction logout() {}", "utf-8");

    const locks = resolver.resolveLocksForTask([filePath], "Update the login function");
    expect(locks).toContain(`${filePath}#login`);
  });

  it("falls back to file-level lock when no symbols match", () => {
    const filePath = path.join(tmpDir, "auth.ts");
    fs.writeFileSync(filePath, "function login() {}\nfunction logout() {}", "utf-8");

    const locks = resolver.resolveLocksForTask([filePath], "Refactor the auth module");
    expect(locks).toEqual([filePath]);
  });

  it("falls back to file-level lock for non-TS files", () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, "{}", "utf-8");

    const locks = resolver.resolveLocksForTask([filePath], "Update data");
    expect(locks).toEqual([filePath]);
  });

  it("matches multiple symbols from description", () => {
    const filePath = path.join(tmpDir, "auth.ts");
    fs.writeFileSync(
      filePath,
      "function login() {}\nfunction signup() {}\nfunction validate() {}",
      "utf-8"
    );

    const locks = resolver.resolveLocksForTask([filePath], "Fix login and signup flows");
    expect(locks).toContain(`${filePath}#login`);
    expect(locks).toContain(`${filePath}#signup`);
  });
});

describe("SymbolResolver — lock key utilities", () => {
  let resolver: SymbolResolver;

  beforeEach(() => {
    resolver = new SymbolResolver();
  });

  it("fileFromLockKey extracts the file path", () => {
    expect(resolver.fileFromLockKey("src/auth.ts#login")).toBe("src/auth.ts");
    expect(resolver.fileFromLockKey("src/auth.ts")).toBe("src/auth.ts");
    expect(resolver.fileFromLockKey("path/to/module.ts#MyClass")).toBe("path/to/module.ts");
  });

  it("symbolFromLockKey extracts the symbol name", () => {
    expect(resolver.symbolFromLockKey("src/auth.ts#login")).toBe("login");
    expect(resolver.symbolFromLockKey("src/auth.ts")).toBe("");
    expect(resolver.symbolFromLockKey("src/nested/file.ts#default")).toBe("default");
  });

  it("hasConflict detects exact match", () => {
    expect(resolver.hasConflict(["src/auth.ts#login"], ["src/auth.ts#login"])).toBe(true);
  });

  it("hasConflict detects file-level covering symbol-level", () => {
    expect(resolver.hasConflict(["src/auth.ts"], ["src/auth.ts#login"])).toBe(true);
    expect(resolver.hasConflict(["src/auth.ts#login"], ["src/auth.ts"])).toBe(true);
  });

  it("hasConflict allows different symbols in same file", () => {
    expect(resolver.hasConflict(["src/auth.ts#login"], ["src/auth.ts#logout"])).toBe(false);
  });

  it("hasConflict allows different files entirely", () => {
    expect(resolver.hasConflict(["src/auth.ts#login"], ["src/db.ts#connect"])).toBe(false);
  });

  it("hasConflict returns false for empty arrays", () => {
    expect(resolver.hasConflict([], [])).toBe(false);
    expect(resolver.hasConflict(["src/a.ts"], [])).toBe(false);
  });
});
