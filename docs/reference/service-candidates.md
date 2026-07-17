---
type: reference
title: "Service-addition candidates — what to add, by category"
description: "The candidate registry for new monitored services: per-category shortlists with their status-page platform, plus the categories already closed and the sources deliberately declined."
tags: [services, candidates, coverage, fallback]
---

# Service-addition candidates — what to add, by category

The canonical "what could we add next" list. It is a **registry, not a plan** — nothing here is
committed work. Each row is a candidate whose status page was checked for parseability at the date
noted on its section.

**This list does not authorize an add.** Before writing any code for a candidate, run the **Step-0
data-richness audit** in [Adding a New Service](adding-a-service.md)
and record the verdict in the issue. A row here means "the page is parseable", which is a far weaker
claim than "the source carries real signal" — a page can be perfectly parseable and still publish no
uptime and no incidents (see the declined gcloud sources below).

**Monitorability** = a public status page in a format AIWatch already parses: Atlassian Statuspage
(`/api/v2/summary.json`) · incident.io · Instatus · Better Stack (`/index.json` + RSS) · RSS.

> **Currency.** The platform labels below were live-verified **2026-06-11** (the Inference row
> 2026-06-23); rows re-checked since carry their own date inline. Providers migrate status pages —
> re-verify the platform at Step-0 rather than trusting a label here. In particular, a Statuspage-compatible `summary.json` does **not** prove Atlassian;
> incident.io serves one too, and reading it wrong silently drops the service's uptime
> ([adding-a-service.md §0](adding-a-service.md), #857).

## Why these categories

A category with only ONE monitored service cannot get a sensible fallback recommendation during an
outage. `getFallbacks` filters candidates by the **coarse** worker `category` (`'api'`) and then
orders by `API_TIER` distance — so a solo service isn't short of candidates, it gets wrongly-tiered
ones. Two outcomes, both bad: it sits in `EXCLUDE_FALLBACK` and returns nothing (Voyage AI today); or
it is fallback-eligible and gets a semantically wrong cross-category pick (Runway was offered
`openrouter`, an LLM router). A third is latent rather than live: since #859 capped the specialized
sub-tiers (4–10) to same-tier-only, giving a solo service its own sub-tier would make `sameTierOnly`
return `[]` — no service is in that state today (every *populated* specialized tier, 4–8, has ≥2
members; 9 and 10 are unused), but it is the trap waiting for whoever adds tier 9. Adding a sibling is the prerequisite for a category-aware sub-tier. Tracking issue: #601; tier membership: [fallback-tiers.md](fallback-tiers.md).

## Pick order

Three kinds of candidate, and they are not comparable:

1. **The last remaining gap — [embeddings](#embeddings--open-voyage-ai-is-still-solo).** Voyage AI is
   solo, so any sibling closes it; **#880 targets Jina AI**, with Nomic as the alternative. This is the
   only row that buys a fallback *capability*.
2. **The unseeded category — [Search / RAG](#search--rag--new-category-not-yet-seeded).** #392 (Tavily)
   is neither a gap-closer nor a 3rd sibling: nothing is monitored there at all. It lands under
   `inference` until an Exa/Linkup-class sibling justifies a `search` sub-tier, so it adds coverage
   without creating one. It is also the only row on this page with a recorded **Step-0 verdict**
   (RICH, 2026-07-17).
3. **Everything else is additive.** A category with ≥2 members and a live sub-tier gains coverage from
   a 3rd sibling, not capability — so these compete on their own merit against unrelated work, not
   against 1 or 2.

Best additive pick per category, all on parsers AIWatch already has: **MiniMax** (video) · **Qdrant**
(vector — the earlier shortlist's pick; the table bolds Zilliz too, and nothing here separates them) ·
**Ideogram** (image — #601 Phase 4 named it the optional 3rd) · **W&B or Comet** (observability —
undifferentiated in the table; pick at Step-0) · **DeepInfra** (inference — a generic host; **Kimi/Moonshot** #989 is the other row, richer provenance but pulls in non-English `titleMap` infra).
The earlier shortlist also named Langfuse and FLUX; both have since shipped.

## Video — CLOSED (Runway + Luma)

`5: 'Video'` sub-tier live. A 3rd sibling is additive, not gap-closing.

| Candidate | Status page | Platform | Monitorable | Note |
|---|---|---|---|---|
| **MiniMax / Hailuo** | status.minimax.io | Atlassian ✅ | Yes | full components/incidents; highest traffic among add-able. Re-verified Atlassian 2026-07-17 (`x-statuspage-version` header) |
| ~~Luma (Dream Machine)~~ | status.lumalabs.ai | Better Stack ✅ | **ADDED** (#602) | the Runway sibling that closed this category |
| Genmo | genmostatus.com | Atlassian ✅ | Yes | niche / open-source (Mochi) |
| Pollo AI | pollo.instatus.com | Instatus ✅ | Yes | lesser-known |
| Higgsfield | status.higgsfield.ai | Instatus ✅ | Yes | lesser-known |
| ❌ Pika | — | — | **No** | no official status page |
| ❌ Kling AI | — | — | **No** | no public status page (highest traffic but unmonitorable) |

## LLM observability / eval — CLOSED (LangSmith + Langfuse + Helicone)

`6: 'Observability'` sub-tier live (#753).

| Candidate | Status page | Platform | Monitorable |
|---|---|---|---|
| ~~Langfuse~~ | status.langfuse.com | incident.io ✅ | **ADDED** (#753) |
| ~~Helicone~~ | status.helicone.ai | Better Stack ✅ | **ADDED** (#753) |
| W&B (Weave) | status.wandb.com | Atlassian ✅ | Yes |
| Comet (Opik) | status.comet.com | Atlassian ✅ | Yes |
| ❌ Arize/Phoenix | status.arize.com | custom SPA | **No** (not parseable) |

## Vector DB — CLOSED (Pinecone + turbopuffer)

`8: 'Vector'` sub-tier live (#857 / #863).

| Candidate | Status page | Platform | Monitorable |
|---|---|---|---|
| ~~Turbopuffer~~ | status.turbopuffer.com | incident.io ✅ | **ADDED** (#857) — chosen over Qdrant/Zilliz as the cleanest 1:1 RAG-retrieval substitute |
| **Qdrant Cloud** | status.qdrant.io | Better Stack ✅ | Yes |
| **Zilliz / Milvus** | status.zilliz.com | Atlassian ✅ | Yes |
| Chroma Cloud | status.trychroma.com | Instatus ✅ | Yes |
| ❌ Weaviate Cloud | status.weaviate.cloud | empty stub | **No** (no real public page) |

## Image generation — CLOSED (Stability AI + FLUX)

`7: 'Image'` sub-tier live (#756 / #757).

| Candidate | Status page | Platform | Monitorable |
|---|---|---|---|
| ~~Black Forest Labs (FLUX)~~ | status.bfl.**ml** | Atlassian ✅ | **ADDED** (#756) — the code pins `status.bfl.ml` (`services.ts`); `status.bfl.ai` 302s here (`bfl.ai` is the API/product domain — `api.bfl.ai`) |
| **Ideogram** | status.ideogram.ai | Atlassian ✅ | Yes |
| Recraft | recraft.instatus.com | Instatus ✅ | Yes |
| Leonardo.ai | leonardo.instatus.com | Instatus ✅ | Yes (page branded "Rockgaming" — verify) |
| ❌ Midjourney | — | Discord-only | **No** |

## Embeddings — OPEN (Voyage AI is still solo)

The **last** of the five single-service-category gaps. Execution issue: #880.

| Candidate | Status page | Platform | Monitorable |
|---|---|---|---|
| **Jina AI** | status.jina.ai | Atlassian ✅ | Yes — the #880 target. Re-verified Atlassian 2026-07-17 (`x-statuspage-version` header + `window.uptimeData`) |
| **Nomic AI** | status.nomic.ai | incident.io ✅ | Yes — optional 3rd |
| Mixedbread | mixedbread-ai.openstatus.dev | OpenStatus + RSS | Likely (RSS path only; no Atlassian/Instatus JSON) |

## Search / RAG — NEW category, not yet seeded

No AI search provider is monitored today. Execution issue: **#392** (Tavily). A dedicated `search`
category waits for an Exa/Linkup-class sibling — a category with one member is UX clutter, so Tavily
lands under `inference` until then.

| Candidate | Status page | Platform | Monitorable |
|---|---|---|---|
| **Tavily** | status.tavily.com | **incident.io** ✅ | Yes — Step-0 verdict RICH (2026-07-17). NOT Atlassian, despite serving `/api/v2/summary.json`; see #392 |

## Inference — populated already (ADDITIVE, low priority)

`together` / `fireworks` / `cerebras` / `groq` / … already have many siblings, so these are
coverage-additive, **not** a fallback gap. Do not let them block the gap work above.

| Candidate | Status page | Platform | Monitorable | Note |
|---|---|---|---|---|
| **DeepInfra** | status.deepinfra.com | Better Stack ✅ (`/index.json`) | Yes | Serverless LLM inference. `api.deepinfra.com/v1/openai/models` → 200, probeable RTT (~1.1s). Existing BetterStack parser + probe; no new parser. Verified 2026-06-23 |
| **Kimi (Moonshot AI)** | status.moonshot.cn | Atlassian ✅ | Yes | Step-0 verdict **RICH** (2026-07-10), fully worked in **#989**. Not a plain inference host — a Moonshot model lab (DeepSeek-class), so also a frontier-LLM add. Its incident titles are Chinese-only, so it introduces the first per-service `titleMap` (the `sanitize()` non-ASCII passthrough gap); needs `holdShortIncidents` (auto-monitor flap). `.cn` is a CNAME to Statuspage → no China-network reachability risk; `Open API` component drives badge/uptime, model components display-only (#606) |

## Declined

- **Google Cloud AI products** (Veo · Imagen · Speech-to-Text · Text-to-Speech · Vertex AI Vector
  Search) — **#680, closed 2026-07-17 (not planned).** The Step-0 audit found gcloud
  `incidents.json` thin: no official uptime, ~0 incidents for these products, and Vertex is
  unprobeable (auth). Every category it targeted has since been filled by a richer sibling (Video →
  Luma, Image → FLUX, Vector → turbopuffer); Voice was already covered by
  AssemblyAI/Deepgram/ElevenLabs. **Do not re-propose a gcloud-only source for these rows without a
  fresh Step-0 audit.**
- **Google Antigravity** — no official status page exists (only crowdsourced trackers, which the
  official-source-primary methodology cannot use), and the coding-agent category is already
  saturated at 6 monitored services. Declined 2026-07-17, not queued.
