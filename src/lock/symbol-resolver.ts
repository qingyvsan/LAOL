import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import type { SymbolDef } from "../data/models";

/**
 * Symbol Resolver — TypeScript AST-based parsing for finer-grained locking.
 *
 * Parses TypeScript/JavaScript files to extract top-level symbols
 * (functions, classes, exports). Enables symbol-level locks:
 * "src/auth.ts#login" instead of just "src/auth.ts".
 *
 * Non-TS/JS files (.json, .md, etc.) fall back to file-level locking.
 * Unparseable files also fall back to file-level locking.
 */
export class SymbolResolver {
  private static readonly TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
  private static readonly JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

  /**
   * Parse symbols from a TypeScript/JavaScript file.
   *
   * Uses TypeScript's compiler API to extract top-level declarations.
   * Returns empty array for non-TS/JS files or parse failures
   * (system falls back to file-level locking).
   */
  parseSymbols(filePath: string): SymbolDef[] {
    if (!fs.existsSync(filePath)) return [];

    const ext = path.extname(filePath).toLowerCase();
    if (!SymbolResolver.TS_EXTS.has(ext) && !SymbolResolver.JS_EXTS.has(ext)) {
      return [];
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    if (content.trim().length === 0) return [];

    const langVersion = SymbolResolver.TS_EXTS.has(ext)
      ? ts.ScriptTarget.Latest
      : ts.ScriptTarget.Latest;

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(filePath, content, langVersion, true);
    } catch {
      return [];
    }

    const symbols: SymbolDef[] = [];

    const visit = (node: ts.Node): void => {
      // --- Function declaration ---
      if (ts.isFunctionDeclaration(node)) {
        if (node.name) {
          symbols.push({
            name: node.name.text,
            kind: "function",
            range: [
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            ],
            exported: SymbolResolver.hasExportModifier(node),
          });
        }
        return; // don't recurse into function body
      }

      // --- Class declaration ---
      if (ts.isClassDeclaration(node)) {
        if (node.name) {
          symbols.push({
            name: node.name.text,
            kind: "class",
            range: [
              sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
            ],
            exported: SymbolResolver.hasExportModifier(node),
          });
        }
        return; // don't recurse into class body
      }

      // --- Variable statement (const / let / var) ---
      if (ts.isVariableStatement(node)) {
        const isExported = SymbolResolver.hasExportModifier(node);
        const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
        const isLet = (node.declarationList.flags & ts.NodeFlags.Let) !== 0;
        const varKind: SymbolDef["kind"] = isConst ? "const" : isLet ? "let" : "var";

        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            symbols.push({
              name: decl.name.text,
              kind: varKind,
              range: [
                sourceFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
                sourceFile.getLineAndCharacterOfPosition(decl.getEnd()).line + 1,
              ],
              exported: isExported,
            });
          }
        }
        return;
      }

      // --- Interface declaration ---
      if (ts.isInterfaceDeclaration(node)) {
        symbols.push({
          name: node.name.text,
          kind: "interface",
          range: [
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          ],
          exported: SymbolResolver.hasExportModifier(node),
        });
        return;
      }

      // --- Type alias ---
      if (ts.isTypeAliasDeclaration(node)) {
        symbols.push({
          name: node.name.text,
          kind: "type",
          range: [
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          ],
          exported: SymbolResolver.hasExportModifier(node),
        });
        return;
      }

      // --- Export assignment (export default ...) ---
      if (ts.isExportAssignment(node)) {
        // export default <expr> — capture as "default" export
        symbols.push({
          name: "default",
          kind: "export",
          range: [
            sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          ],
          exported: true,
        });
        return;
      }

      // --- Export declaration (export { ... } or export { x as y }) ---
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const spec of node.exportClause.elements) {
            const exportedName = spec.name.text;
            symbols.push({
              name: exportedName,
              kind: "export",
              range: [
                sourceFile.getLineAndCharacterOfPosition(spec.getStart()).line + 1,
                sourceFile.getLineAndCharacterOfPosition(spec.getEnd()).line + 1,
              ],
              exported: true,
            });
          }
        }
        return;
      }

      // Recurse into child nodes (but only top-level or namespace bodies)
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return symbols;
  }

  /**
   * Resolve which symbols (and thus which lock keys) a task needs.
   *
   * Matches the task description against parsed symbols to identify
   * which specific functions/classes the task is likely to touch.
   *
   * If unable to determine specific symbols, returns the file paths
   * as-is (file-level locking).
   */
  resolveLocksForTask(targetFiles: string[], description: string): string[] {
    const resolved: string[] = [];

    for (const file of targetFiles) {
      const symbols = this.parseSymbols(file);

      if (symbols.length === 0) {
        // No symbols found — use file-level lock
        resolved.push(file);
        continue;
      }

      // Try to match description keywords against symbol names
      const descLower = description.toLowerCase();
      const matched = symbols.filter((sym) =>
        descLower.includes(sym.name.toLowerCase())
      );

      if (matched.length > 0) {
        for (const sym of matched) {
          resolved.push(`${file}#${sym.name}`);
        }
      } else {
        // Can't match specific symbols — fall back to file-level lock
        resolved.push(file);
      }
    }

    return resolved;
  }

  /**
   * Check if two sets of lock keys conflict.
   *
   * Rules:
   * - Exact match: "auth.ts#login" vs "auth.ts#login" → conflict
   * - File-level trumps symbol-level: "auth.ts" vs "auth.ts#login" → conflict
   * - Different symbols in same file: "auth.ts#login" vs "auth.ts#logout" → no conflict
   */
  hasConflict(locksA: string[], locksB: string[]): boolean {
    for (const a of locksA) {
      for (const b of locksB) {
        if (a === b) return true;

        // If either is a file-level lock, it covers all symbols
        if (!a.includes("#") && b.startsWith(a.split("#")[0])) return true;
        if (!b.includes("#") && a.startsWith(b.split("#")[0])) return true;
      }
    }
    return false;
  }

  /**
   * Extract the file path from a potentially symbol-level lock key.
   * "src/auth.ts#login" → "src/auth.ts"
   * "src/auth.ts" → "src/auth.ts"
   */
  fileFromLockKey(lockKey: string): string {
    return lockKey.includes("#") ? lockKey.split("#")[0] : lockKey;
  }

  /**
   * Extract the symbol name from a symbol-level lock key.
   * "src/auth.ts#login" → "login"
   * "src/auth.ts" → ""
   */
  symbolFromLockKey(lockKey: string): string {
    const parts = lockKey.split("#");
    return parts.length > 1 ? parts[1] : "";
  }

  // ---- helpers ----

  /** Check if a node has the `export` keyword modifier. */
  private static hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    const modifiers = ts.getModifiers(node);
    if (!modifiers) return false;
    return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  }
}
