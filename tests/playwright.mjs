// Prefer a project install; fall back to Playwright already installed in a DSH profile.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
const projectRequire = createRequire(import.meta.url);
export function loadPlaywright() {
  let resolved;
  try { resolved = projectRequire.resolve('playwright'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  if (resolved) return projectRequire(resolved);
  const dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const profile = process.env.DSH_PROFILE || 'desktop';
  const profileRequire = createRequire(path.join(dshHome, 'profiles', profile, 'package.json'));
  try { resolved = profileRequire.resolve('playwright'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    throw new Error('Playwright is required for verification. Run npm install --no-save playwright in this project, or select a DSH profile with DSH_HOME / DSH_PROFILE.', { cause: error });
  }
  return profileRequire(resolved);
}
