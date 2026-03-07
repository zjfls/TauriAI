export const SYSTEM_PRACTICE_AGENT_NAME = "__system_practice";
export const SYSTEM_PRACTICE_AGENT_LABEL = "练习专用 Agent";

type GenericAgentLike = {
  name?: unknown;
  type?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  modelRef?: unknown;
  model_ref?: unknown;
  enabled?: unknown;
};

type GenericProviderLike = {
  name?: unknown;
  displayName?: unknown;
  display_name?: unknown;
};

export type PracticeAgentPresentation = {
  name: string;
  label: string;
  modelRef: string;
  modelLabel: string;
  enabled: boolean;
};

function readAgentName(agent: GenericAgentLike | null | undefined): string {
  return String(agent?.name ?? "").trim();
}

function readAgentType(agent: GenericAgentLike | null | undefined): string {
  return String(agent?.type ?? "").trim();
}

export function isPracticeAgentLike(agent: GenericAgentLike | null | undefined): boolean {
  const name = readAgentName(agent);
  const type = readAgentType(agent);
  return type === "practice" || name === SYSTEM_PRACTICE_AGENT_NAME;
}

export function filterNonPracticeAgents<T>(agents: T[] | null | undefined): T[] {
  if (!Array.isArray(agents)) return [];
  return agents.filter((agent) => !isPracticeAgentLike(agent as GenericAgentLike));
}

export function formatAgentModelLabel(
  modelRef: string,
  providerDisplayNameById: Map<string, string> = new Map(),
): string {
  const ref = String(modelRef || "").trim();
  if (!ref) return "";
  const idx = ref.indexOf("/");
  if (idx <= 0) return ref;
  const providerId = ref.slice(0, idx).trim();
  const modelName = ref.slice(idx + 1).trim();
  if (!providerId || !modelName) return ref;
  const providerLabel = providerDisplayNameById.get(providerId) || providerId;
  return `${providerLabel}/${modelName}`;
}

export function resolvePracticeAgentPresentation(config: any): PracticeAgentPresentation {
  const providerDisplayNameById = new Map<string, string>();
  const providers: GenericProviderLike[] = Array.isArray(config?.providers) ? config.providers : [];
  for (const provider of providers) {
    if (!provider || typeof provider !== "object") continue;
    const name = String(provider.name ?? "").trim();
    if (!name) continue;
    const displayName = String(provider.displayName ?? provider.display_name ?? name).trim();
    providerDisplayNameById.set(name, displayName || name);
  }

  const agents: GenericAgentLike[] = Array.isArray(config?.agents) ? config.agents : [];
  const practiceAgent = agents.find((agent) => isPracticeAgentLike(agent));
  if (!practiceAgent) {
    return {
      name: SYSTEM_PRACTICE_AGENT_NAME,
      label: SYSTEM_PRACTICE_AGENT_LABEL,
      modelRef: "",
      modelLabel: "",
      enabled: false,
    };
  }

  const name = readAgentName(practiceAgent) || SYSTEM_PRACTICE_AGENT_NAME;
  const label = String(
    practiceAgent.displayName ?? practiceAgent.display_name ?? SYSTEM_PRACTICE_AGENT_LABEL,
  ).trim() || SYSTEM_PRACTICE_AGENT_LABEL;
  const modelRef = String(practiceAgent.modelRef ?? practiceAgent.model_ref ?? "").trim();
  const enabled = typeof practiceAgent.enabled === "boolean" ? practiceAgent.enabled : true;

  return {
    name,
    label,
    modelRef,
    modelLabel: formatAgentModelLabel(modelRef, providerDisplayNameById),
    enabled,
  };
}
