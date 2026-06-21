import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import type { SymbolDef, ImportInfo } from "../data/models";

/**
 * PythonSymbolExtractor — extracts symbols from Python files using Python's
 * built-in `ast` module via subprocess.
 *
 * Same public API as SymbolExtractor:
 *   extract(filePath) → { symbols, imports } | null
 *   hashFile(filePath) → hex string
 *
 * Zero new npm dependencies — the Python script is embedded as a template
 * literal and piped to `python -c` via stdin.
 */
export class PythonSymbolExtractor {
  private static readonly PY_EXTS = new Set([".py"]);

  /**
   * Extract symbols and imports from a Python file.
   * Returns null for non-`.py` files, empty files, or parse failures.
   */
  extract(filePath: string): { symbols: SymbolDef[]; imports: ImportInfo[] } | null {
    if (!fs.existsSync(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase();
    if (!PythonSymbolExtractor.PY_EXTS.has(ext)) return null;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }

    if (content.trim().length === 0) return null;

    const raw = PythonSymbolExtractor.runPythonVisitor(content, filePath);
    if (!raw) return null;

    // Validate each symbol minimally
    const symbols = (raw as any).symbols as SymbolDef[] ?? [];
    const imports = (raw as any).imports as ImportInfo[] ?? [];

    return { symbols, imports };
  }

  /**
   * Compute SHA-256 content hash (first 16 hex chars).
   * Byte-identical to SymbolExtractor.hashFile — ensures incremental
   * indexing works transparently for both TS and Python files.
   */
  static hashFile(filePath: string): string {
    try {
      const content = fs.readFileSync(filePath);
      return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    } catch {
      return "hash-error";
    }
  }

  // ---- Subprocess ----

  /**
   * Spawn Python with the embedded AST visitor script, piping file content
   * via stdin, and return parsed JSON output.
   */
  private static runPythonVisitor(
    fileContent: string,
    filePath: string
  ): { symbols: SymbolDef[]; imports: ImportInfo[] } | null {
    // Prefer python3 on Unix, plain python on Windows
    const pythonBin = process.platform === "win32" ? "python" : "python3";

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(pythonBin, ["-c", PYTHON_VISITOR_SCRIPT], {
        input: fileContent,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        timeout: 15_000,              // 15 seconds per file
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      console.warn(`[laol] Failed to spawn Python for ${filePath}: ${err}`);
      return null;
    }

    if (result.error) {
      // ENOENT or spawn error — Python not installed / not on PATH
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn("[laol] Python not found on PATH — skipping Python indexing");
      } else {
        console.warn(`[laol] Python subprocess error for ${filePath}: ${result.error.message}`);
      }
      return null;
    }

    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      if (stderr) {
        console.warn(`[laol] Python parse error in ${filePath}: ${stderr.slice(0, 200)}`);
      }
      return null;
    }

    const stdout = String(result.stdout ?? "").trim();
    if (!stdout) return null;

    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.symbols)) {
        return {
          symbols: parsed.symbols as SymbolDef[],
          imports: (parsed.imports ?? []) as ImportInfo[],
        };
      }
      return null;
    } catch {
      console.warn(`[laol] Python output for ${filePath} is not valid JSON`);
      return null;
    }
  }
}

// ====================================================================
// Embedded Python AST visitor script
// ====================================================================
// This script reads Python source from stdin, parses it with ast.parse(),
// walks the AST to extract symbols/imports/calls/docstrings, and prints
// the result as JSON to stdout.
//
// Supports:
//   - Module-level docstring → module symbol
//   - def / async def → function symbols with params, return type, calls
//   - class → class symbol; methods extracted as separate symbols
//   - Top-level assignments → const / decorator symbols
//   - Annotated assignments (PEP 526) → const + @type tag
//   - Imports (import x, from y import z) → ImportInfo
//   - Docstrings in Sphinx (:param, :returns) and Google (Args, Returns) styles
//   - Decorators → jsDoc.tags entries
//   - Type hints → parameter types and return types
//   - Python 3.8+ compatible (with ast.unparse fallback)
// ====================================================================

