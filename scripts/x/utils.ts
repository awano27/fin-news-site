import fs from 'node:fs';

export function assertFileExistsOrThrow(p: string, msg?: string) {
  if (!fs.existsSync(p)) {
    throw new Error(msg || `File not found: ${p}`);
  }
}