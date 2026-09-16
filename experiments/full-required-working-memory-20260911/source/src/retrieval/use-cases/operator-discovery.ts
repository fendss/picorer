import type { SearchOperatorDefinitionStep, SearchOperatorInput } from "../model/operator.js";

interface DiscoveryPolicy {
  roles?: SearchOperatorInput["roles"];
  maxPerSession?: number;
}

export function intersectRoles(
  left: SearchOperatorInput["roles"],
  right: SearchOperatorInput["roles"],
): SearchOperatorInput["roles"] {
  if (left === undefined) return right === undefined ? undefined : [...right];
  if (right === undefined) return [...left];
  return left.filter((role) => right.includes(role));
}

/** Push constraints only when every consumer of a shared source permits them. */
export function discoveryPolicies(
  steps: readonly SearchOperatorDefinitionStep[],
  output: string,
): Map<string, DiscoveryPolicy> {
  const policies = new Map<string, DiscoveryPolicy>([[output, {}]]);
  const add = (id: string, policy: DiscoveryPolicy): void => {
    const previous = policies.get(id);
    if (previous === undefined) {
      policies.set(id, policy);
      return;
    }
    policies.set(id, {
      ...(previous.roles === undefined || policy.roles === undefined ? {} : {
        roles: [...new Set([...previous.roles, ...policy.roles])],
      }),
      ...(previous.maxPerSession === undefined || policy.maxPerSession === undefined ? {} : {
        maxPerSession: Math.max(previous.maxPerSession, policy.maxPerSession),
      }),
    });
  };
  for (const step of [...steps].reverse()) {
    const policy = policies.get(step.id)!;
    if (step.kind === "search") continue;
    if (step.kind === "combine") {
      step.inputs.forEach((id) => add(id, step.limit === undefined ? policy : {}));
      continue;
    }
    if (step.kind === "filter") {
      add(step.input, { ...policy, roles: intersectRoles(policy.roles, step.roles)! });
    } else if (step.kind === "diversify") {
      // A later filter cannot replace a record already chosen by this cap.
      add(step.input, { maxPerSession: step.maxPerGroup });
    } else if (step.kind === "limit" || step.kind === "sort" || step.kind === "dedupe") {
      // These nodes establish which records survive. Moving a later filter/cap
      // ahead of them would change the declared program's meaning.
      add(step.input, {});
    } else {
      add(step.input, policy);
    }
  }
  return policies;
}
