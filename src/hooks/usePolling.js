// usePolling — fetches live service status from Cloudflare Worker proxy.
// Falls back to mock data when Worker is unavailable (local dev without worker).
// Return shape: { services, loading, error, lastUpdated, refresh }

import { useState, useEffect, useCallback, useRef, createContext, useContext, createElement } from 'react'
const POLL_INTERVAL = 60_000 // 60s

// Worker API URL — defaults to local dev, override via env
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787/api/status'

// ── Mock data fallback (used when Worker is unavailable) ──

const REF = new Date('2026-03-19T10:00:00Z')
const ago = (ms) => new Date(REF - ms).toISOString()
const M = 60_000
const H = 3_600_000
const D = 86_400_000

function hist(degraded = [], down = []) {
  return Array.from({ length: 30 }, (_, i) => {
    if (down.includes(i)) return 'down'
    if (degraded.includes(i)) return 'degraded'
    return 'operational'
  })
}

const MOCK_SERVICES = [
  {
    id: 'claudeai', category: 'webapp', name: 'claude.ai', provider: 'Anthropic', status: 'operational',
    latency: null, uptime30d: 99.00,
    history30d: hist([3, 9, 13, 19, 27]),
    history3m: [{ month: '2026-01', uptime: 99.40 }, { month: '2026-02', uptime: 99.10 }, { month: '2026-03', uptime: 99.00 }],
    incidents: [],
  },
  {
    id: 'claude', category: 'api', name: 'Claude API', provider: 'Anthropic', status: 'operational',
    latency: 145, uptime30d: 99.97,
    history30d: hist([27]),
    history3m: [{ month: '2026-01', uptime: 99.99 }, { month: '2026-02', uptime: 99.98 }, { month: '2026-03', uptime: 99.97 }],
    incidents: [
      {
        id: 'cl-1', title: 'Elevated errors on Claude Opus 4.6', startedAt: ago(1 * D), duration: '17m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Claude Opus 4.6 모델에서 오류율 증가가 감지되었습니다.', at: ago(1 * D) },
          { stage: 'resolved',      text: '오류율이 정상 수준으로 돌아왔습니다.', at: ago(1 * D - 17 * M) },
        ],
      },
      {
        id: 'cl-2', title: 'Elevated Errors on Sonnet', startedAt: ago(4 * D), duration: '38m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Claude Sonnet에서 오류율 증가가 감지되었습니다.', at: ago(4 * D) },
          { stage: 'resolved',      text: '38분 만에 정상화되었습니다.', at: ago(4 * D - 38 * M) },
        ],
      },
      {
        id: 'cl-3', title: 'Login Issues & Slow Performance', startedAt: ago(6 * D), duration: '2h 44m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '로그인 실패 및 전반적인 성능 저하가 보고되고 있습니다.', at: ago(6 * D) },
          { stage: 'identified',    text: '인증 서버 과부하로 원인이 파악되었습니다.', at: ago(6 * D - 43 * M) },
          { stage: 'monitoring',    text: '수정을 적용했습니다. 모니터링 중입니다.', at: ago(6 * D - 158 * M) },
          { stage: 'resolved',      text: '서비스가 완전히 정상화되었습니다.', at: ago(6 * D - 164 * M) },
        ],
      },
    ],
  },
  {
    id: 'openai', category: 'api', name: 'OpenAI API', provider: 'OpenAI', status: 'degraded',
    latency: 312, uptime30d: 99.21, detectedAt: ago(4 * H + 7 * M),
    history30d: hist([22, 23, 28]),
    history3m: [{ month: '2026-01', uptime: 99.80 }, { month: '2026-02', uptime: 99.65 }, { month: '2026-03', uptime: 99.21 }],
    incidents: [
      {
        id: 'oi-1', title: 'Elevated API Error Rates', startedAt: ago(2 * D), duration: '2h 14m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '오류율 증가가 감지되었습니다. 조사 중입니다.', at: ago(2 * D) },
          { stage: 'identified',    text: '모델 추론 레이어에서 문제가 확인되었습니다.', at: ago(2 * D - 30 * M) },
          { stage: 'monitoring',    text: '수정을 적용했습니다. 결과를 모니터링 중입니다.', at: ago(2 * D - 75 * M) },
          { stage: 'resolved',      text: '서비스가 정상화되었습니다.', at: ago(2 * D - 134 * M) },
        ],
      },
      {
        id: 'oi-2', title: 'Increased Latency on Chat Endpoint', startedAt: ago(4 * H), duration: null, status: 'monitoring',
        timeline: [
          { stage: 'investigating', text: 'P99 레이턴시가 정상 수준의 2배 이상으로 증가했습니다.', at: ago(4 * H) },
          { stage: 'identified',    text: '추론 서버 과부하로 원인이 파악되었습니다.', at: ago(3 * H) },
          { stage: 'monitoring',    text: '부분적인 완화 조치를 적용했습니다.', at: ago(2 * H) },
        ],
      },
      {
        id: 'oi-3', title: 'Sora Video Generation Failing', startedAt: ago(3 * D), duration: '4h 12m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Sora 비디오 생성 요청이 실패하고 있습니다.', at: ago(3 * D) },
          { stage: 'identified',    text: 'GPU 클러스터 메모리 부족으로 확인.', at: ago(3 * D - 45 * M) },
          { stage: 'resolved',      text: '용량 확장 후 정상화되었습니다.', at: ago(3 * D - 252 * M) },
        ],
      },
      {
        id: 'oi-4', title: 'API Rate Limit Misconfiguration', startedAt: ago(5 * D), duration: '52m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '일부 사용자의 rate limit이 비정상적으로 낮게 설정되었습니다.', at: ago(5 * D) },
          { stage: 'resolved',      text: '설정을 복구했습니다.', at: ago(5 * D - 52 * M) },
        ],
      },
    ],
  },
  {
    id: 'chatgpt', category: 'webapp', name: 'ChatGPT', provider: 'OpenAI', status: 'operational',
    latency: null, uptime30d: 98.20,
    history30d: hist([1, 4, 8, 12, 18, 22, 28]),
    history3m: [{ month: '2026-01', uptime: 98.90 }, { month: '2026-02', uptime: 97.50 }, { month: '2026-03', uptime: 98.20 }],
    incidents: [
      { id: 'cg-1', title: 'Slow Response Times', startedAt: ago(1 * D + 3 * H), duration: '1h 20m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'ChatGPT 응답 시간이 평소보다 느립니다.', at: ago(1 * D + 3 * H) },
          { stage: 'resolved', text: '캐시 서버 재시작 후 정상화.', at: ago(1 * D + 3 * H - 80 * M) },
        ] },
      { id: 'cg-2', title: 'Image Upload Failures', startedAt: ago(3 * D + 5 * H), duration: '45m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '이미지 업로드가 간헐적으로 실패합니다.', at: ago(3 * D + 5 * H) },
          { stage: 'resolved', text: 'CDN 설정 복구 후 정상화.', at: ago(3 * D + 5 * H - 45 * M) },
        ] },
      { id: 'cg-3', title: 'Login Errors for Some Users', startedAt: ago(5 * D), duration: '2h 10m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '일부 사용자가 로그인에 실패하고 있습니다.', at: ago(5 * D) },
          { stage: 'identified', text: 'OAuth 토큰 갱신 문제로 확인.', at: ago(5 * D - 30 * M) },
          { stage: 'resolved', text: '토큰 서비스 패치 후 정상화.', at: ago(5 * D - 130 * M) },
        ] },
    ],
  },
  {
    id: 'gemini', category: 'api', name: 'Gemini API', provider: 'Google', status: 'operational',
    latency: 198, uptime30d: 99.85,
    history30d: hist([14]),
    history3m: [{ month: '2026-01', uptime: 99.95 }, { month: '2026-02', uptime: 99.90 }, { month: '2026-03', uptime: 99.85 }],
    incidents: [
      { id: 'gm-1', title: 'Intermittent 503 Errors', startedAt: ago(2 * D + 7 * H), duration: '55m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Gemini API에서 간헐적 503 오류가 발생 중입니다.', at: ago(2 * D + 7 * H) },
          { stage: 'resolved', text: '로드밸런서 설정 수정 후 정상화.', at: ago(2 * D + 7 * H - 55 * M) },
        ] },
      { id: 'gm-2', title: 'High Latency on Gemini Pro', startedAt: ago(5 * D + 2 * H), duration: '1h 45m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Gemini Pro 모델 응답 지연이 발생하고 있습니다.', at: ago(5 * D + 2 * H) },
          { stage: 'identified', text: 'TPU 클러스터 스케줄링 문제로 확인.', at: ago(5 * D + 2 * H - 40 * M) },
          { stage: 'resolved', text: '클러스터 재배치 후 정상화.', at: ago(5 * D + 2 * H - 105 * M) },
        ] },
    ],
  },
  {
    id: 'mistral', category: 'api', name: 'Mistral API', provider: 'Mistral AI', status: 'operational',
    latency: 89, uptime30d: 99.92,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.97 }, { month: '2026-02', uptime: 99.95 }, { month: '2026-03', uptime: 99.92 }],
    incidents: [
      { id: 'ms-1', title: 'Embedding Endpoint Timeout', startedAt: ago(3 * D + 1 * H), duration: '28m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Embedding API가 타임아웃되고 있습니다.', at: ago(3 * D + 1 * H) },
          { stage: 'resolved', text: '백엔드 재시작으로 정상화.', at: ago(3 * D + 1 * H - 28 * M) },
        ] },
      { id: 'ms-2', title: 'Rate Limiting Errors', startedAt: ago(6 * D + 4 * H), duration: '1h 12m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Rate limit 오류가 비정상적으로 많이 발생 중입니다.', at: ago(6 * D + 4 * H) },
          { stage: 'identified', text: 'Rate limiter 설정 오류로 확인.', at: ago(6 * D + 4 * H - 25 * M) },
          { stage: 'resolved', text: '설정 롤백 후 정상화.', at: ago(6 * D + 4 * H - 72 * M) },
        ] },
    ],
  },
  {
    id: 'cohere', category: 'api', name: 'Cohere API', provider: 'Cohere', status: 'operational',
    latency: 234, uptime30d: 99.50,
    history30d: hist([8]),
    history3m: [{ month: '2026-01', uptime: 99.72 }, { month: '2026-02', uptime: 99.60 }, { month: '2026-03', uptime: 99.50 }],
    incidents: [
      { id: 'co-1', title: 'Chat Models Unresponsive', startedAt: ago(2 * D + 10 * H), duration: '1h 17m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '일부 채팅 모델이 응답하지 않습니다.', at: ago(2 * D + 10 * H) },
          { stage: 'monitoring', text: '서버 재시작을 적용했습니다.', at: ago(2 * D + 10 * H - 50 * M) },
          { stage: 'resolved', text: '전체 모델이 정상 응답 중입니다.', at: ago(2 * D + 10 * H - 77 * M) },
        ] },
    ],
  },
  {
    id: 'groq', category: 'api', name: 'Groq Cloud', provider: 'Groq', status: 'operational',
    latency: 52, uptime30d: 99.95,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.98 }, { month: '2026-02', uptime: 99.97 }, { month: '2026-03', uptime: 99.95 }],
    incidents: [
      { id: 'gq-1', title: 'Increased Error Rate on LLaMA', startedAt: ago(4 * D + 6 * H), duration: '35m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'LLaMA 모델 호출 시 오류율이 증가했습니다.', at: ago(4 * D + 6 * H) },
          { stage: 'resolved', text: '모델 인스턴스 교체 후 정상화.', at: ago(4 * D + 6 * H - 35 * M) },
        ] },
    ],
  },
  {
    id: 'together', category: 'api', name: 'Together AI', provider: 'Together', status: 'operational',
    latency: 178, uptime30d: 99.72,
    history30d: hist([19]),
    history3m: [{ month: '2026-01', uptime: 99.85 }, { month: '2026-02', uptime: 99.78 }, { month: '2026-03', uptime: 99.72 }],
    incidents: [
      { id: 'tg-1', title: 'API Gateway Errors', startedAt: ago(1 * D + 8 * H), duration: '42m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'API 게이트웨이에서 502 오류가 다수 발생 중입니다.', at: ago(1 * D + 8 * H) },
          { stage: 'resolved', text: '게이트웨이 인스턴스 롤링 재시작으로 정상화.', at: ago(1 * D + 8 * H - 42 * M) },
        ] },
      { id: 'tg-2', title: 'Inference Queue Delays', startedAt: ago(5 * D + 11 * H), duration: '1h 30m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '추론 큐 처리가 지연되고 있습니다.', at: ago(5 * D + 11 * H) },
          { stage: 'identified', text: '큐 워커 스케일링 문제로 확인.', at: ago(5 * D + 11 * H - 35 * M) },
          { stage: 'resolved', text: '워커 수 증가 후 정상화.', at: ago(5 * D + 11 * H - 90 * M) },
        ] },
    ],
  },
  {
    id: 'perplexity', category: 'api', name: 'Perplexity', provider: 'Perplexity AI', status: 'operational',
    latency: 420, uptime30d: 99.33,
    history30d: hist([5, 6]),
    history3m: [{ month: '2026-01', uptime: 99.60 }, { month: '2026-02', uptime: 99.45 }, { month: '2026-03', uptime: 99.33 }],
    incidents: [
      { id: 'pp-1', title: 'Search Index Stale', startedAt: ago(2 * D + 1 * H), duration: '3h 10m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '검색 인덱스가 갱신되지 않고 있습니다.', at: ago(2 * D + 1 * H) },
          { stage: 'identified', text: '인덱싱 파이프라인 장애로 확인.', at: ago(2 * D + 1 * H - 40 * M) },
          { stage: 'monitoring', text: '파이프라인 복구 후 재인덱싱 중.', at: ago(2 * D + 1 * H - 150 * M) },
          { stage: 'resolved', text: '인덱스가 최신 상태로 복구.', at: ago(2 * D + 1 * H - 190 * M) },
        ] },
      { id: 'pp-2', title: 'Elevated Latency', startedAt: ago(6 * D + 3 * H), duration: '50m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '전체적인 응답 지연이 발생 중입니다.', at: ago(6 * D + 3 * H) },
          { stage: 'resolved', text: '캐시 레이어 복구 후 정상화.', at: ago(6 * D + 3 * H - 50 * M) },
        ] },
    ],
  },
  {
    id: 'huggingface', category: 'api', name: 'Hugging Face', provider: 'Hugging Face', status: 'degraded',
    latency: 890, uptime30d: 98.52,
    history30d: hist([10, 20, 25], [15, 16, 17]),
    history3m: [{ month: '2026-01', uptime: 99.20 }, { month: '2026-02', uptime: 98.80 }, { month: '2026-03', uptime: 98.52 }],
    incidents: [
      {
        id: 'hf-1', title: 'Model Inference Slowdown', startedAt: ago(1 * D), duration: null, status: 'monitoring',
        timeline: [
          { stage: 'investigating', text: '모델 추론 속도가 현저히 저하되고 있습니다.', at: ago(1 * D) },
          { stage: 'identified',    text: 'GPU 메모리 단편화로 원인이 파악되었습니다.', at: ago(1 * D - 2 * H) },
          { stage: 'monitoring',    text: '메모리 정리 작업을 수행 중입니다.', at: ago(1 * D - 4 * H) },
        ],
      },
      {
        id: 'hf-2', title: 'Inference API Outage', startedAt: ago(15 * D), duration: '8h 32m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Inference API 전체 장애가 발생했습니다.', at: ago(15 * D) },
          { stage: 'identified',    text: '데이터센터 네트워크 장비 장애로 확인.', at: ago(15 * D - 1 * H) },
          { stage: 'monitoring',    text: '네트워크 복구 후 서비스 재시작 중입니다.', at: ago(15 * D - 3 * H) },
          { stage: 'resolved',      text: '전체 서비스가 정상화되었습니다.', at: ago(15 * D - 512 * M) },
        ],
      },
    ],
  },
  {
    id: 'replicate', category: 'api', name: 'Replicate', provider: 'Replicate', status: 'operational',
    latency: 267, uptime30d: 99.61,
    history30d: hist([3]),
    history3m: [{ month: '2026-01', uptime: 99.80 }, { month: '2026-02', uptime: 99.70 }, { month: '2026-03', uptime: 99.61 }],
    incidents: [
      { id: 'rp-1', title: 'Cold Start Failures', startedAt: ago(1 * D + 5 * H), duration: '1h 5m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '콜드 스타트 시 모델 로드가 실패합니다.', at: ago(1 * D + 5 * H) },
          { stage: 'identified', text: '스토리지 I/O 병목으로 확인.', at: ago(1 * D + 5 * H - 30 * M) },
          { stage: 'resolved', text: 'SSD 캐시 계층 추가 후 정상화.', at: ago(1 * D + 5 * H - 65 * M) },
        ] },
      { id: 'rp-2', title: 'Webhook Delivery Delays', startedAt: ago(4 * D + 2 * H), duration: '2h 20m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Webhook 전송이 지연되고 있습니다.', at: ago(4 * D + 2 * H) },
          { stage: 'resolved', text: '메시지 큐 확장으로 정상화.', at: ago(4 * D + 2 * H - 140 * M) },
        ] },
    ],
  },
  {
    id: 'elevenlabs', category: 'api', name: 'ElevenLabs', provider: 'ElevenLabs', status: 'operational',
    latency: 156, uptime30d: 99.80,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.90 }, { month: '2026-02', uptime: 99.85 }, { month: '2026-03', uptime: 99.80 }],
    incidents: [
      { id: 'el-1', title: 'Voice Cloning Failures', startedAt: ago(3 * D + 9 * H), duration: '48m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '보이스 클로닝 요청이 실패하고 있습니다.', at: ago(3 * D + 9 * H) },
          { stage: 'resolved', text: 'GPU 워커 재시작 후 정상화.', at: ago(3 * D + 9 * H - 48 * M) },
        ] },
    ],
  },
  {
    id: 'xai', category: 'api', name: 'xAI (Grok)', provider: 'xAI', status: 'degraded',
    latency: 203, uptime30d: 99.75,
    history30d: hist([24]),
    history3m: [{ month: '2026-01', uptime: 99.82 }, { month: '2026-02', uptime: 99.79 }, { month: '2026-03', uptime: 99.75 }],
    incidents: [
      { id: 'xa-0', title: 'eu-west-1.api.x.ai went down', startedAt: ago(2 * H), duration: null, status: 'investigating',
        timeline: [
          { stage: 'investigating', text: 'EU region API endpoint is experiencing errors.', at: ago(2 * H) },
        ] },
      { id: 'xa-1', title: 'Authentication Errors', startedAt: ago(2 * D + 14 * H), duration: '22m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'API 인증 오류가 다수 발생 중입니다.', at: ago(2 * D + 14 * H) },
          { stage: 'resolved', text: '인증 서버 설정 복구.', at: ago(2 * D + 14 * H - 22 * M) },
        ] },
    ],
  },
  {
    id: 'deepseek', category: 'api', name: 'DeepSeek API', provider: 'DeepSeek', status: 'operational',
    latency: 321, uptime30d: 99.40,
    history30d: hist([11]),
    history3m: [{ month: '2026-01', uptime: 99.55 }, { month: '2026-02', uptime: 99.48 }, { month: '2026-03', uptime: 99.40 }],
    incidents: [
      { id: 'ds-1', title: 'API Response Truncation', startedAt: ago(1 * D + 12 * H), duration: '1h 33m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'API 응답이 중간에 잘리는 현상이 보고되었습니다.', at: ago(1 * D + 12 * H) },
          { stage: 'identified', text: '프록시 버퍼 크기 설정 오류로 확인.', at: ago(1 * D + 12 * H - 40 * M) },
          { stage: 'resolved', text: '버퍼 크기 증가 후 정상화.', at: ago(1 * D + 12 * H - 93 * M) },
        ] },
      { id: 'ds-2', title: 'Elevated Error Rates', startedAt: ago(4 * D + 8 * H), duration: '2h 5m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '전반적인 오류율이 증가했습니다.', at: ago(4 * D + 8 * H) },
          { stage: 'monitoring', text: '핫픽스를 배포했습니다.', at: ago(4 * D + 8 * H - 90 * M) },
          { stage: 'resolved', text: '오류율이 정상 범위로 복귀.', at: ago(4 * D + 8 * H - 125 * M) },
        ] },
    ],
  },
  {
    id: 'openrouter', category: 'api', name: 'OpenRouter', provider: 'OpenRouter', status: 'operational',
    latency: 580, uptime30d: 99.89,
    history30d: hist([2, 3]),
    history3m: [{ month: '2026-01', uptime: 99.85 }, { month: '2026-02', uptime: 99.70 }, { month: '2026-03', uptime: 99.89 }],
    incidents: [],
  },
  {
    id: 'claudecode', category: 'agent', name: 'Claude Code', provider: 'Anthropic', status: 'operational',
    latency: null, uptime30d: 99.00,
    history30d: hist([5, 13, 21, 29]),
    history3m: [{ month: '2026-01', uptime: 99.50 }, { month: '2026-02', uptime: 99.20 }, { month: '2026-03', uptime: 99.00 }],
    incidents: [
      { id: 'cc-1', title: 'Session Disconnect Issues', startedAt: ago(2 * D + 6 * H), duration: '1h 15m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '세션이 간헐적으로 끊기는 현상이 보고되었습니다.', at: ago(2 * D + 6 * H) },
          { stage: 'identified', text: 'WebSocket 연결 관리 버그로 확인.', at: ago(2 * D + 6 * H - 30 * M) },
          { stage: 'resolved', text: '패치 배포 후 정상화.', at: ago(2 * D + 6 * H - 75 * M) },
        ] },
    ],
  },
  {
    id: 'copilot', category: 'agent', name: 'GitHub Copilot', provider: 'Microsoft', status: 'operational',
    latency: null, uptime30d: 99.40,
    history30d: hist([9, 24]),
    history3m: [{ month: '2026-01', uptime: 99.60 }, { month: '2026-02', uptime: 99.50 }, { month: '2026-03', uptime: 99.40 }],
    incidents: [
      { id: 'cp-1', title: 'Code Completion Degraded', startedAt: ago(1 * D + 2 * H), duration: null, status: 'monitoring',
        timeline: [
          { stage: 'investigating', text: '코드 자동 완성 품질이 저하되고 있습니다.', at: ago(1 * D + 2 * H) },
          { stage: 'identified', text: '모델 서빙 레이어 이슈로 확인.', at: ago(1 * D + 2 * H - 45 * M) },
          { stage: 'monitoring', text: '모델 롤백을 적용했습니다. 모니터링 중.', at: ago(1 * D + 2 * H - 90 * M) },
        ] },
      { id: 'cp-2', title: 'GitHub Actions Integration Error', startedAt: ago(3 * D + 7 * H), duration: '1h 50m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'GitHub Actions에서 Copilot 연동 오류가 발생.', at: ago(3 * D + 7 * H) },
          { stage: 'resolved', text: 'API 엔드포인트 수정으로 정상화.', at: ago(3 * D + 7 * H - 110 * M) },
        ] },
    ],
  },
  {
    id: 'cursor', category: 'agent', name: 'Cursor', provider: 'Anysphere', status: 'operational',
    latency: null, uptime30d: 99.20,
    history30d: hist(),
    history3m: [{ month: '2026-01', uptime: 99.40 }, { month: '2026-02', uptime: 99.30 }, { month: '2026-03', uptime: 99.20 }],
    incidents: [
      { id: 'cu-1', title: 'Tab Completion Not Working', startedAt: ago(2 * D + 4 * H), duration: '33m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Tab 자동 완성이 동작하지 않습니다.', at: ago(2 * D + 4 * H) },
          { stage: 'resolved', text: '백엔드 서비스 재시작으로 정상화.', at: ago(2 * D + 4 * H - 33 * M) },
        ] },
      { id: 'cu-2', title: 'Agent Mode Timeout', startedAt: ago(5 * D + 6 * H), duration: '1h 22m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: 'Agent 모드에서 타임아웃이 발생합니다.', at: ago(5 * D + 6 * H) },
          { stage: 'identified', text: '추론 서버 메모리 부족으로 확인.', at: ago(5 * D + 6 * H - 35 * M) },
          { stage: 'resolved', text: '서버 스케일업 후 정상화.', at: ago(5 * D + 6 * H - 82 * M) },
        ] },
    ],
  },
  {
    id: 'windsurf', category: 'agent', name: 'Windsurf', provider: 'Codeium', status: 'operational',
    latency: null, uptime30d: 98.80,
    history30d: hist([10, 27]),
    history3m: [{ month: '2026-01', uptime: 99.20 }, { month: '2026-02', uptime: 99.00 }, { month: '2026-03', uptime: 98.80 }],
    incidents: [
      { id: 'ws-1', title: 'Autocomplete Service Down', startedAt: ago(3 * D + 3 * H), duration: '2h 8m', status: 'resolved',
        timeline: [
          { stage: 'investigating', text: '자동 완성 서비스가 응답하지 않습니다.', at: ago(3 * D + 3 * H) },
          { stage: 'identified', text: '배포 롤백이 필요한 상황으로 확인.', at: ago(3 * D + 3 * H - 50 * M) },
          { stage: 'monitoring', text: '이전 버전으로 롤백을 완료했습니다.', at: ago(3 * D + 3 * H - 100 * M) },
          { stage: 'resolved', text: '서비스가 정상화되었습니다.', at: ago(3 * D + 3 * H - 128 * M) },
        ] },
    ],
  },
]

