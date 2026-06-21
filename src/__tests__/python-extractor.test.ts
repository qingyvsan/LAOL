import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PythonSymbolExtractor } from "../codebase/python-extractor";

describe("PythonSymbolExtractor — extract", () => {
  let tmpDir: string;
  let extractor: PythonSymbolExtractor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-py-"));
    extractor = new PythonSymbolExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Functions ----

  it("extracts function with parameters and return type", () => {
    const fp = path.join(tmpDir, "func.py");
    fs.writeFileSync(fp, [
      "def greet(name: str, times: int = 1) -> str:",
      "    return f'Hello {name}' * times",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    expect(r).not.toBeNull();
    const fn = r.symbols.find((s) => s.name === "greet")!;
    expect(fn).toBeDefined();
    expect(fn.kind).toBe("function");
    expect(fn.exported).toBe(true);
    expect(fn.parameters).toHaveLength(2);
    expect(fn.parameters![0].name).toBe("name");
    expect(fn.parameters![0].type).toBe("str");
    expect(fn.parameters![0].optional).toBe(false);
    expect(fn.parameters![1].name).toBe("times");
    expect(fn.parameters![1].type).toBe("int");
    expect(fn.parameters![1].defaultValue).toBe("1");
    expect(fn.returnType).toBe("str");
  });

  it("extracts async function", () => {
    const fp = path.join(tmpDir, "asyncf.py");
    fs.writeFileSync(fp, [
      "async def fetch(url: str) -> dict:",
      "    return {}",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    expect(r).not.toBeNull();
    const fn = r.symbols.find((s) => s.name === "fetch")!;
    expect(fn.kind).toBe("function");
    const asyncTag = fn.jsDoc?.tags?.find((t) => t.name === "async");
    expect(asyncTag).toBeDefined();
    expect(asyncTag!.text).toBe("true");
  });

  it("extracts function with *args and **kwargs", () => {
    const fp = path.join(tmpDir, "varargs.py");
    fs.writeFileSync(fp, [
      "def log(msg: str, *tags: str, **opts: int) -> None:",
      "    pass",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const fn = r.symbols.find((s) => s.name === "log")!;
    expect(fn.parameters).toHaveLength(3);
    expect(fn.parameters![1].name).toBe("*tags");
    expect(fn.parameters![1].isRest).toBe(true);
    expect(fn.parameters![2].name).toBe("**opts");
  });

  // ---- Classes ----

  it("extracts class with methods as separate symbols", () => {
    const fp = path.join(tmpDir, "cls.py");
    fs.writeFileSync(fp, [
      "class Calculator:",
      "    \"\"\"A simple calculator.\"\"\"",
      "",
      "    def add(self, a: int, b: int) -> int:",
      "        return a + b",
      "",
      "    def multiply(self, a: int, b: int) -> int:",
      "        return a * b",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const cls = r.symbols.find((s) => s.name === "Calculator")!;
    expect(cls.kind).toBe("class");
    expect(cls.jsDoc?.description).toContain("simple calculator");

    const add = r.symbols.find((s) => s.name === "add")!;
    expect(add.kind).toBe("function");
    expect(add.parameters).toHaveLength(3); // self, a, b

    const mul = r.symbols.find((s) => s.name === "multiply")!;
    expect(mul.kind).toBe("function");
  });

  // ---- Docstrings — Sphinx style ----

  it("parses Sphinx :param and :returns in docstring", () => {
    const fp = path.join(tmpDir, "sphinx.py");
    fs.writeFileSync(fp, [
      "def connect(host: str, port: int) -> bool:",
      '    """Establish a connection to the server.',
      "",
      "    :param host: Server hostname or IP address.",
      '    :param port: TCP port number.',
      "    :returns: True if connection succeeded.",
      '    """',
      "    return True",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const fn = r.symbols.find((s) => s.name === "connect")!;
    expect(fn.jsDoc).toBeDefined();
    expect(fn.jsDoc!.description).toContain("Establish a connection");
    expect(fn.jsDoc!.params).toHaveLength(2);
    expect(fn.jsDoc!.params[0].name).toBe("host");
    expect(fn.jsDoc!.params[0].text).toContain("Server hostname");
    expect(fn.jsDoc!.params[1].name).toBe("port");
    expect(fn.jsDoc!.returns).toContain("True if connection succeeded");
  });

  it("parses Sphinx :raises and :rtype as custom tags", () => {
    const fp = path.join(tmpDir, "sphinx-tags.py");
    fs.writeFileSync(fp, [
      "def divide(a: int, b: int) -> float:",
      '    """Divide a by b.',
      "",
      "    :param a: Dividend.",
      "    :param b: Divisor.",
      "    :raises ValueError: If b is zero.",
      "    :rtype: float",
      '    """',
      "    if b == 0:",
      "        raise ValueError('Division by zero')",
      "    return a / b",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const fn = r.symbols.find((s) => s.name === "divide")!;
    const tagNames = fn.jsDoc!.tags.map((t) => t.name);
    expect(tagNames).toContain("raises");
    expect(tagNames).toContain("rtype");
  });

  // ---- Docstrings — Google style ----

  it("parses Google-style Args and Returns in docstring", () => {
    const fp = path.join(tmpDir, "google.py");
    fs.writeFileSync(fp, [
      "def train(model: str, epochs: int = 10) -> dict:",
      '    """Train a machine learning model.',
      "",
      "    Args:",
      "        model: Name of the model architecture.",
      "        epochs: Number of training epochs.",
      "",
      "    Returns:",
      "        A dictionary with training metrics.",
      '    """',
      "    return {'loss': 0.1}",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const fn = r.symbols.find((s) => s.name === "train")!;
    expect(fn.jsDoc).toBeDefined();
    expect(fn.jsDoc!.description).toContain("Train a machine learning model");
    expect(fn.jsDoc!.returns).toContain("training metrics");
    // Google Args section marker
    expect(fn.jsDoc!.tags.some((t) => t.name === "args_style")).toBe(true);
  });

  // ---- Variables ----

  it("extracts top-level variable assignments as const", () => {
    const fp = path.join(tmpDir, "vars.py");
    fs.writeFileSync(fp, [
      'APP_NAME = "MyApp"',
      "MAX_RETRIES = 3",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const v1 = r.symbols.find((s) => s.name === "APP_NAME")!;
    expect(v1.kind).toBe("const");

    const v2 = r.symbols.find((s) => s.name === "MAX_RETRIES")!;
    expect(v2.kind).toBe("const");
  });

  it("extracts annotated assignments with @type tag", () => {
    const fp = path.join(tmpDir, "annotated.py");
    fs.writeFileSync(fp, [
      "count: int = 0",
      'name: str = "default"',
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const sym = r.symbols.find((s) => s.name === "count")!;
    expect(sym.kind).toBe("const");
    expect(sym.jsDoc).toBeDefined();
    const typeTag = sym.jsDoc!.tags.find((t) => t.name === "type");
    expect(typeTag).toBeDefined();
    expect(typeTag!.text).toBe("int");
  });

  it("detects decorator factory assignments", () => {
    const fp = path.join(tmpDir, "decfact.py");
    fs.writeFileSync(fp, [
      "login_required = decorator_factory()",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const sym = r.symbols.find((s) => s.name === "login_required")!;
    expect(sym.kind).toBe("decorator");
  });

  // ---- Imports ----

  it("extracts import ... statements", () => {
    const fp = path.join(tmpDir, "imp.py");
    fs.writeFileSync(fp, [
      "import os",
      "import json as j",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    expect(r.imports).toHaveLength(2);
    expect(r.imports[0].moduleSpecifier).toBe("os");
    expect(r.imports[0].defaultImport).toBe("os");
    expect(r.imports[1].defaultImport).toBe("j");
  });

  it("extracts from ... import ... statements", () => {
    const fp = path.join(tmpDir, "fromimp.py");
    fs.writeFileSync(fp, [
      "from collections import namedtuple, deque",
      "from .models import User",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    expect(r.imports).toHaveLength(2);
    expect(r.imports[0].moduleSpecifier).toBe("collections");
    expect(r.imports[0].namedImports).toContain("namedtuple");
    expect(r.imports[0].namedImports).toContain("deque");
    // Python AST stores relative import level separately (node.level=1);
    // the module specifier is just "models" without the leading dot.
    expect(r.imports[1].moduleSpecifier).toBe("models");
    expect(r.imports[1].namedImports).toContain("User");
  });

  // ---- Call collection ----

  it("collects call expressions in function bodies", () => {
    const fp = path.join(tmpDir, "calls.py");
    fs.writeFileSync(fp, [
      "def helper():",
      "    pass",
      "",
      "def main():",
      "    helper()",
      "    print('hello')",
      "    helper()  # duplicate - should be deduplicated",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const main = r.symbols.find((s) => s.name === "main")!;
    expect(main.calls).toBeDefined();
    const names = main.calls!.map((c) => c.name);
    expect(names).toContain("helper");
    expect(names).toContain("print");
    // Dedup is per name+line; helper appears on two lines (5 and 7)
    expect(main.calls!.filter((c) => c.name === "helper")).toHaveLength(2);
  });

  // ---- Module symbol ----

  it("creates a <module> symbol for every file", () => {
    const fp = path.join(tmpDir, "mod.py");
    fs.writeFileSync(fp, [
      '"""My module docstring."""',
      "",
      "def foo():",
      "    pass",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const mod = r.symbols[0];
    expect(mod.name).toBe("<module>");
    expect(mod.kind).toBe("module");
    expect(mod.exported).toBe(true);
    expect(mod.jsDoc?.description).toContain("My module docstring");
  });

  it("module symbol has no jsDoc when no docstring", () => {
    const fp = path.join(tmpDir, "nomod.py");
    fs.writeFileSync(fp, [
      "x = 1",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const mod = r.symbols[0];
    expect(mod.name).toBe("<module>");
    expect(mod.kind).toBe("module");
    expect(mod.jsDoc).toBeUndefined();
  });

  // ---- Edge cases ----

  it("returns null for non-Python files", () => {
    const fp = path.join(tmpDir, "data.json");
    fs.writeFileSync(fp, '{"key": "value"}', "utf-8");
    expect(extractor.extract(fp)).toBeNull();
  });

  it("returns null for non-existent files", () => {
    const fp = path.join(tmpDir, "no-such.py");
    expect(extractor.extract(fp)).toBeNull();
  });

  it("returns null for empty files", () => {
    const fp = path.join(tmpDir, "empty.py");
    fs.writeFileSync(fp, "", "utf-8");
    expect(extractor.extract(fp)).toBeNull();
  });

  it("returns null for files with Python syntax errors", () => {
    const fp = path.join(tmpDir, "broken.py");
    fs.writeFileSync(fp, "def broken(:\n    pass\n", "utf-8");
    expect(extractor.extract(fp)).toBeNull();
  });

  it("marks underscore-prefixed names as not exported", () => {
    const fp = path.join(tmpDir, "priv.py");
    fs.writeFileSync(fp, [
      "def _internal():",
      "    pass",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const fn = r.symbols.find((s) => s.name === "_internal")!;
    expect(fn.exported).toBe(false);
  });

  it("handles decorators on functions", () => {
    const fp = path.join(tmpDir, "decorated.py");
    fs.writeFileSync(fp, [
      "@staticmethod",
      "def util():",
      "    pass",
      "",
    ].join("\n"), "utf-8");

    const r = extractor.extract(fp)!;
    const fn = r.symbols.find((s) => s.name === "util")!;
    const decTags = fn.jsDoc?.tags?.filter((t) => t.name === "decorator") ?? [];
    expect(decTags).toHaveLength(1);
    // ast.unparse() returns the decorator name without the @ prefix
    expect(decTags[0].text).toBe("staticmethod");
  });
});

describe("PythonSymbolExtractor — hashFile", () => {
  it("returns a 16-char hex string for a file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "laol-pyh-"));
    const fp = path.join(tmpDir, "test.py");
    fs.writeFileSync(fp, "x = 1\n", "utf-8");
    const hash = PythonSymbolExtractor.hashFile(fp);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns "hash-error" for non-existent files', () => {
    expect(PythonSymbolExtractor.hashFile("/no/such/file.py")).toBe("hash-error");
  });
});
