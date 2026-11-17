// #2009 — which probe targets a visitor's browser can read: the page block (api/_shared/device-check.ts)
// and the daily read (device-check-click.ts) both take their list from here. No imports.
//
// Readable = the provider answers a cross-origin GET with CORS headers (measured 2026-11-16 from a
// third-party origin, `mode: 'cors'`, no credentials — see #2009). READABLE ∪ UNREADABLE must equal
// PROBE_TARGETS (pinned in api/_shared/__tests__/device-check.test.ts), so a new probe target forces a
// decision here.

export const DEVICE_CHECK_READABLE: Readonly<Record<string, { header?: string }>> = {
  claude: { header: 'anthropic-dangerous-direct-browser-access:true' },
  openai: {}, gemini: {}, mistral: {}, cohere: {}, groq: {}, together: {}, fireworks: {}, cerebras: {},
  perplexity: {}, huggingface: {}, fal: {}, elevenlabs: {}, xai: {}, deepseek: {}, kimi: {}, openrouter: {},
  stability: {}, assemblyai: {}, fishaudio: {}, speechmatics: {}, voyageai: {}, jina: {}, twelvelabs: {},
  langsmith: {}, langfuse: {}, turbopuffer: {}, bedrock: {},
}

export const DEVICE_CHECK_UNREADABLE: readonly string[] = [
  'replicate', 'bfl', 'deepgram', 'pinecone', 'runway', 'luma', 'helicone', 'cursor', 'characterai',
]
