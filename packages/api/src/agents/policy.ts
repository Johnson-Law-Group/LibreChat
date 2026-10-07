import type { Agent, AgentModelParameters, TCustomConfig } from 'librechat-data-provider';

type ModelPolicy = NonNullable<TCustomConfig['modelPolicy']>;
type PolicyParameters = {
  model?: string | null;
  maxContextTokens?: AgentModelParameters['maxContextTokens'];
};

/** Resolves endpoint-scoped aliases, including chains created by successive retirements. */
export function resolveModelAlias(model: string, endpoint: string, policy?: ModelPolicy): string {
  const aliases = policy?.aliases?.[endpoint];
  const seen = new Set<string>();
  let resolved = model;
  while (aliases && Object.prototype.hasOwnProperty.call(aliases, resolved)) {
    if (seen.has(resolved)) {
      throw new Error(`Cyclic model alias for ${endpoint}`);
    }
    seen.add(resolved);
    const next = aliases[resolved];
    if (next == null) {
      break;
    }
    resolved = next;
  }
  return resolved;
}

/** Caps request and persisted context settings while preserving smaller valid budgets. */
export function applyModelPolicy<T extends PolicyParameters>(
  parameters: T,
  endpoint: string,
  policy?: ModelPolicy,
): T {
  if (!policy) {
    return parameters;
  }
  const model = parameters.model
    ? resolveModelAlias(parameters.model, endpoint, policy)
    : parameters.model;
  const cap = policy.maxContextTokens;
  const requested = parameters.maxContextTokens;
  const maxContextTokens =
    cap == null
      ? requested
      : Math.min(
          typeof requested === 'number' && Number.isFinite(requested) && requested > 0
            ? requested
            : cap,
          cap,
        );
  return { ...parameters, model, ...(maxContextTokens != null ? { maxContextTokens } : {}) };
}

/** Applies policy to a runtime agent without changing its stored definition or history. */
export function applyAgentModelPolicy(agent: Agent, policy?: ModelPolicy): Agent {
  if (!policy) {
    return agent;
  }
  const parameters = applyModelPolicy(
    { ...agent.model_parameters, model: agent.model ?? undefined },
    agent.provider,
    policy,
  );
  return { ...agent, model: parameters.model ?? agent.model, model_parameters: parameters };
}