// ── Merge live Worker data with mock fallback ──
// Worker provides: id, name, provider, category, status, latency, incidents
// Mock provides: uptime30d, history30d, history3m (not available from Worker yet)
// Merge: start from mock list (preserves order + all services), overlay live data
function mergeWithMock(liveServices) {
  const liveMap = Object.fromEntries(liveServices.map((s) => [s.id, s]))
  const merged = MOCK_SERVICES.map((mock) => {
    const live = liveMap[mock.id]
    if (!live) return mock // Worker didn't return this service — use mock
    return {
      ...mock,            // fallback fields
      ...live,            // override with live data (status, latency, incidents, uptime30d)
      uptime30d: live.uptime30d ?? null, // from KV daily counters, null until data collected
      history3m: null,    // KV daily counter data needed — shows "수집 중" until collected
    }
  })
  // Include services from Worker that are not in MOCK_SERVICES (newly added)
  const mockIds = new Set(MOCK_SERVICES.map((m) => m.id))
  for (const live of liveServices) {
    if (!mockIds.has(live.id)) {
      merged.push({ ...live, uptime30d: live.uptime30d ?? null, history3m: null })
    }
  }
  return merged
}

// ── Context (single instance shared across all components) ──

const PollingContext = createContext(null)

export function PollingProvider({ children }) {
  const value = usePollingInternal()
  return createElement(PollingContext.Provider, { value }, children)
}

