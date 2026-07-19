// Official status page URL per monitored service — the "Status Page ↗" link on ServiceDetails.
//
// This is a hand-mirror of `statusUrl` in worker/src/services.ts (the SPA can't import the Worker
// bundle). #1004 extracted it from ServiceDetails.jsx so the mirror can be PINNED: JetBrains moved
// Junie's status page and this copy had to be updated by hand, with nothing failing if it wasn't —
// the link would have kept pointing at a 301'd host. The "mirrors the worker config" block in
// worker/src/__tests__/junie-migration.test.ts now asserts every id against the canonical config.
export const STATUS_URL = {
  claude:      'https://status.claude.com',
  openai:      'https://status.openai.com',
  gemini:      'https://aistudio.google.com/status',
  mistral:     'https://status.mistral.ai',
  cohere:      'https://status.cohere.ai',
  groq:        'https://status.groq.com',
  together:    'https://status.together.ai',
  fireworks:   'https://status.fireworks.ai',
  cerebras:    'https://status.cerebras.ai',
  perplexity:  'https://status.perplexity.ai',
  huggingface: 'https://status.huggingface.co',
  replicate:   'https://www.replicatestatus.com',
  fal:         'https://status.fal.ai',
  elevenlabs:  'https://status.elevenlabs.io',
  xai:         'https://status.x.ai',
  deepseek:    'https://status.deepseek.com',
  openrouter:  'https://status.openrouter.ai',
  bedrock:     'https://health.aws.amazon.com/health/status',
  pinecone:    'https://status.pinecone.io',
  turbopuffer: 'https://status.turbopuffer.com',
  stability:   'https://status.stability.ai',
  bfl:         'https://status.bfl.ml',
  voyageai:    'https://voyageai-status.statuspage.io',
  modal:       'https://status.modal.com',
  twelvelabs:  'https://status.twelvelabs.io',
  langsmith:   'https://global.status.smith.langchain.com/gcp-us',
  helicone:    'https://status.helicone.ai',
  langfuse:    'https://status.langfuse.com',
  runway:      'https://status.runwayml.com',
  luma:        'https://status.lumalabs.ai',
  assemblyai:  'https://status.assemblyai.com',
  deepgram:    'https://status.deepgram.com',
  azureopenai: 'https://azure.status.microsoft/en-us/status',
  characterai: 'https://status.character.ai',
  claudeai:    'https://status.claude.com',
  chatgpt:     'https://status.openai.com',
  deepseekapp: 'https://status.deepseek.com',
  claudecode:  'https://status.claude.com',
  copilot:     'https://githubstatus.com',
  cursor:      'https://status.cursor.com',
  windsurf:    'https://status.windsurf.com',
  junie:       'https://status.jetbrains.cloud', // #1004 — moved off status.jetbrains.ai (Atlassian → incident.io)
  codex:       'https://status.openai.com',
}
