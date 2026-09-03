# AIWatch

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Deploy](https://img.shields.io/badge/Deploy-ai--watch.dev-blue)](https://ai-watch.dev)
[![GitHub stars](https://img.shields.io/github/stars/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/bentleypark/aiwatch)](https://github.com/bentleypark/aiwatch/commits/main)

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)
[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/is-openai-down)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/is-gemini-down)
[![GitHub Copilot](https://aiwatch-worker.p2c2kbf.workers.dev/badge/copilot)](https://ai-watch.dev/is-github-copilot-down)

[English](README.md) | **한국어**

**45개 AI 서비스**의 상태, 지연시간, 가동률, 인시던트를 실시간으로 모니터링하는 대시보드입니다.

**[대시보드](https://ai-watch.dev)** · **[랜딩 페이지](https://ai-watch.dev/intro)**

| 데스크탑 | 모바일 |
|---------|--------|
| ![AIWatch 대시보드](docs/screenshot.png?v=3) | ![AIWatch 모바일](docs/screenshot-mobile.png?v=1) |

**공유**
[![X에 공유](https://img.shields.io/badge/Share-X-000000?logo=x&logoColor=white)](https://twitter.com/intent/tweet?text=AIWatch%20%E2%80%94%2045%EA%B0%9C%20AI%20%EC%84%9C%EB%B9%84%EC%8A%A4%20%EC%8B%A4%EC%8B%9C%EA%B0%84%20%EC%9E%A5%EC%95%A0%20%EB%AA%A8%EB%8B%88%ED%84%B0%EB%A7%81%20%28Claude%2C%20ChatGPT%2C%20Gemini%20%EC%99%B8%29&url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch)
[![Reddit에 공유](https://img.shields.io/badge/Share-Reddit-FF4500?logo=reddit&logoColor=white)](https://reddit.com/submit?url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch&title=AIWatch%20%E2%80%94%2045%EA%B0%9C%20AI%20%EC%84%9C%EB%B9%84%EC%8A%A4%20%EC%8B%A4%EC%8B%9C%EA%B0%84%20%EC%9E%A5%EC%95%A0%20%EB%AA%A8%EB%8B%88%ED%84%B0%EB%A7%81)
[![Hacker News에 공유](https://img.shields.io/badge/Share-Hacker%20News-FF6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch&t=AIWatch%20%E2%80%94%20Real-time%20monitoring%20for%2045%20AI%20services)
[![LinkedIn에 공유](https://img.shields.io/badge/Share-LinkedIn-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fgithub.com%2Fbentleypark%2Faiwatch)

## 🛰️ 라이브 데모

**[ai-watch.dev](https://ai-watch.dev)** — 회원가입 불필요. Cloudflare Workers로 5분마다 갱신.

## 주요 기능

- **실시간 상태 모니터링** — 45개 AI 서비스의 정상 / 성능 저하 / 장애 상태
- **PWA 지원** — 홈 화면 추가, Service Worker 오프라인 캐시
- **지연시간 측정** — 33개 probe 대상 서비스의 엔드포인트 직접 RTT 측정, 나머지는 상태 페이지 응답 시간
- **24시간 지연시간 추세** — Chart.js 라인 차트 (5분 간격 probe 스냅샷)
- **인시던트 이력** — 다양한 상태 페이지 형식의 타임라인 상세 정보
- **가동률** — 제공사가 표시하는 %를 복사하지 않고, 제공사가 공개한 원기록으로부터 **AIWatch가 직접 계산**한 30일 가동률(가중: 전면 장애 1.0, 부분/성능저하 0.3, 사전 공지된 점검 제외). 이 공식에 맞지 않는 소스는 별도 라벨을 답니다 — 따라서 제공사 페이지의 %와 다를 수 있으며, 이는 설계된 동작입니다 ([계산 방식](https://ai-watch.dev/methodology))
- **구성요소 상태 분해** — 컴포넌트 단위로 추적하는 서비스의 서비스별 상세 + Is X Down에 구성요소별(모델·API 표면 등) 실시간 상태 표시. 많으면 섹션/모델 그룹으로 접힘
- **상태 캘린더** — 30일(Statuspage) 또는 14일(incident.io) 일별 상태 시각화
- **Discord & Slack 알림** — 상태 변경/인시던트 Discord Webhook + Slack 내장 `/feed` RSS 앱(설정 0) + RSS 피드
- **쿠키 동의** — GA4 Consent Mode v2 (동의/필수만)
- **딥링크** — hash 기반 라우팅 (`#claude`, `#latency`) — 특정 페이지로 직접 접근
- **다크/라이트 테마** — 시스템 설정 감지 + 수동 전환
- **한국어/영어** — 이중 언어 지원
- **모바일 반응형** — 사이드바 오버레이, 모바일 액션 바
- **AIWatch Score** — uptime, 인시던트, 복구 시간, probe 기반 응답성을 결합한 종합 신뢰도 점수 ([계산 방식](https://ai-watch.dev/methodology#score))
- **RTT 저하 감지** — AIWatch의 직접 API probe가 공식 상태 페이지에 보고되지 않는 지연(latency) 저하를 포착 (대시보드 배지 + Discord 일일 요약). 공식 발표 대비 ~5분 폴링 주기 내 독립 감지(MTTD)
- **리전별 가용성** — xAI, Gemini, OpenAI의 리전별 인시던트 상태 및 전환 추천
- **스마트 알림** — degraded/down 상태 Discord 알림 (anti-flapping + 인시던트 억제 + 복구 지속 시간)
- **오프라인 UI** — API 연결 불가 시 안내 화면 (프로덕션 전용)
- **Is X Down SEO 페이지** — 43개 서비스 (Bedrock/Azure OpenAI 제외한 모든 모니터링 대상), 동적 OG 이미지(PNG), 공유 버튼, AIWatch 순위 (대시보드와 동일한 동률 표기), 대체 서비스 추천
- **헬스체크 프로빙** — 서비스 엔드포인트 직접 RTT 측정 (33개 probe 대상) + 연속 스파이크 조기 장애 감지 및 RTT 저하 추적
- **페이지별 스켈레톤** — 각 페이지 레이아웃에 맞는 로딩 placeholder
- **AI 분석 (Beta)** — 장애 발생 시 하이브리드 AI 자동 분석 (Gemma 4 primary + Sonnet fallback): 원인 추정, 예상 복구 시간, 영향 범위, 대체 서비스 추천. 인시던트 Discord 알림에 통합(단일 embed), Topbar Analyze 모달, Is X Down AI Insight 카드
- **랜딩 페이지** — 랜딩 페이지(`/intro`), 대시보드 프리뷰 mock, KO/EN 이중 언어, Flow 애니메이션, `?banner=` 캠페인 슬롯(선택), GA4 트래킹
- **Chrome 확장 프로그램** — Claude 전용 툴바 배지 + 팝업으로 Claude API / claude.ai / Claude Code 실시간 상태, AIWatch Score, 진행 중 인시던트(AI 요약 포함), gated 커뮤니티 리포트, 원클릭 이슈 리포트 제공. lite `?src=ext-claude` API만 폴링하며 페이지 내용은 읽지 않음(데이터 수집 없음) — [Chrome 웹 스토어에서 설치](https://chromewebstore.google.com/detail/aiwatch-%E2%80%94-claude-status-d/mmngmhijlancegmfgcbegiackjkalocc)
- **Claude Code 플러그인 (Beta)** — 업스트림 AI 서비스가 다운되거나 복구되는 순간 알려주는 백그라운드 아웃티지 모니터 + 현재 인시던트(제목, 영향도, AI 요약, 대체 서비스)를 브리핑하는 `/aiwatch` 명령. 코드를 읽지 않고 데이터도 수집하지 않음. `/plugin marketplace add bentleypark/aiwatch` — [자세히](https://ai-watch.dev/plugin)
- **Web Vitals 모니터링** — 실사용자 LCP, FCP, TTFB, CLS, INP 수집, p75 집계 및 Discord Daily Report 임계값 알림
- **주간 브리핑** — 매주 일요일 Discord 다이제스트: AI 서비스 변경 감지(OpenAI, Google, Anthropic), 인시던트 요약, 안정성 트렌드
- **보안 모니터링** — Hacker News, Reddit(r/netsec, r/cybersecurity), OSV.dev를 통한 AI 서비스 보안 사고 감지 및 24개 AI SDK 패키지(PyPI + npm, Langchain 에코시스템 어댑터 포함) 취약점 스캔, 대시보드 알림 + Discord 다이제스트
- **상태 페이지 교차 검증** — Probe RTT + 플랫폼 쿼럼 + metastatuspage 모니터링으로 상태 페이지 인프라 장애 시 오탐 방지

## 모니터링 서비스

대시보드 카테고리 분류 기준(총 45개 — 사이드바 필터 / Overview 섹션과 동일).

### LLM API (16개)

| 서비스 | 제공업체 | 상태 소스 |
|--------|----------|-----------|
| Claude API | Anthropic | Atlassian Statuspage |
| OpenAI API | OpenAI | incident.io (Atlassian 호환) |
| Gemini API | Google | Google Cloud incidents.json |
| Mistral API | Mistral AI | Instatus (Nuxt SSR) |
| Cohere API | Cohere | incident.io (Atlassian 호환) |
| Groq Cloud | Groq | incident.io (Atlassian 호환) |
| Together AI | Together | Better Stack RSS + 가동률 API |
| Fireworks AI | Fireworks | incident.io (Atlassian 호환) |
| Cerebras Inference | Cerebras | Atlassian Statuspage |
| Perplexity | Perplexity AI | Instatus (Next.js SSR) |
| xAI API | xAI | RSS 피드 |
| DeepSeek API | DeepSeek | Flashduty (브라우저 렌더 피드) |
| Kimi (Moonshot AI) | Moonshot AI | Atlassian Statuspage (중국어 제목 → 영어) |
| OpenRouter | OpenRouter | OnlineOrNot (React Router SSR) |
| Amazon Bedrock | AWS | AWS Health Dashboard |
| Azure OpenAI | Microsoft | Azure Status RSS |

### 코딩 에이전트 (6개)

| 서비스 | 제공업체 |
|--------|----------|
| Claude Code | Anthropic |
| Codex | OpenAI |
| Cursor | Anysphere |
| GitHub Copilot | Microsoft |
| Windsurf | Codeium |
| Junie | JetBrains |

### 음성 (3개)

| 서비스 | 제공업체 | 상태 소스 |
|--------|----------|-----------|
| ElevenLabs | ElevenLabs | incident.io (Atlassian 호환) |
| AssemblyAI | AssemblyAI | Atlassian Statuspage |
| Deepgram | Deepgram | Atlassian Statuspage |

### 추론 & 인프라 (8개)

| 서비스 | 제공업체 | 상태 소스 |
|--------|----------|-----------|
| Hugging Face | HuggingFace | Better Stack RSS + 가동률 API |
| Replicate | Replicate | incident.io (Atlassian 호환) |
| fal.ai | fal | Instatus (Next.js) |
| Pinecone | Pinecone | Atlassian Statuspage |
| turbopuffer | turbopuffer | incident.io (Atlassian 호환) |
| Voyage AI | Voyage AI | Atlassian Statuspage |
| Modal | Modal | Better Stack RSS + 가동률 API |
| Twelve Labs | Twelve Labs | Atlassian Statuspage |

### 관측 (3개)

| 서비스 | 제공업체 | 상태 소스 |
|--------|----------|-----------|
| LangChain (LangSmith) | LangChain | incident.io (글로벌 페이지) |
| Helicone | Helicone | Better Stack RSS + 가동률 API |
| Langfuse | Langfuse | incident.io (Atlassian 호환) |

### 영상 (2개)

| 서비스 | 제공업체 | 상태 소스 |
|--------|----------|-----------|
| Runway | Runway | Atlassian Statuspage |
| Luma (Dream Machine) | Luma | Better Stack RSS + 가동률 API |

### 이미지 (2개)

| 서비스 | 제공업체 | 상태 소스 |
|--------|----------|-----------|
| Stability AI | Stability AI | incident.io (Atlassian 호환) |
| Black Forest Labs (FLUX) | Black Forest Labs | Atlassian Statuspage |

### AI 앱 (5개)

| 서비스 | 제공업체 |
|--------|----------|
| claude.ai | Anthropic |
| ChatGPT | OpenAI |
| Character.AI | Character AI |
| DeepSeek App | DeepSeek |
| Grok | xAI |

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
  ├── GET /api/status    → 병렬 fetch (45개 서비스) → 정규화
  ├── GET /api/uptime    → 일별 가동률 이력
  └── POST /api/alert   → Discord Webhook 프록시 (SSRF 보호)
  ↓
파서 (worker/src/parsers/)
  ├── impact-weights.ts  → 공유 MAJOR_WEIGHT/MINOR_WEIGHT (Atlassian 심각도 공식)
  ├── uptime-interval.ts → interval 기반 파서 공통 trailing-window 다운타임 누적기 (#1006)
  ├── statuspage.ts      → Atlassian Statuspage API + uptimeData HTML (일별 장애 초 단위로 uptime 계산)
  ├── incident-io.ts     → incident.io 호환 API + component_impacts 구간 (동일 가중치 공식으로 uptime 계산)
  ├── gcloud.ts          → Google Cloud incidents.json (Vertex Gemini)
  ├── aistudio.ts        → Google AI Studio + Gemini API (gcloud와 병합되는 2차 소스 — #310)
  ├── instatus.ts        → Instatus Nuxt/Next.js SSR
  ├── betterstack.ts     → Better Stack RSS + /index.json 가동률 API + dailyImpact (status_history)
  ├── onlineornot.ts     → OnlineOrNot React Router SSR (OpenRouter)
  ├── flashduty.ts       → Flashduty 피드 (DeepSeek + DeepSeek App — 예약 Action이 브라우저 렌더링, #618)
  └── aws.ts             → AWS Health events JSON API (Bedrock) + RSS (Azure OpenAI)
  ↓
Cloudflare KV
  ├── services:latest      (상태 캐시, TTL 5분)
  ├── daily:YYYY-MM-DD     (가동률 카운터, TTL 2일)
  ├── history:YYYY-MM-DD   (아카이브 카운터, TTL 90일)
  ├── latency:24h          (30분 스냅샷, 최대 48개, TTL 25시간)
  ├── probe:24h            (헬스체크 프로브, 최대 2016개, TTL 7일, 33개 probe 대상)
  ├── ai:analysis:{svcId}:{incId}  (AI 인시던트별 분석, TTL 1시간, 활성 시 갱신)
  ├── ai:reanalysis-skip:* (재분석 실패 쿨다운, 실패 유형별 TTL — #955)
  ├── ai:usage:{date}      (일별 AI 사용량 카운터, TTL 30일)
  ├── alerted:*            (알림 중복 방지 키, TTL 2시간-7일)
  ├── detected:{svcId}     (최초 감지 타임스탬프, TTL 7일)
  ├── probe-degradation:daily:{svcId}:{date} (RTT 저하 카운터, TTL 48시간, #464)
  ├── reddit:seen:{postId} (Reddit 게시글 중복 방지, TTL 24시간)
  └── vitals:{YYYY-MM-DD}  (Web Vitals 일별 집계, TTL 3일)
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
cd worker && npm install && cd ..
# 로컬 개발용 .dev.vars 생성:
echo "ALLOWED_ORIGIN=*" > worker/.dev.vars
# 레포 루트에서 실행 — 워커를 localhost:8788에 띄웁니다.
# 아래 프론트엔드 기본값 / VITE_API_URL과 일치합니다.
npm run dev:worker   # localhost:8788
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
npm test             # Playwright E2E 테스트
npm run test:src     # 프론트엔드 단위 테스트 (vitest — CSP 해시 핀 포함)
npm run test:worker  # Worker 단위 테스트 (vitest)

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
| `/feed.xml` | GET | 인시던트 RSS 2.0 — 전체 서비스 (Slack `/feed` 호환) |
| `/feed/:slug` | GET | 인시던트 RSS 2.0 — 개별 서비스 (slug 또는 service ID) |
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

응답 항목: `id`, `name`, `provider`, `category`, `group` (세분류 — llm / voice / inference / …), `status`, `latency`, `uptime30d`, `uptimeSource`, `lastChecked`, 최근 인시던트 5건 (개별 조회 시).

## 상태 배지

README, 문서, 블로그에 실시간 상태 배지를 임베드할 수 있습니다.

```markdown
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)
```

[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude)](https://ai-watch.dev/is-claude-down)

### 파라미터

| 파라미터 | 설명 | 예시 |
|---------|------|------|
| `uptime` | 가동률 % 표시 | `/badge/claude?uptime=true` |
| `style` | `flat` 또는 `flat-square` | `/badge/claude?style=flat-square` |
| `label` | 커스텀 라벨 | `/badge/claude?label=My+API` |

### 예시

[![OpenAI API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/openai)](https://ai-watch.dev/is-openai-down)
[![Gemini API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/gemini)](https://ai-watch.dev/is-gemini-down)
[![Claude API](https://aiwatch-worker.p2c2kbf.workers.dev/badge/claude?uptime=true)](https://ai-watch.dev/is-claude-down)
[![Cursor](https://aiwatch-worker.p2c2kbf.workers.dev/badge/cursor?style=flat-square)](https://ai-watch.dev/is-cursor-down)

### 사용 가능한 서비스 ID

모니터링 대상 전체 — `/api/v1/status`가 반환하는 것과 동일한 id.

| ID | 서비스 | ID | 서비스 |
|----|---------|----|---------|
| `claude` | Claude API | `elevenlabs` | ElevenLabs |
| `openai` | OpenAI API | `assemblyai` | AssemblyAI |
| `gemini` | Gemini API | `deepgram` | Deepgram |
| `bedrock` | Amazon Bedrock | `huggingface` | Hugging Face |
| `azureopenai` | Azure OpenAI | `replicate` | Replicate |
| `mistral` | Mistral API | `fal` | fal.ai |
| `cohere` | Cohere API | `modal` | Modal |
| `groq` | Groq Cloud | `voyageai` | Voyage AI |
| `together` | Together AI | `pinecone` | Pinecone |
| `fireworks` | Fireworks AI | `turbopuffer` | turbopuffer |
| `cerebras` | Cerebras Inference | `twelvelabs` | Twelve Labs |
| `perplexity` | Perplexity | `langsmith` | LangChain (LangSmith) |
| `xai` | xAI API | `helicone` | Helicone |
| `deepseek` | DeepSeek API | `langfuse` | Langfuse |
| `kimi` | Kimi (Moonshot AI) | `runway` | Runway |
| `openrouter` | OpenRouter | `luma` | Luma (Dream Machine) |
| `claudecode` | Claude Code | `stability` | Stability AI |
| `codex` | Codex | `bfl` | Black Forest Labs (FLUX) |
| `cursor` | Cursor | `claudeai` | claude.ai |
| `copilot` | GitHub Copilot | `chatgpt` | ChatGPT |
| `windsurf` | Windsurf | `characterai` | Character.AI |
| `junie` | Junie | `deepseekapp` | DeepSeek App |
| `grok` | Grok | | |

## Claude Code Statusline 통합

Claude API, OpenAI, Gemini, GitHub Copilot 등 45개 AI 서비스의 장애 여부를 [Claude Code 스테이터스라인](https://docs.claude.com/en/docs/claude-code/statusline)에 직접 표시합니다. 추천 프리셋은 항상 표시되는 클릭 가능한 **AIWatch** 라벨을 유지합니다 — 모두 정상이면 `AIWatch 🟢`, 장애 시 `AIWatch 🔴 Claude API`, 라벨 cmd/ctrl+클릭 시 대시보드 열림. 정상일 때 공간을 비우고 싶으면 [프리셋 페이지](https://ai-watch.dev/#statusline)의 minimalist 프리셋을 쓰면 됩니다.

가장 빠른 설정 — `~/.claude/settings.json`에 추가:

```json
{
  "statusLine": {
    "type": "command",
    "command": "( curl -sf --max-time 2 https://aiwatch-worker.p2c2kbf.workers.dev/api/statusline/branded ) 2>/dev/null || true"
  }
}
```

> 클릭 가능한 라벨은 OSC 8 지원 터미널(iTerm2, Warp, kitty, WezTerm, VS Code 터미널, macOS 12+ Terminal.app)에서 동작하고, 미지원은 plain text로 표시됩니다. Worker 도메인을 직접 호출해 렌더링당 폴링이 Vercel 대역폭으로 잡히지 않습니다.

프리셋 모음 — **minimalist**(정상 시 빈 출력), 컴팩트 배지, 전체 목록, 특정 프로바이더만, 서비스별 clickable 링크: **[ai-watch.dev/#statusline](https://ai-watch.dev/#statusline)**

특성: 렌더링당 단일 GET, Cloudflare edge에 5분 KV 캐시, 2초 타임아웃, `jq` 의존성 없음, Anthropic API 호출 없음, 클라이언트 식별자 미수집. 네트워크 에러 시에는 줄이 비고, AIWatch가 자체 상태 스냅샷을 읽지 못할 때는 근거 없는 초록 대신 `AIWatch ⚪`(unknown)를 표시합니다. shell 명령 출력을 지원하는 모든 statusline 도구와 호환 (`ccstatusline`의 Custom Command 위젯 포함).

## Claude Code 플러그인 (Beta)

상태 바를 넘어, [AIWatch Claude Code 플러그인](https://ai-watch.dev/plugin)은 Claude Code 안에서 AI 장애를 두 가지로 알려줍니다:

- **백그라운드 아웃티지 모니터** — 모니터링 중인 프로바이더가 다운(`🔴 Claude API is down`)되거나 복구(`✅ Claude API has recovered`)되는 순간, 서비스명을 명시해 알림. 매 폴링(기본 60초)을 이전과 diff하여 **실제 상태 변화 시에만** 알리므로 스팸이 없음.
- **`/aiwatch` 명령** — 지금 degraded/down인 AI 서비스를 각각의 진행 인시던트(제목+영향도), AI 요약, 대체 서비스 제안과 함께 브리핑.

코드를 읽지 않고 데이터도 수집하지 않으며 — AIWatch 공개 상태 피드만 폴링. AIWatch 자체 마켓플레이스에서 설치:

```
/plugin marketplace add bentleypark/aiwatch
/plugin install aiwatch@aiwatch-dev
```

소스 + 문서: [`plugin/aiwatch/`](plugin/aiwatch/). 자세히: **[ai-watch.dev/plugin](https://ai-watch.dev/plugin)**.

## 프로젝트 구조

```
src/                   # React 19 SPA (Vite, 라우터 없음 — App.jsx의 hash 라우팅)
  components/          # 공유 UI: StatusPill, SkeletonUI, EmptyState, Modal, Sidebar, Topbar, CookieBanner, AnalysisModal, …
  pages/               # Overview, Latency, Incidents, Uptime, ServiceDetails, Settings, Ranking, Statusline
  hooks/               # usePolling, useTheme, useLang, useSettings, useGitHubStars, useMonthlyArchives
  utils/               # analytics, calendar, time, pageContext, constants, hashRoute, …
  locales/             # ko.js, en.js (flat key→string 맵)
api/                   # 헬퍼는 `_` 접두 디렉터리에, 핸들러는 edge 런타임에 —
                       # 따라서 둘 다 Hobby 12-Serverless-Function 한도에 계산되지 않음 (#862/#867)
  intro.ts             # 랜딩 페이지 (/intro)                _intro/       # SSR 템플릿
  is-down.ts           # "Is X Down?" SSR 페이지 (43개 서비스)   _is-down/  # slug-map, seo-content, 템플릿
  methodology.ts       # "How AIWatch Works" (/methodology)  _methodology/
  plugin.ts            # Claude Code 플러그인 랜딩            _plugin/
  badges.ts            # 상태 배지 갤러리 (/badges)          _badges/
  reports.ts           # /reports/* 프록시 → Jekyll 사이트   _shared/      # 공유 Edge 헬퍼
  confirm.ts csp-report.ts plugin-privacy.ts extension-privacy.ts
public/
  manifest.json        # PWA 매니페스트
  sw.js                # Service Worker (stale-while-revalidate)
  icon-192.png         # PWA 아이콘 192x192
  icon-512.png         # PWA 아이콘 512x512
scripts/               # 빌드/CI/운영 스크립트 (OG 생성, CI 린트 게이트, verify-reminders 등)
worker/
  src/
    index.ts           # Worker 진입점: CORS, 라우팅, /api/*, /badge, /feed, cron scheduled 핸들러
    services.ts        # 서비스 설정 + fetch 오케스트레이터 + 상태 판정
    types.ts utils.ts  # 공유 타입 + 공유 유틸리티
    score.ts           # AIWatch Score 계산
    alerts.ts          # 알림 감지 (인시던트 + 상태 전이), hold, 병합
    ai-analysis.ts     # 하이브리드 AI 장애 분석 (Gemma 4 primary + Sonnet fallback)
    anthropic.ts       # Anthropic Messages REST 호출 (모델 id, 재시도, 상태 분류)
    probe.ts           # 헬스체크 프로빙 — 직접 RTT 측정 (`PROBE_TARGETS`)
    rss.ts badge.ts og.ts og-render.ts   # 피드, 배지, OG 이미지
    daily-summary.ts weekly-briefing.ts monthly-archive.ts monthly-narrative.ts
    security-monitor.ts   # AI 서비스 보안 모니터링 (HN Algolia, OSV.dev SDK 취약점 — 24개 추적 패키지)
    changelog.ts reddit.ts platform-monitor.ts
    suppression.ts overrides.ts withdrawn.ts upstream-link.ts   # 운영자 + 인시던트 레이어
    parsers/           # 플랫폼별 파서
      statuspage.ts    # Atlassian Statuspage
      incident-io.ts   # incident.io (Atlassian 호환 API)
      gcloud.ts        # Google Cloud Vertex (gemini 1차 소스)
      aistudio.ts      # Google AI Studio + Gemini API (gemini 2차 소스, #310)
      instatus.ts      # Instatus
      betterstack.ts   # Better Stack
      onlineornot.ts   # OnlineOrNot (OpenRouter)
      flashduty.ts     # Flashduty (DeepSeek + DeepSeek App)
      aws.ts           # AWS Health events JSON API — Bedrock (+ Azure OpenAI는 RSS 파서 재사용)
      impact-weights.ts uptime-interval.ts   # 공유 uptime 프리미티브 (#1006)
    __tests__/ parsers/__tests__/   # Vitest 단위 테스트
```

> 전체 목록이 아니라 지도입니다 — `worker/src/`에는 모듈이 약 50개 있습니다. 모듈별 역할과 그것을
> 만든 이슈들은 **[docs/reference/directory-map.md](docs/reference/directory-map.md)** 에 있습니다.

## 기여하기

자세한 가이드는 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

모든 코딩 에이전트는 [AGENTS.md](AGENTS.md)와 [에이전트 공통 개발 워크플로우](docs/reference/development-workflow.md)부터
읽으세요. Claude Code 기여자는 Claude 전용 자동화 규칙을 위해 [CLAUDE.md](CLAUDE.md)도 함께 읽어야 합니다.

1. 레포지토리 포크
2. 기능 브랜치 생성 (`git checkout -b feature/my-feature`)
3. [AGENTS.md](AGENTS.md)와 [에이전트 공통 개발 워크플로우](docs/reference/development-workflow.md) 따르기 — Claude Code 기여자는 [CLAUDE.md](CLAUDE.md)도 함께
4. 빌드 + 테스트: `npm run build && npm test && npm run test:src && npm run test:worker`
5. [PR 템플릿](.github/pull_request_template.md)으로 풀 리퀘스트 제출

### 이슈

- **버그 리포트**: [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) 템플릿 사용
- **기능 요청**: [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) 템플릿 사용

### 풀 리퀘스트

- PR당 하나의 기능 또는 수정
- 모든 테스트 통과 (`npm test` + `npm run test:src` + `npm run test:worker`) — CI 게이트, E2E는 프론트엔드 변경 시 실행
- 커밋 메시지에 `closes #N` 포함
- PR 체크리스트 작성

## 보안

취약점을 발견하셨나요? [SECURITY.md](SECURITY.md)를 참고하여 책임감 있게 신고해 주세요.

## 라이선스

[AGPL-3.0](LICENSE)
