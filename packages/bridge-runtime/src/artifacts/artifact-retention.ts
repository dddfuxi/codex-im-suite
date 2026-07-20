import fs from 'node:fs';
import path from 'node:path';

import { normalizeTurnSegment, type TurnScope } from './session-scratch.js';

export interface PruneExpiredArtifactTurnsInput {
  artifactRoot: string;
  now?: Date;
  maxAgeMs: number;
  activeScopes?: readonly TurnScope[];
}

export function pruneExpiredArtifactTurns(input: PruneExpiredArtifactTurnsInput): { removed: string[]; preserved: string[] } {
  const root = path.resolve(input.artifactRoot);
  const now = input.now || new Date();
  const active = new Set((input.activeScopes || []).map((scope) => (
    `${normalizeTurnSegment(scope.sessionId, 'session')}\0${normalizeTurnSegment(scope.turnId, 'turn')}`
  )));
  const removed: string[] = [];
  const preserved: string[] = [];
  if (!fs.existsSync(root)) return { removed, preserved };
  for (const sessionEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) continue;
    const sessionPath = path.join(root, sessionEntry.name);
    for (const turnEntry of fs.readdirSync(sessionPath, { withFileTypes: true })) {
      if (!turnEntry.isDirectory() || turnEntry.isSymbolicLink()) continue;
      const turnPath = path.join(sessionPath, turnEntry.name);
      const key = `${sessionEntry.name}\0${turnEntry.name}`;
      const expired = now.getTime() - fs.statSync(turnPath).mtimeMs > Math.max(0, input.maxAgeMs);
      if (!expired || active.has(key)) {
        preserved.push(turnPath);
        continue;
      }
      fs.rmSync(turnPath, { recursive: true, force: false });
      removed.push(turnPath);
    }
    if (fs.readdirSync(sessionPath).length === 0) fs.rmdirSync(sessionPath);
  }
  return { removed, preserved };
}
