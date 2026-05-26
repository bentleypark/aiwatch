# Service Status Determination

Per-service status is resolved in `worker/src/services.ts` with this priority:

1. **Multi-component worst-of** (`statusComponentIds`, #379): when configured, look up each id in the page's `components`, normalize each, and pick the worst (`down` > `degraded` > `operational`). Used for coding agents whose user-facing surface spans multiple components — e.g. Cursor IDE primary + Cloud Agents + Automations + CLI; Claude Code component + Claude API dependency. `statusComponentId` (singular) remains the *primary* component for uptime parsing, calendar days, and component-miss alerting; `statusComponentIds` is purely for badge resolution. Convention: list the primary as the first entry of `statusComponentIds`. If none of the ids resolve in the components list, falls through to step 2.
2. **Component match** (`statusComponentId` or `statusComponent`): use that component's status
3. **Component not found**: fall back to overall page indicator
4. **No component configured**: use overall indicator, BUT if no relevant unresolved incidents matched after `incidentExclude`/`incidentKeywords` filtering, treat as `operational` (prevents cross-contamination from unrelated incidents on shared status pages, e.g., ChatGPT incident should not affect OpenAI API status)
5. **`incidentExclude` component bypass** (#359): when an `incidentExclude` pattern matches the incident title, check if the incident's `componentNames` starts with `config.statusComponent` — if it does, include the incident anyway. Prevents "claude.ai and API unavailable" from being dropped from Claude API just because the title contains "claude.ai". Component tagging is more authoritative than title substring matching.
6. **Component-status incident filter** (`filterByComponentStatus`): if component is `operational` but provider bulk-linked incidents to all components, remove unresolved incidents (keep resolved + monitoring). Prevents e.g., Anthropic admin API incident from showing on claude.ai/Claude Code when their components are healthy
7. **Status page fetch failure cross-validation** (post-processing in `fetchAllServices`):
   - If service is `degraded` from fetch failure (no incidents) AND probe RTT is normal → override to `operational`
   - If 70%+ of services on the same platform (Atlassian/incident.io/etc.) fail simultaneously → platform outage → override all to `operational`
   - Conservative: only overrides when evidence is strong (≥2 recent probes healthy, or quorum failure detected)
