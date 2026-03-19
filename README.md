# AIWatch

Real-time monitoring dashboard for 13 AI API services — track status, latency, uptime, and incidents across the major LLM providers.

## Monitored Services

| Service | Provider |
|---|---|
| Claude API | Anthropic |
| OpenAI API | OpenAI |
| Gemini API | Google |
| Mistral API | Mistral AI |
| Cohere API | Cohere |
| Groq Cloud | Groq |
| Together AI | Together |
| Perplexity API | Perplexity |
| Hugging Face | HuggingFace |
| Replicate | Replicate |
| ElevenLabs | ElevenLabs |
| xAI (Grok) | xAI |
| DeepSeek API | DeepSeek |

## Tech Stack

- **Frontend**: React 19 + Vite 6, TailwindCSS v4, Chart.js
- **Backend**: Cloudflare Workers (status polling proxy)
- **Hosting**: Vercel (aiwatch.dev)
- **Analytics**: Google Analytics 4

## Development

```bash
npm install
npm run dev      # localhost:5173
npm run build
npm run lint
```

## Screen State Management

AIWatch uses **no router library**. Navigation is handled by a `currentPage` state in `App.jsx`, shared via `PageContext`.

```
PageContext { page, setPage }
  └── page shape: { name: string, serviceId?: string }
  └── name: 'overview' | 'latency' | 'incidents' | 'uptime' | 'service' | 'settings'
```

**How to navigate** from any component:

```jsx
import { usePage } from './utils/pageContext'

const { setPage } = usePage()

// Go to a dashboard page
setPage({ name: 'latency' })

// Go to a specific service detail
setPage({ name: 'service', serviceId: 'claude' })
```

`App.jsx` passes the current page through `resolvePage()` which renders the matching page component. The Sidebar and Topbar (Issues #5, #7) call `setPage` to drive navigation.

## License

MIT