const PYTHON_VISITOR_SCRIPT = `
import ast, json, sys

def _get_docstring(node):
    """Extract jsDoc-like info from a Python docstring (Sphinx + Google hybrid)."""
    doc = ast.get_docstring(node)
    if not doc:
        return None
    lines = doc.strip().split('\\n')
    desc_lines = []
    params = []
    returns = ''
    tags = []
    current_param = None
    in_returns = False

    for line in lines:
        s = line.strip()
        if s.startswith(':param '):
            current_param = None; in_returns = False
            rest = s[7:]
            if ':' in rest:
                idx = rest.index(':')
                name = rest[:idx].strip()
                text = rest[idx+1:].strip()
                params.append({'name': name, 'text': text})
                current_param = name
            else:
                params.append({'name': rest.strip(), 'text': ''})
                current_param = rest.strip()
        elif s.startswith(':returns:') or s.startswith(':return:'):
            current_param = None; in_returns = True
            desc = s.split(':', 2)[-1].strip()
            returns = desc
        elif s.startswith(':raises') or s.startswith(':rtype') or s.startswith(':type'):
            current_param = None; in_returns = False
            colon = s.index(':')
            space = s.index(' ', colon + 1) if ' ' in s[colon+1:] else len(s)
            tag_name = s[1:space].rstrip(':')
            tag_text = s[space:].strip()
            tags.append({'name': tag_name, 'text': tag_text})
        elif s.lower().startswith('args:') or s.lower().startswith('arguments:'):
            current_param = None; in_returns = False
            tags.append({'name': 'args_style', 'text': 'google'})
        elif s.lower().startswith('returns:') and not s.startswith(':returns'):
            current_param = None; in_returns = True
            desc = s.split(':', 1)[-1].strip()
            returns = desc
        else:
            if s and current_param and not in_returns:
                for p in params:
                    if p['name'] == current_param:
                        p['text'] += ' ' + s; break
            elif s and in_returns:
                returns += ' ' + s
            elif s:
                desc_lines.append(s)

    result = {
        'description': ' '.join(desc_lines),
        'tags': tags,
        'params': params,
        'returns': returns
    }
    if result['description'] or result['tags'] or result['params'] or result['returns']:
        return result
    return None

def _type_to_str(node):
    """Convert an AST annotation node to a string."""
    if node is None:
        return None
    try:
        return ast.unparse(node)  # Python 3.9+
    except AttributeError:
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Constant):
            return repr(node.value)
        elif isinstance(node, ast.Subscript):
            return _type_to_str(node.value) + '[' + _type_to_str(node.slice) + ']'
        elif isinstance(node, ast.Attribute):
            return _type_to_str(node.value) + '.' + node.attr
        elif isinstance(node, ast.Tuple):
            return '[' + ', '.join(_type_to_str(e) for e in node.elts) + ']'
        elif isinstance(node, ast.BinOp):
            return _type_to_str(node.left) + ' | ' + _type_to_str(node.right)
        return str(node)

def _default_to_str(node):
    """Convert a default value AST node to string."""
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except AttributeError:
        return repr(node.value) if isinstance(node, ast.Constant) else str(node)

class _CallCollector(ast.NodeVisitor):
    """Collect call names + line numbers, stop at nested function/class."""
    def __init__(self):
        self.calls = []
        self._seen = set()

    def visit_Call(self, node):
        name = None
        if isinstance(node.func, ast.Name):
            name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            name = node.func.attr
        if name:
            key = f"{name}:{node.lineno}"
            if key not in self._seen:
                self._seen.add(key)
                self.calls.append({'name': name, 'line': node.lineno})
        self.generic_visit(node)

    def visit_FunctionDef(self, node): pass
    def visit_AsyncFunctionDef(self, node): pass
    def visit_ClassDef(self, node): pass
    def visit_Lambda(self, node): pass

class _SymbolVisitor(ast.NodeVisitor):
    def __init__(self, line_count):
        self.symbols = []
        self.imports = []
        self._line_count = line_count

    def _make_symbol(self, name, kind, lineno, end_lineno, **kw):
        if 'exported' not in kw:
            kw['exported'] = not name.startswith('_')
        sym = {
            'name': name,
            'kind': kind,
            'range': [lineno, end_lineno or lineno],
            'exported': kw.pop('exported'),
        }
        for k, v in kw.items():
            if v is not None:
                sym[camel(k)] = v
        return sym

    def _decorator_tags(self, node):
        tags = []
        for dec in getattr(node, 'decorator_list', []):
            try:  text = ast.unparse(dec)
            except AttributeError: text = str(dec)
            tags.append({'name': 'decorator', 'text': text})
        return tags

    def _extract_params(self, node):
        def _strip_none(d):
            return {k: v for k, v in d.items() if v is not None}
        params = []
        args = node.args
        num_no_default = len(args.args) - len(args.defaults)
        for i, arg in enumerate(args.args):
            has_default = i >= num_no_default
            dv = _default_to_str(args.defaults[i - num_no_default]) if has_default else None
            params.append(_strip_none({
                'name': arg.arg,
                'type': _type_to_str(arg.annotation) or 'any',
                'optional': has_default,
                'isRest': False,
                'defaultValue': dv,
            }))
        if args.vararg:
            params.append(_strip_none({
                'name': '*' + args.vararg.arg,
                'type': _type_to_str(args.vararg.annotation) or 'any',
                'optional': False,
                'isRest': True,
                'defaultValue': None,
            }))
        if args.kwarg:
            params.append(_strip_none({
                'name': '**' + args.kwarg.arg,
                'type': _type_to_str(args.kwarg.annotation) or 'any',
                'optional': False,
                'isRest': False,
                'defaultValue': None,
            }))
        return params

    def _collect_calls(self, node):
        c = _CallCollector()
        for stmt in node.body:
            if not isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                c.visit(stmt)
        return c.calls

    def _visit_function(self, node, is_async=False):
        jsdoc = _get_docstring(node)
        dtags = self._decorator_tags(node)
        if is_async: dtags.append({'name': 'async', 'text': 'true'})
        if jsdoc:
            jsdoc['tags'] = dtags + jsdoc.get('tags', [])
        elif dtags:
            jsdoc = {'description': '', 'tags': dtags, 'params': [], 'returns': ''}
        params = self._extract_params(node)
        ret = _type_to_str(node.returns)
        calls = self._collect_calls(node)
        sym = self._make_symbol(node.name, 'function', node.lineno, node.end_lineno,
                                jsDoc=jsdoc, parameters=params, returnType=ret, calls=calls)
        self.symbols.append(sym)

    def visit_FunctionDef(self, node):
        self._visit_function(node, False)

    def visit_AsyncFunctionDef(self, node):
        self._visit_function(node, True)

    def visit_ClassDef(self, node):
        jsdoc = _get_docstring(node)
        dtags = self._decorator_tags(node)
        if jsdoc:
            jsdoc['tags'] = dtags + jsdoc.get('tags', [])
        elif dtags:
            jsdoc = {'description': '', 'tags': dtags, 'params': [], 'returns': ''}
        insert_at = len(self.symbols)
        all_calls = []
        for stmt in node.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.visit(stmt)
                if self.symbols:
                    all_calls.extend(self.symbols[-1].get('calls', []))
        sym = self._make_symbol(node.name, 'class', node.lineno, node.end_lineno,
                                jsDoc=jsdoc, calls=all_calls[:50])
        self.symbols.insert(insert_at, sym)

    def visit_Assign(self, node):
        is_decorator = isinstance(node.value, ast.Call)
        for t in node.targets:
            if isinstance(t, ast.Name):
                self.symbols.append(self._make_symbol(
                    t.id, 'decorator' if is_decorator else 'const',
                    node.lineno, node.end_lineno))
            elif isinstance(t, ast.Tuple):
                for e in t.elts:
                    if isinstance(e, ast.Name):
                        self.symbols.append(self._make_symbol(
                            e.id, 'const', node.lineno, node.end_lineno))

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name):
            jsdoc = None
            if node.annotation:
                jsdoc = {'description': '', 'tags': [
                    {'name': 'type', 'text': _type_to_str(node.annotation) or 'unknown'}
                ], 'params': [], 'returns': ''}
            self.symbols.append(self._make_symbol(
                node.target.id, 'const', node.lineno, node.end_lineno, jsDoc=jsdoc))

    def visit_Import(self, node):
        for a in node.names:
            self.imports.append({
                'moduleSpecifier': a.name,
                'namedImports': [],
                'defaultImport': a.asname or a.name,
                'namespaceImport': None,
            })

    def visit_ImportFrom(self, node):
        named = [a.name for a in node.names if a.name != '*']
        self.imports.append({
            'moduleSpecifier': node.module or '',
            'namedImports': named,
            'defaultImport': None,
            'namespaceImport': None,
        })

    def visit_Module(self, node):
        self.generic_visit(node)
        # Insert module symbol at head
        mdoc = _get_docstring(node)
        self.symbols.insert(0, self._make_symbol(
            '<module>', 'module', 1, self._line_count or 1,
            exported=True, jsDoc=mdoc))

# Camel-case: jsDoc, returnType
def camel(k):
    if k == 'jsDoc': return 'jsDoc'
    if k == 'returnType': return 'returnType'
    if k == 'isRest': return 'isRest'
    return k

if __name__ == '__main__':
    code = sys.stdin.read()
    if not code.strip():
        json.dump({'symbols': [], 'imports': []}, sys.stdout)
        sys.exit(0)
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        sys.stderr.write(f'SyntaxError: {e}\\n')
        sys.exit(1)
    visitor = _SymbolVisitor(len(code.split('\\n')))
    visitor.visit(tree)
    json.dump({'symbols': visitor.symbols, 'imports': visitor.imports},
              sys.stdout, ensure_ascii=False)
`;
