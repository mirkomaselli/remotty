import { existsSync, readdirSync, statSync } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import type { RequestHandler } from 'express';
import type { BrowseResult, DirEntry } from '@remotty/shared';
import type { AppConfig } from './config.js';

/**
 * GET /api/fs/browse?path=<abs>
 * Directory listing only — never reads files. Absolute paths only, UNC rejected.
 */
export function createBrowseHandler(config: AppConfig): RequestHandler {
  return (req, res) => {
    const q = req.query.path;
    if (q === undefined || q === '') {
      res.json(rootsListing(config));
      return;
    }
    if (typeof q !== 'string' || !path.isAbsolute(q)) {
      res.status(400).json({ error: 'path must be an absolute path' });
      return;
    }
    if (q.startsWith('\\\\') || q.startsWith('//')) {
      res.status(400).json({ error: 'UNC paths are not supported' });
      return;
    }
    const p = path.resolve(q);
    let st: Stats;
    try {
      st = statSync(p);
    } catch {
      res.status(404).json({ error: 'path not found' });
      return;
    }
    if (!st.isDirectory()) {
      res.status(400).json({ error: 'not a directory' });
      return;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      res.status(403).json({ error: 'cannot read directory' });
      return;
    }

    const dirs: DirEntry[] = [];
    for (const d of entries) {
      try {
        if (!d.isDirectory()) continue; // symlinked dirs skipped — acceptable v1
        if (d.name.startsWith('.')) continue;
        const full = path.join(p, d.name);
        dirs.push({ name: d.name, path: full, isGitRepo: existsSync(path.join(full, '.git')) });
      } catch {
        // EACCES/EPERM on a single entry — skip silently
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parentDir = path.dirname(p);
    const result: BrowseResult = {
      path: p,
      parent: parentDir === p ? null : parentDir,
      dirs,
    };
    res.json(result);
  };
}

function rootsListing(config: AppConfig): BrowseResult {
  const dirs: DirEntry[] = config.defaultRoots.map((r) => ({
    name: path.basename(r) || r,
    path: r,
    isGitRepo: existsSync(path.join(r, '.git')),
  }));
  if (process.platform === 'win32') {
    // C:..Z: only — probing A:/B: can hit legacy floppy device timeouts.
    for (let c = 0x43; c <= 0x5a; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      try {
        if (statSync(drive).isDirectory()) {
          dirs.push({ name: drive, path: drive, isGitRepo: false });
        }
      } catch {
        // drive letter not mounted
      }
    }
  }
  return { path: '', parent: null, dirs };
}
