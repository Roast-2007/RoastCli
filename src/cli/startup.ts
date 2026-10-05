import { isProjectTrusted } from '../core/config.js';

/** Interactive startup asks once per folder/configuration; scripts never prompt or grant trust. */
export async function ensureFolderTrust(cwd: string, interactive: boolean, confirm: (cwd: string) => Promise<boolean>): Promise<boolean> {
  if (!interactive || isProjectTrusted(cwd)) return true;
  return confirm(cwd);
}
