import type ts from 'typescript';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { canonicalPath, isPathInside, resolveUserPath } from '../../core/paths.js';

/** Uses the same semantic language service as tsserver; no external process is needed. */
export async function languageService(cwd: string, file: string) {
  const ts = (await import('typescript')).default;
  const root = canonicalPath(cwd),
    abs = resolveUserPath(cwd, file);
  if (!isPathInside(root, abs)) throw new Error('语义工具只支持当前工作区内的文件');
  if (!/\.[cm]?[jt]sx?$/.test(abs)) throw new Error('内置语义工具支持 TypeScript/JavaScript；其他语言可通过 MCP LSP 服务器接入');
  const configFile =
    ts.findConfigFile(path.dirname(abs), ts.sys.fileExists) ?? ts.findConfigFile(path.dirname(abs), ts.sys.fileExists, 'jsconfig.json');
  let options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  let files: string[];
  if (configFile && isPathInside(root, configFile)) {
    const read = ts.readConfigFile(configFile, ts.sys.readFile);
    if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile));
    options = parsed.options;
    files = parsed.fileNames;
  } else {
    files = ts.sys.readDirectory(
      root,
      ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
      ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/logs/**'],
    );
  }
  if (!files.some((value) => canonicalPath(value) === canonicalPath(abs))) files.push(abs);
  const texts = new Map<string, string>();
  const text = (name: string) => {
    const key = canonicalPath(name);
    if (!texts.has(key)) texts.set(key, readFileSync(name, 'utf8'));
    return texts.get(key)!;
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => files,
    getScriptVersion: () => '0',
    getScriptSnapshot: (name) => {
      if (!ts.sys.fileExists(name)) return undefined;
      return ts.ScriptSnapshot.fromString(text(name));
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const validIdentifier = (name: string) => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name);
    return scanner.scan() === ts.SyntaxKind.Identifier && scanner.scan() === ts.SyntaxKind.EndOfFileToken;
  };
  return { service: ts.createLanguageService(host), abs, text, validIdentifier };
}

export function positionOf(text: string, line: number, column: number): number {
  const lines = lineStarts(text);
  const start = lines[line - 1];
  if (start === undefined) throw new Error('line 超出文件范围');
  const end = (lines[line] ?? text.length) - (line < lines.length ? 1 : 0);
  if (start + column - 1 > end) throw new Error('column 超出行范围（列按 UTF-16 字符计数）');
  return start + column - 1;
}
export function lineColumn(text: string, position: number) {
  const starts = lineStarts(text);
  let line = 0;
  while (line + 1 < starts.length && starts[line + 1]! <= position) line++;
  return { line: line + 1, column: position - starts[line]! + 1 };
}
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}
