# AIWatch

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-ai--watch.dev-blue)](https://ai-watch.dev)
[![GitHub stars](https://img.shields.io/github/stars/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/commits/main)

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/#claude)
[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/#openai)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/#gemini)
[![GitHub Copilot](https://aiwatch-worker.p2c2kbf.workers.dev/badge/copilot)](https://ai-watch.dev/#copilot)

[English](README.md) | **한국어**

**35개 AI 서비스**의 상태, 지연시간, 가동률, 인시던트를 실시간으로 모니터링하는 대시보드입니다.

**[대시보드](https://ai-watch.dev)** · **[랜딩 페이지](https://ai-watch.dev/intro)**

| 데스크탑 | 모바일 |
|---------|--------|
| ![AIWatch 대시보드](docs/screenshot.png?v=3) | ![AIWatch 모바일](docs/screenshot-mobile.png?v=1) |

**공유**
[![X에 공유](https://img.shields.io/badge/Share-X-000000?logo=x&logoColor=white)](https://twitter.com/intent/tweet?text=AIWatch%20%E2%80%94%2035%EA%B0%9C%20AI%20%EC%84%9C%EB%B9%84%EC%8A%A4%20%EC%8B%A4%EC%8B%9C%EA%B0%84%20%EC%9E%A5%EC%95%A0%20%EB%AA%A8%EB%8B%88%ED%84%B0%EB%A7%81%20%28Claude%2C%20ChatGPT%2C%20Gemini%20%EC%99%B8%29&url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch)
[![Reddit에 공유](https://img.shields.io/badge/Share-Reddit-FF4500?logo=reddit&logoColor=white)](https://reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch&title=AIWatch%20%E2%80%94%2035%EA%B0%9C%20AI%20%EC%84%9C%EB%B9%84%EC%8A%A4%20%EC%8B%A4%EC%8B%9C%EA%B0%84%20%EC%9E%A5%EC%95%A0%20%EB%AA%A8%EB%8B%88%ED%84%B0%EB%A7%81)
[![Hacker News에 공유](https://img.shields.io/badge/Share-Hacker%20News-FF6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch&t=AIWatch%20%E2%80%94%20Real-time%20monitoring%20for%2035%20AI%20services)
[![LinkedIn에 공유](https://img.shields.io/badge/Share-LinkedIn-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch)

## 🛰️ 라이브 데모

**[ai-watch.dev](https://ai-watch.dev)** — 회원가입 불필요. Cloudflare Workers로 5분마다 갱신.

## 주요 기능

- **실시간 상태 모니터링** — 35개 AI 서비스의 정상 / 성능 저하 / 장애 상태
- **PWA 지원** — 홈 화면 추가, Service Worker 오프라인 캐시
- **지연시간 측정** — 20개 probe 대상 서비스의 API 엔드포인트 직접 RTT 측정, 나머지는 상태 페이지 응답 시간
- **24시간 지연시간 추세** — Chart.js 라인 차트 (5분 간격 probe 스냅샷)
- **인시던트 이력** — 다양한 상태 페이지 형식의 타임라인 상세 정보
- **공식 가동률** — Statuspage, incident.io, Better Stack에서 컴포넌트별 가동률
- **상태 캘린더** — 30일(Statuspage) 또는 14일(incident.io) 일별 상태 시각화
- **Discord & Slack 알림** — 상태 변경/인시던트 Discord Webhook + Slack 내장 `/feed` RSS 앱(설정 0) + RSS 피드
- **쿠키 동의** — GA4 Consent Mode v2 (동의/필수만)
- **딥링크** — hash 기반 라우팅 (`#claude`, `#latency`)
- **다크/라이트 테마** — 시스템 설정 감지 + 수동 전환
- **한국어/영어** — 이중 언어 지원
- **모바일 반응형** — 사이드바 오버레이, 모바일 액션 바
- **AIWatch Score** — uptime, 인시던트, 복구 시간, probe 기반 응답성을 결합한 종합 신뢰도 점수 ([계산 방식](https://ai-watch.dev/#about-score))
- **RTT 저하 감지** — AIWatch의 직접 API probe가 공식 상태 페이지에 보고되지 않는 지연(latency) 저하를 포착 (대시보드 배지 + Discord 일일 요약). 공식 발표 대비 ~5분 폴링 주기 내 독립 감지(MTTD); 드물게 발생하는 진짜 조기 RTT 신호는 이벤트별로 표시
- **리전별 가용성** — xAI, Gemini, OpenAI의 리전별 인시던트 상태 및 전환 추천
- **스마트 알림** — degraded/down 상태 Discord 알림 (anti-flapping + 인시던트 억제 + 복구 지속 시간)
- **오프라인 UI** — API 연결 불가 시 안내 화면 (프로덕션 전용)
- **Is X Down SEO 페이지** — 33개 서비스 (Bedrock/Azure OpenAI 제외한 모든 모니터링 대상), 동적 OG 이미지(PNG), 공유 버튼, AIWatch 순위 (대시보드와 동일한 동률 표기), 대체 서비스 추천
- **헬스체크 프로빙** — API 엔드포인트 직접 RTT 측정 (20개 API 서비스) + 연속 스파이크 조기 장애 감지 및 RTT 저하 추적
- **페이지별 스켈레톤** — 각 페이지 레이아웃에 맞는 로딩 placeholder
- **AI 분석 (Beta)** — 장애 발생 시 하이브리드 AI 자동 분석 (Gemma 4 primary + Sonnet fallback): 원인 추정, 예상 복구 시간, 영향 범위, 대체 서비스 추천. 인시던트 Discord 알림에 통합(단일 embed), Topbar Analyze 모달, Is X Down AI Insight 카드
- **랜딩 페이지** — 랜딩 페이지(`/intro`), 대시보드 프리뷰 mock, KO/EN 이중 언어, Flow 애니메이션, `?banner=` 캠페인 슬롯(선택), GA4 트래킹
- **Web Vitals 모니터링** — 실사용자 LCP, FCP, TTFB, CLS, INP 수집, p75 집계 및 Discord Daily Report 임계값 알림
- **주간 브리핑** — 매주 일요일 Discord 다이제스트: AI 서비스 변경 감지(OpenAI, Google, Anthropic), 인시던트 요약, 안정성 트렌드
- **보안 모니터링** — Hacker News, Reddit(r/netsec, r/cybersecurity), OSV.dev를 통한 AI 서비스 보안 사고 감지 및 24개 AI SDK 패키지(PyPI + npm, Langchain 에코시스템 어댑터 포함) 취약점 스캔, 대시보드 알림 + Discord 다이제스트
- **상태 페이지 교차 검증** — Probe RTT + 플랫폼 쿼럼 + metastatuspage 모니터링으로 상태 페이지 인프라 장애 시 오탐 방지

## 모니터링 서비스

### AI API 서비스 (26개)

| 서비스 | 제공업체 | 상태 소스 |
|--------|----------|-----------|
| Claude API | Anthropic | Atlassian Statuspage |
| OpenAI API | OpenAI | incident.io (Atlassian 호환) |
| Gemini API | Google | Google Cloud incidents.json |
| Mistral API | Mistral AI | Instatus (Nuxt SSR) |
| Cohere API | Cohere | incident.io (Atlassian 호환) |
| Groq Cloud | Groq | incident.io (Atlassian 호환) |
| Together AI | Together | Better Stack RSS + 가동률 API |
| Fireworks AI | Fireworks | Better Stack RSS + 가동률 API |
| Cerebras Inference | Cerebras | Atlassian Statuspage (멀티 컴포넌트 worst-of) |
| Perplexity | Perplexity AI | Instatus (Next.js SSR) |
| Hugging Face | HuggingFace | Better Stack RSS + 가동률 API |
| Replicate | Replicate | incident.io (Atlassian 호환) |
| ElevenLabs | ElevenLabs | incident.io (Atlassian 호환) |
| AssemblyAI | AssemblyAI | Atlassian Statuspage |
| Deepgram | Deepgram | Atlassian Statuspage |
| xAI (Grok) | xAI | RSS 피드 |
| DeepSeek API | DeepSeek | Atlassian Statuspage |
| OpenRouter | OpenRouter | OnlineOrNot (React Router SSR) |
| Amazon Bedrock | AWS | AWS Health Dashboard |
| Pinecone | Pinecone | Atlassian Statuspage |
| Stability AI | Stability AI | Atlassian Statuspage |
| Voyage AI | Voyage AI | Atlassian Statuspage |
| Modal | Modal | Better Stack RSS + 가동률 API |
| LangChain (LangSmith) | LangChain | Atlassian Statuspage (incident.io) |
| Runway | Runway | Atlassian Statuspage |
| Azure OpenAI | Microsoft | Azure Status RSS |

### AI 앱 (3개)

| 서비스 | 제공업체 |
|--------|----------|
| claude.ai | Anthropic |
| ChatGPT | OpenAI |
| Character.AI | Character AI |

### 코딩 에이전트 (6개)

| 서비스 | 제공업체 |
|--------|----------|
| Claude Code | Anthropic |
| Codex | OpenAI |
| Cursor | Anysphere |
| GitHub Copilot | Microsoft |
| Windsurf | Codeium |
| Junie | JetBrains |

## 기술 스택

| 계층 | 기술 |
|------|------|
| 프론트엔드 | React 19, Vite 6, TailwindCSS v4, Chart.js |
| 백엔드 | Cloudflare Workers (TypeScript) |
| 캐시 | Cloudflare KV (상태 캐시, 지연시간 스냅샷) |
| 호스팅 | Vercel |
| 알림 | Discord Webhook (Worker 프록시) · Slack 내장 `/feed` RSS · RSS 피드 |
| 분석 | Google Analytics 4 (Consent Mode v2) |
| 테스트 | Playwright (E2E), Vitest (단위) |

## 아키텍처

```
브라우저 (React SPA, 60초 폴링)
  ↓
Cloudflare Worker
  ├── GET /api/status    → 병렬 fetch (35개 서비스) → 정규화
  ├── GET /api/uptime    → 일별 가동률 이력
  └── POST /api/alert   → Discord Webhook 프록시 (SSRF 보호)
  ↓
파서 (worker/src/parsers/)
  ├── impact-weights.ts  → 공유 MAJOR_WEIGHT/MINOR_WEIGHT (Atlassian 공식, 두 파서 공통)
  ├── statuspage.ts      → Atlassian Statuspage API + uptimeData HTML (가중치 적용 공식 uptime)
  ├── incident-io.ts     → incident.io 호환 API + component_uptimes/impacts (인시던트 추정 uptime도 동일 가중치 공식 사용)
  ├── gcloud.ts          → Google Cloud incidents.json (Vertex Gemini)
  ├── aistudio.ts        → Google AI Studio + Gemini API (gcloud와 병합되는 2차 소스 — #310)
  ├── instatus.ts        → Instatus Nuxt/Next.js SSR
  ├── betterstack.ts     → Better Stack RSS + /index.json 가동률 API + dailyImpact (status_history)
  └── aws.ts             → AWS Health Dashboard RSS
  ↓
Cloudflare KV
  ├── services:latest      (상태 캐시, TTL 5분)
  ├── daily:YYYY-MM-DD     (가동률 카운터, TTL 2일)
  ├── history:YYYY-MM-DD   (아카이브 카운터, TTL 90일)
  ├── latency:24h          (30분 스냅샷, 최대 48개, TTL 25시간)
  ├── probe:24h            (헬스체크 프로브, 최대 2016개, TTL 7일, 20개 API 서비스)
  ├── ai:analysis:{svcId}:{incId}  (AI 인시던트별 분석, TTL 1시간, 활성 시 갱신)
  ├── ai:reanalysis-skip:* (재분석 실패 쿨다운, TTL 30분)
  ├── ai:usage:{date}      (일별 AI 사용량 카운터, TTL 2일)
  ├── alerted:*            (알림 중복 방지 키, TTL 2시간-7일)
  ├── detected:{svcId}     (최초 감지 타임스탬프, TTL 7일)
  ├── detection:lead:{date} (조기 RTT audit 로그, UTC 일별, TTL 7일, 일일 요약에 24h 슬라이딩 윈도우)
  ├── probe-degradation:daily:{svcId}:{date} (RTT 저하 카운터, TTL 48시간, #464)
  ├── reddit:seen:{postId} (Reddit 게시글 중복 방지, TTL 24시간)
  └── vitals:{YYYY-MM-DD}  (Web Vitals 일별 집계, TTL 2일)
```

## 시작하기

### 사전 요구사항

- Node.js 20+
- npm
- Cloudflare 계정 (Worker 배포용)

### 프론트엔드

```bash
git clone https://github.com/bentleypark/aiwatch.git
cd aiwatch
npm install
npm run dev        # localhost:5173
```

### Worker (백엔드)

```bash
cd worker
npm install
# 로컬 개발용 .dev.vars 생성:
echo "ALLOWED_ORIGIN=*" > .dev.vars
npm run dev        # localhost:8787
```

### 환경 변수

**프론트엔드 (.env)**
```
VITE_API_URL=http://localhost:8788/api/status
VITE_GA4_ID=                # 선택: Google Analytics 측정 ID
```

**Worker (wrangler.toml + secrets)**
```
ALLOWED_ORIGIN=https://your-domain.com
DISCORD_WEBHOOK_URL=        # Worker Secret: Discord 웹훅 URL
ANTHROPIC_API_KEY=          # Worker Secret: Claude Sonnet API 키 (AI 분석 fallback)
```

## 스크립트

```bash
# 프론트엔드
npm run dev          # 개발 서버 (localhost:5173)
npm run dev:worker   # Worker 개발 서버 (localhost:8788)
npm run dev:all      # 둘 다 동시 실행
npm run build        # 프로덕션 빌드 → dist/
npm run lint         # ESLint
npm test             # Playwright E2E 테스트 (27개)
npm run test:worker  # Worker 단위 테스트 (65개, vitest)

# Worker 배포
npm run deploy:worker  # Cloudflare 배포 (npm 스크립트만 사용)
```

## API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/status` | GET | 전체 서비스 상태 + 인시던트 + 가동률 + latency24h + aiAnalysis |
| `/api/status/cached` | GET | KV 캐시 전용 (Edge SSR용, ~1.2초) |
| `/api/uptime?days=30` | GET | 일별 가동률 이력 (1-90일) |
| `/api/report?month=YYYY-MM` | GET | 월간 안정성 아카이브 (가동률, 점수, 인시던트, 레이턴시) |
| `/api/alert` | POST | Discord Webhook 프록시 (SSRF 보호) |
| `/badge/:serviceId` | GET | SVG 상태 배지 (shields.io 스타일) |
| `/api/og` | GET | 동적 OG 이미지 PNG (1200×630, resvg-wasm) |
| `/api/v1/status` | GET | 공개 API — 전체 서비스 (경량, CORS `*`) |
| `/api/v1/status/:id` | GET | 공개 API — 개별 서비스 + 최근 5건 인시던트 |

## 공개 API (v1)

외부 개발자용 공개 API. 인증 불필요. 분당 60회 제한.

**전체 서비스:**
```bash
curl https://aiwatch-worker.p2c2kbf.workers.dev/api/v1/status
```

**개별 서비스:**
```bash
curl https://aiwatch-worker.p2c2kbf.workers.dev/api/v1/status/claude
```

응답 항목: `id`, `name`, `provider`, `category`, `status`, `latency`, `uptime30d`, `uptimeSource`, `lastChecked`, 최근 인시던트 5건 (개별 조회 시).

## 상태 배지

README, 문서, 블로그에 실시간 상태 배지를 임베드할 수 있습니다.

```markdown
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/#claude)
```

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/#claude)

### 파라미터

| 파라미터 | 설명 | 예시 |
|---------|------|------|
| `uptime` | 가동률 % 표시 | `/badge/claude?uptime=true` |
| `style` | `flat` 또는 `flat-square` | `/badge/claude?style=flat-square` |
| `label` | 커스텀 라벨 | `/badge/claude?label=My+API` |

### 예시

[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/#openai)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/#gemini)
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude?uptime=true)](https://ai-watch.dev/#claude)
[![Cursor](https://aiwatch-worker.p2c2kbf.workers.dev/badge/cursor?style=flat-square)](https://ai-watch.dev/#cursor)

### 사용 가능한 서비스 ID

| ID | 서비스 | ID | 서비스 |
|----|---------|----|---------|
| `claude` | Claude API | `claudeai` | claude.ai |
| `openai` | OpenAI API | `chatgpt` | ChatGPT |
| `gemini` | Gemini API | `claudecode` | Claude Code |
| `mistral` | Mistral API | `copilot` | GitHub Copilot |
| `cohere` | Cohere API | `cursor` | Cursor |
| `groq` | Groq Cloud | `windsurf` | Windsurf |
| `together` | Together AI | `junie` | Junie |
| `fireworks` | Fireworks AI | `deepseek` | DeepSeek API |
| `perplexity` | Perplexity | `xai` | xAI (Grok) |
| `huggingface` | Hugging Face | `replicate` | Replicate |
| `elevenlabs` | ElevenLabs | `openrouter` | OpenRouter |
| `bedrock` | Amazon Bedrock | `pinecone` | Pinecone |
| `azureopenai` | Azure OpenAI | `stability` | Stability AI |
| `assemblyai` | AssemblyAI | `deepgram` | Deepgram |
| `characterai` | Character.AI | `modal` | Modal |
| `voyageai` | Voyage AI | `codex` | Codex |
| `cerebras` | Cerebras Inference | | |

## Claude Code Statusline 통합

Claude API, OpenAI, Gemini, GitHub Copilot 등 35개 AI 서비스의 장애 여부를 [Claude Code 스테이터스라인](https://docs.claude.com/en/docs/claude-code/statusline)에 직접 표시합니다. 추천 프리셋은 항상 표시되는 클릭 가능한 **AIWatch** 라벨을 유지합니다 — 모두 정상이면 `AIWatch 🟢`, 장애 시 `AIWatch 🔴 Claude API`, 라벨 cmd/ctrl+클릭 시 대시보드 열림. 정상일 때 공간을 비우고 싶으면 [프리셋 페이지](https://ai-watch.dev/#statusline)의 minimalist 프리셋을 쓰면 됩니다.

가장 빠른 설정 — `~/.claude/settings.json`에 추가:

```json
{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 https://aiwatch-worker.p2c2kbf.workers.dev/api/status/cached?src=statusline-branded | jq -r '([.services[] | select(.status != \"operational\")]) as $d | \"\\u001b]8;;https://ai-watch.dev\\u001b\\\\AIWatch\\u001b]8;;\\u001b\\\\ \" + (if ($d | length) == 0 then \"🟢\" else ([$d[] | \"\\u001b]8;;https://ai-watch.dev/#\\(.id)\\u001b\\\\🔴 \\(.name)\\u001b]8;;\\u001b\\\\\"] | .[0:3] | join(\" \")) end)' ) 2>/dev/null || true"
  }
}
```

> 클릭 가능한 라벨은 OSC 8 지원 터미널(iTerm2, Warp, kitty, WezTerm, VS Code 터미널, macOS 12+ Terminal.app)에서 동작하고, 미지원은 plain text로 표시됩니다. Worker 도메인을 직접 호출해 렌더링당 폴링이 Vercel 대역폭으로 잡히지 않습니다.

프리셋 모음 — **minimalist**(정상 시 빈 출력), 컴팩트 배지, 전체 목록, 특정 프로바이더만, 서비스별 clickable 링크: **[ai-watch.dev/#statusline](https://ai-watch.dev/#statusline)**

특성: 렌더링당 단일 GET, Cloudflare edge에 5분 KV 캐시, 2초 타임아웃, 네트워크 에러 시 silent fail, Anthropic API 호출 없음, 클라이언트 식별자 미수집. `?src=statusline-<preset>` 쿼리 태그는 요청 로그에서 statusline 트래픽을 일반 cached-endpoint 호출과 구분하기 위한 용도일 뿐이며, Worker는 경로만 매칭하므로 캐시/응답 속도에 영향이 없고 사용자 식별자도 포함하지 않습니다. shell 명령 출력을 지원하는 모든 statusline 도구와 호환 (`ccstatusline`의 Custom Command 위젯 포함).

## 프로젝트 구조

```
src/
  components/    # 공유 UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, InstallBanner
  pages/         # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, AboutScore, Ranking
  hooks/         # usePolling, useTheme, useLang, useSettings
  utils/         # analytics, calendar, time, pageContext, constants
  locales/       # ko.js, en.js (flat key→string 맵)
api/
  intro.ts             # Vercel Edge Function — 랜딩 페이지 (/intro)
  intro/
    html-template.ts   # 랜딩 페이지 SSR 템플릿 (i18n, 대시보드 mock, GA4)
  is-down.ts           # Vercel Edge Function — "Is X Down?" SSR 페이지 (33개 서비스)
  is-down/
    slug-map.ts        # URL slug ↔ service ID 매핑
    seo-content.ts     # 서비스별 SEO 텍스트 + FAQ
    html-template.ts   # SSR HTML 렌더링 + 공유 버튼 + 동적 OG meta
public/
  manifest.json        # PWA 매니페스트
  sw.js                # Service Worker (stale-while-revalidate)
  icon-192.png         # PWA 아이콘 192x192
  icon-512.png         # PWA 아이콘 512x512
scripts/
  generate-og-intro.mjs  # OG 인트로 이미지 생성기 (node scripts/generate-og-intro.mjs)
worker/
  src/
    index.ts     # Worker 진입점: CORS, KV, 알림, 라우팅, /api/alert, /badge, /api/v1
    services.ts  # 서비스 설정 + fetch 오케스트레이터
    types.ts     # 공유 타입 (ServiceStatus, Incident 등)
    utils.ts     # 공유 유틸리티 (formatDuration, fetchWithTimeout)
    score.ts     # AIWatch Score 계산
    badge.ts     # SVG 배지 생성기
    rss.ts       # 인시던트 RSS 2.0 피드 (/feed.xml + /feed/:slug)
    og.ts        # OG 이미지 SVG 생성기 (1200×630)
    og-render.ts # SVG → PNG 변환 (resvg-wasm)
    alerts.ts    # 알림 감지 로직 (인시던트 + 서비스 알림)
    fallback.ts  # 대체 서비스 추천
    ai-analysis.ts # 하이브리드 AI 장애 분석 (Gemma 4 primary + Sonnet fallback)
    changelog.ts # 변경사항/뉴스 수집 (OpenAI RSS, Google RSS, Anthropic HTML)
    weekly-briefing.ts # 주간 Discord 브리핑 (변경사항 + 인시던트 + 안정성)
    security-monitor.ts # AI 서비스 보안 모니터링 (HN Algolia, OSV.dev SDK 취약점 — 24개 추적 패키지)
    daily-summary.ts # 일일 Discord 리포트 (가동률, 지연시간, AI 사용량)
    monthly-archive.ts # 월간 안정성 아카이브 (영구 KV 보존)
    vitals.ts    # Web Vitals 집계 (p75, Discord 포맷)
    probe.ts     # 헬스체크 프로빙 — 직접 RTT 측정
    probe-archival.ts # 일별 probe RTT 아카이브 + 7일 요약
    platform-monitor.ts # 상태 페이지 플랫폼 모니터링 (metastatuspage.com)
    detection.ts # Detection Lead 파싱 + 리셋 로직
    detection-lead-log.ts # Detection Lead audit 로그 (#256, 일일 요약)
    reddit.ts    # Reddit 장애 감지 모니터링
    parsers/     # 플랫폼별 파서
      statuspage.ts   # Atlassian Statuspage (7개 서비스)
      incident-io.ts  # incident.io (6개 서비스)
      gcloud.ts       # Google Cloud Vertex (gemini 1차 소스)
      aistudio.ts     # Google AI Studio + Gemini API (gemini 2차 소스, #310)
      instatus.ts     # Instatus (2개 서비스)
      betterstack.ts  # Better Stack (4개 서비스)
      onlineornot.ts  # OnlineOrNot (1개 서비스 — OpenRouter)
      aws.ts          # AWS Health Dashboard (1개 서비스 — Bedrock)
    parsers/__tests__/ # Vitest 단위 테스트
```

## 기여하기

자세한 가이드는 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

1. 레포지토리 포크
2. 기능 브랜치 생성 (`git checkout -b feature/my-feature`)
3. [CLAUDE.md](CLAUDE.md)의 개발 워크플로우 따르기
4. 빌드 + 테스트: `npm run build && npm test && npm run test:worker`
5. [PR 템플릿](.github/pull_request_template.md)으로 풀 리퀘스트 제출

### 이슈

- **버그 리포트**: [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) 템플릿 사용
- **기능 요청**: [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) 템플릿 사용

### 풀 리퀘스트

- PR당 하나의 기능 또는 수정
- 모든 테스트 통과 (E2E 27개 + 단위 65개 = 92개)
- 커밋 메시지에 `closes #N` 포함
- PR 체크리스트 작성

## 보안

취약점을 발견하셨나요? [SECURITY.md](SECURITY.md)를 참고하여 책임감 있게 신고해 주세요.

## 라이선스

[AGPL-3.0](LICENSE)
