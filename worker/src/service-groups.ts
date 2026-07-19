// #1068 — the FINE service taxonomy (llm / voice / inference / …), exposed per-service on
// `/api/v1/status` as `group` so external consumers that can't import the frontend bundle can derive
// category breakdowns from data (the aiwatch-reports#98 report-breakdown automation is the driver).
//
// This MIRRORS `SERVICE_CATEGORIES.<group>.ids` in `src/utils/constants.js` — the frontend can't be
// imported into the worker bundle (`constants.js` reads `import.meta.env`), so the membership is
// duplicated here and pinned ↔ that source by `service-groups-sync.test.ts`, exactly as
// `api-tier-sync.test.ts` pins `API_TIER` (#403). A drift fails CI, so a new service can't be added to
// one side only.
//
// `all` is a UI-only filter (ids:null) and is intentionally absent here.

export type ServiceGroup =
  | 'llm' | 'agents' | 'voice' | 'inference' | 'observability' | 'video' | 'image' | 'apps'

/** group → member service ids. Same shape + order as SERVICE_CATEGORIES for a clean cross-check. */
export const GROUP_MEMBERS: Record<ServiceGroup, readonly string[]> = {
  llm: ['claude', 'openai', 'gemini', 'bedrock', 'azureopenai', 'mistral', 'cohere', 'groq', 'together', 'fireworks', 'cerebras', 'perplexity', 'xai', 'deepseek', 'kimi', 'openrouter'],
  agents: ['claudecode', 'codex', 'cursor', 'copilot', 'windsurf', 'junie'],
  voice: ['elevenlabs', 'assemblyai', 'deepgram'],
  inference: ['huggingface', 'replicate', 'fal', 'modal', 'voyageai', 'pinecone', 'turbopuffer', 'twelvelabs'],
  observability: ['langsmith', 'helicone', 'langfuse'],
  video: ['runway', 'luma'],
  image: ['stability', 'bfl'],
  apps: ['claudeai', 'chatgpt', 'characterai', 'deepseekapp'],
}

const ID_TO_GROUP: Record<string, ServiceGroup> = Object.fromEntries(
  (Object.entries(GROUP_MEMBERS) as [ServiceGroup, readonly string[]][])
    .flatMap(([group, ids]) => ids.map((id) => [id, group] as const)),
)

/** The fine category for a service id, or `undefined` if unmapped (the sync test guarantees every
 *  monitored SERVICES id IS mapped, so this is `undefined` only for a genuinely unknown id). */
export function serviceGroupOf(id: string): ServiceGroup | undefined {
  return ID_TO_GROUP[id]
}
