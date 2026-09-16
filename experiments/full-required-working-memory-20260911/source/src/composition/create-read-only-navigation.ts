import { join } from "node:path";
import { ReadOnlyBash } from "../evidence-agent/adapters/docker/read-only-shell.js";
import type { ReadOnlyNavigationBinding } from "../evidence-agent/index.js";
import { safePathSegment } from "../util.js";

export function createReadOnlyScopeNavigation(
  scopeRoot: string,
  scopeId: string,
): ReadOnlyNavigationBinding {
  return {
    runner: new ReadOnlyBash(),
    scopePath: join(scopeRoot, safePathSegment(scopeId)),
  };
}