export function usePolling() {
  const ctx = useContext(PollingContext)
  if (!ctx) throw new Error('usePolling must be used within a PollingProvider')
  return ctx
}


// Status/incident alerts handled server-side (Worker detectAndAlertIncidents).
// Browser-side detection removed to prevent duplicate alerts.

// mode: 'initial' = first load (skeleton), 'refresh' = manual (keep data, show refreshing), 'silent' = auto-poll (invisible)
function usePollingInternal() {
  const [state, setState] = useState({
    services: [],
    loading: true,
    refreshing: false,
    error: null,
    lastUpdated: null,
    latency24h: [],
  })
  const cancelledRef = useRef(false)
  const controllerRef = useRef(null)
  const hasDataRef = useRef(false)
  const refreshingRef = useRef(false) // prevent silent polls from aborting refresh
  const prevServicesRef = useRef([])  // backup for recovery on refresh failure

  const poll = useCallback(async (mode = 'silent') => {
    // Skip silent polls while refresh is in progress
    if (mode === 'silent' && refreshingRef.current) return

    // Create new controller BEFORE aborting previous to avoid race condition
    const controller = new AbortController()
    const previousController = controllerRef.current
    controllerRef.current = controller
    if (mode === 'refresh') refreshingRef.current = true
    previousController?.abort()
    const timer = setTimeout(() => controller.abort(), 15000)

    const loadStart = Date.now()
    const isInitial = mode === 'initial' && !hasDataRef.current
    const isRefresh = mode === 'refresh'

    if (isInitial) {
      if (!cancelledRef.current) {
        setState((prev) => ({ ...prev, loading: true }))
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    } else if (isRefresh) {
      if (!cancelledRef.current) {
        // Save current services for recovery on fetch failure
        prevServicesRef.current = state.services
        setState((prev) => ({ ...prev, loading: true, refreshing: true, services: [] }))
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    }

    try {
      const res = await fetch(API_URL, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`Worker responded ${res.status}`)
      const data = await res.json()
      const merged = mergeWithMock(data.services)

      // Minimum skeleton display time: 2s for both initial and manual refresh
      if (isInitial) {
        const elapsed = Date.now() - loadStart
        if (elapsed < 2000) await new Promise((r) => setTimeout(r, 2000 - elapsed))
      } else if (isRefresh) {
        const elapsed = Date.now() - loadStart
        if (elapsed < 2000) await new Promise((r) => setTimeout(r, 2000 - elapsed))
      }

      // Status/incident alerts handled server-side (Worker detectAndAlertIncidents)
      // to avoid duplicate alerts when both browser and Worker are running

      hasDataRef.current = true
      refreshingRef.current = false
      if (!cancelledRef.current) {
        setState({
          services: merged,
          loading: false,
          refreshing: false,
          error: null,
          lastUpdated: new Date(data.lastUpdated),
          latency24h: data.latency24h ?? [],
        })
      }
    } catch (err) {
      clearTimeout(timer)
      if (err?.name === 'AbortError') {
        // Only reset refresh state if OUR controller was aborted (not a previous one)
        if (controller.signal.aborted && isRefresh && !cancelledRef.current) {
          refreshingRef.current = false
          setState((prev) => ({
            ...prev,
            loading: false,
            refreshing: false,
            services: prevServicesRef.current.length > 0 ? prevServicesRef.current : prev.services,
          }))
        }
        return
      }
      if (mode === 'silent') return

      if (isInitial) {
        const elapsed = Date.now() - loadStart
        if (elapsed < 2000) await new Promise((r) => setTimeout(r, 2000 - elapsed))
      }

      // Refresh failed: restore previous services
      if (isRefresh && hasDataRef.current) {
        refreshingRef.current = false
        if (!cancelledRef.current) {
          setState((prev) => ({
            ...prev,
            loading: false,
            refreshing: false,
            services: prevServicesRef.current.length > 0 ? prevServicesRef.current : prev.services,
          }))
        }
        return
      }

      refreshingRef.current = false
      if (!cancelledRef.current) {
        const isDev = import.meta.env.DEV
        const isNetworkError = err instanceof TypeError && /fetch|network/i.test(err.message)
        if (isDev && isNetworkError) {
          // Worker not running — show mock data for local development
          hasDataRef.current = true
          setState({
            services: MOCK_SERVICES,
            loading: false,
            refreshing: false,
            error: null,
            lastUpdated: new Date(),
          })
        } else {
          // Real error (prod, or non-network error in dev) — show offline UI
          setState({
            services: [],
            loading: false,
            refreshing: false,
            error: err || new Error('Failed to fetch'),
            lastUpdated: null,
          })
        }
      }
    }
  }, [])

  useEffect(() => {
    cancelledRef.current = false
    poll('initial')

    // Adaptive polling: 60s when active, 5min when tab is hidden
    let interval = setInterval(() => poll('silent'), POLL_INTERVAL)

    const handleVisibility = () => {
      clearInterval(interval)
      if (document.hidden) {
        interval = setInterval(() => poll('silent'), 5 * 60_000) // 5min when hidden
      } else {
        poll('silent') // immediate refresh on tab focus
        interval = setInterval(() => poll('silent'), POLL_INTERVAL) // resume 60s
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      cancelledRef.current = true
      controllerRef.current?.abort()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [poll])

  const refresh = useCallback(() => poll('refresh'), [poll])

  return { ...state, refresh }
}
