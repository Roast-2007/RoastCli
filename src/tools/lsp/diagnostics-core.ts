import path from 'node:path';
import { statSync } from 'node:fs';
import ts from 'typescript';

import type { FileDiagnostic } from './diagnostics-diff.js';
export { newDiagnostics, type FileDiagnostic } from './diagnostics-diff.js';

interface Project {
  service: ts.LanguageService;
  files: string[];
  options: ts.CompilerOptions;
  texts: Map<string, { text: string; version: number }>;
  configVersion: string;
}
function diskVersion(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

export class DiagnosticsCore {
  private projects = new Map<string, Project>();
  private version = 0;
  check(file: string, text?: string): FileDiagnostic[] {
    const abs = path.resolve(file),
      dir = path.dirname(abs);
    let config: string | undefined;
    for (let current = dir; ; current = path.dirname(current)) {
      config = ['tsconfig.json', 'jsconfig.json'].map((name) => path.join(current, name)).find(ts.sys.fileExists);
      if (config || path.dirname(current) === current) break;
    }
    if (!config) return [];
    let project = this.projects.get(config);
    if (project && project.configVersion !== diskVersion(config)) {
      project.service.dispose();
      this.projects.delete(config);
      project = undefined;
    }
    if (!project) {
      // 解析 tsconfig 会扫描整个目录树，只在首次或配置变化时做；之后新建的文件靠下面的 abs 与 import 解析纳入
      const parsedFile = ts.readConfigFile(config, ts.sys.readFile);
      if (parsedFile.error) throw new Error(ts.flattenDiagnosticMessageText(parsedFile.error.messageText, '\n'));
      const parsed = ts.parseJsonConfigFileContent(parsedFile.config, ts.sys, path.dirname(config));
      const entry: Project = {
        service: undefined as unknown as ts.LanguageService,
        files: parsed.fileNames,
        options: parsed.options,
        texts: new Map(),
        configVersion: diskVersion(config),
      };
      const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => entry.options,
        getScriptFileNames: () => entry.files,
        getScriptVersion: (name) =>
          entry.texts.has(path.resolve(name)) ? `memory:${entry.texts.get(path.resolve(name))!.version}` : diskVersion(name),
        getScriptSnapshot: (name) => {
          const source = entry.texts.get(path.resolve(name))?.text ?? ts.sys.readFile(name);
          return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
        },
        getCurrentDirectory: () => path.dirname(config!),
        getDefaultLibFileName: ts.getDefaultLibFilePath,
        fileExists: (name) => entry.texts.has(path.resolve(name)) || ts.sys.fileExists(name),
        readFile: (name) => entry.texts.get(path.resolve(name))?.text ?? ts.sys.readFile(name),
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
      };
      entry.service = ts.createLanguageService(host);
      project = entry;
    }
    this.projects.delete(config);
    this.projects.set(config, project);
    while (this.projects.size > 2) {
      const oldest = this.projects.keys().next().value!;
      this.projects.get(oldest)!.service.dispose();
      this.projects.delete(oldest);
    }
    if (!project.files.includes(abs)) project.files = [...project.files, abs];
    project.texts.clear();
    if (text !== undefined) project.texts.set(abs, { text, version: ++this.version });
    const source = project.service.getProgram()?.getSourceFile(abs);
    if (!source) return [];
    return [...project.service.getSyntacticDiagnostics(abs), ...project.service.getSemanticDiagnostics(abs)]
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => {
        const position = source.getLineAndCharacterOfPosition(d.start ?? 0);
        return {
          line: position.line + 1,
          column: position.character + 1,
          code: d.code,
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        };
      });
  }
  dispose(): void {
    for (const project of this.projects.values()) project.service.dispose();
    this.projects.clear();
  }
}
