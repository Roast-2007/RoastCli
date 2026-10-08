import { existsSync } from 'node:fs';
import path from 'node:path';
import { INSTRUCTION_FILE_NAMES } from '../ext/instructions.js';

export function initTarget(cwd: string): string {
  return INSTRUCTION_FILE_NAMES.find((name) => existsSync(path.join(cwd, name))) ?? 'ROAST.md';
}

export function initPrompt(target: string): string {
  return `Analyze this repository and generate or improve ${target} in the current working directory.
Read README, package manifests (package.json, pyproject.toml, Cargo.toml, go.mod, etc.) and lockfiles, CI workflows, lint/format/test configuration, directory structure, and existing instructions (ROAST.md, AGENTS.md, CLAUDE.md, .cursorrules, .github/copilot-instructions.md).
Include a project overview (1–3 lines), confirmed commands for install/develop/build/test/single-test/lint/format, key directories and entry points, non-obvious conventions, and concrete pitfalls. Only document commands verified in configuration. Keep the whole file around 150 lines or fewer. Avoid generic advice, exhaustive file lists, and secrets.
If the file exists, improve it in place, preserve the user's content and structure, and preserve the entire "## 记忆" section verbatim. Use edit for minimal changes.
Inspect using read tools and read-only commands (such as git log -n 20 --oneline). Do not run installation, build, or other modifying commands. The only allowed file modification is the target instruction file.
Follow the language of existing documentation, defaulting to README's language. End with a brief explanation of what changed.`;
}
