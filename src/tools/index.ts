// Tool registry. Single source of truth for which tools are advertised via
// tools/list and dispatched via tools/call.
//
// Brand Rule #2 enforced by tests/manifest.snapshot.test.ts (forbidden-
// string snapshot). Every Tool.description here goes into the
// tools/list response that MCP clients render to end users, so it MUST stay
// free of file paths, TypeScript identifiers, story IDs, and implementation
// prose. Descriptions are sourced from the parent repo positioning doc per
// Brand Rule #1.

import { coordinationHeat } from './coordination-heat';
import { verityScore } from './verity-score';
import { morningBrief } from './morning-brief';
import { verityScan } from './verity-scan';
import { crossCheckAlert } from './cross-check-alert';
import { disinfoAlert } from './disinfo-alert';

export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  requiresAuth: boolean;
  upstreamPath: string;
}

// Order is fixed to match manifest.json.tools[]. The forbidden-string
// snapshot test asserts both files have the same six tool names in the
// same order so a marketplace consumer can rely on positional stability.
//
// `as const satisfies readonly Tool[]` keeps the literal types narrow so
// each entry's name is the exact literal (not widened to `string`). Adding
// a 7th tool here that is missing from src/upstream.ts:TOOL_ROUTES is a
// compile error (the parity check below depends on this).
export const TOOLS = [
  coordinationHeat,
  verityScore,
  morningBrief,
  verityScan,
  crossCheckAlert,
  disinfoAlert,
] as const satisfies readonly Tool[];

// No name-keyed lookup is exported here: the JSON-RPC dispatcher in
// src/mcp.ts narrows the inbound tool name through src/upstream.ts:
// isKnownTool + TOOL_ROUTES, which is the single source of truth for
// dispatch. The tests/manifest.snapshot.test.ts parity check enforces
// that TOOLS and TOOL_ROUTES carry the same six names.
