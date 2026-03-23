// Legal content for Privacy Policy and Terms of Service modals.
// Content — bilingual (ko/en).
// NOTE: Long-form legal text is kept inline rather than in locale files (pragmatic exception).

import { useLang } from '../hooks/useLang'

const headingStyle = { fontSize: '13px', fontWeight: 500, color: 'var(--text0)', margin: '0 0 8px' }
const paraStyle = { marginBottom: '16px' }
const dateStyle = { color: 'var(--text2)', fontFamily: 'var(--font-mono)', fontSize: '10px', marginBottom: '16px' }
const linkStyle = { color: 'var(--blue)' }

export function PrivacyContent() {
  const { lang } = useLang()
  if (lang === 'en') return (
    <div>
      <p style={dateStyle}>Last updated: March 2026</p>
      <h3 style={headingStyle}>1. Information We Collect</h3>
      <p style={paraStyle}>AIWatch uses Google Analytics 4 (GA4) to collect the following information for service improvement.<br /><br />
        · Page visit history and session duration<br />
        · Button click events (Refresh, filter changes, etc.)<br />
        · Device type, browser, and operating system<br />
        · Country/region (with IP anonymization)<br /><br />
        We do not collect personally identifiable information such as names or email addresses.</p>
      <h3 style={headingStyle}>2. Cookies and Local Storage</h3>
      <p style={paraStyle}>AIWatch uses the following types of browser storage:<br /><br />
        <strong>Analytics cookies (optional)</strong> — GA4 uses cookies (_ga, _gid) for usage analytics. You can opt out via the cookie banner or browser settings.<br /><br />
        <strong>Essential local storage (always active)</strong> — AIWatch stores the following preferences in your browser's localStorage. This data never leaves your device:<br />
        · Theme preference (dark/light)<br />
        · Language preference (ko/en)<br />
        · Dashboard settings (monitoring period, SLA target, enabled services)<br />
        · Cookie consent choice<br />
        · PWA install banner dismissal</p>
      <h3 style={headingStyle}>3. Service Worker (PWA)</h3>
      <p style={paraStyle}>AIWatch uses a service worker to cache static assets locally for faster loading and limited offline access. The service worker does not collect or transmit any personal data.</p>
      <h3 style={headingStyle}>4. Data Retention</h3>
      <p style={paraStyle}>Analytics data collected via GA4 is retained for up to 14 months per GA4 settings. Local storage data is retained in your browser until you clear it manually.</p>
      <h3 style={headingStyle}>5. Third-Party Services</h3>
      <p style={paraStyle}>AIWatch uses the following third-party services that may process your data:<br /><br />
        · Google Analytics 4 — usage analytics<br />
        · Cloudflare Workers — API proxy and caching<br />
        · Vercel — web hosting<br />
        · GitHub API — repository star count display<br /><br />
        Collected information is not shared with any other third parties.</p>
      <h3 style={headingStyle}>6. Your Rights</h3>
      <p style={paraStyle}>You have the right to request access to, correction of, or deletion of your data. Since AIWatch does not collect personally identifiable information, most data is anonymous and cannot be linked to individuals. You can revoke analytics consent at any time via the cookie banner.</p>
      <h3 style={headingStyle}>7. Children's Privacy</h3>
      <p style={paraStyle}>AIWatch does not knowingly collect information from children under the age of 14.</p>
      <h3 style={headingStyle}>8. Contact</h3>
      <p>For privacy inquiries, please contact <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>.</p>
    </div>
  )

  return (
    <div>
      <p style={dateStyle}>최종 수정일: 2026년 3월</p>
      <h3 style={headingStyle}>1. 수집하는 정보</h3>
      <p style={paraStyle}>AIWatch는 서비스 개선을 위해 Google Analytics 4(GA4)를 통해 다음 정보를 수집합니다.<br /><br />
        · 페이지 방문 기록 및 체류 시간<br />
        · 버튼 클릭 이벤트 (새로고침, 필터 변경 등)<br />
        · 기기 종류, 브라우저, 운영체제<br />
        · 국가/지역 정보 (IP 익명화 적용)<br /><br />
        개인을 식별할 수 있는 정보(이름, 이메일 등)는 수집하지 않습니다.</p>
      <h3 style={headingStyle}>2. 쿠키 및 로컬 저장소</h3>
      <p style={paraStyle}>AIWatch는 다음 유형의 브라우저 저장소를 사용합니다.<br /><br />
        <strong>분석 쿠키 (선택)</strong> — GA4가 이용 통계 분석을 위해 쿠키(_ga, _gid)를 사용합니다. 쿠키 배너 또는 브라우저 설정에서 거부할 수 있습니다.<br /><br />
        <strong>필수 로컬 저장소 (항상 활성)</strong> — 다음 설정이 브라우저의 localStorage에 저장됩니다. 이 데이터는 기기 외부로 전송되지 않습니다:<br />
        · 테마 설정 (다크/라이트)<br />
        · 언어 설정 (한국어/영어)<br />
        · 대시보드 설정 (모니터링 기간, SLA 목표, 활성화된 서비스)<br />
        · 쿠키 동의 선택<br />
        · PWA 설치 배너 닫기 여부</p>
      <h3 style={headingStyle}>3. 서비스 워커 (PWA)</h3>
      <p style={paraStyle}>AIWatch는 빠른 로딩과 제한적 오프라인 접근을 위해 서비스 워커를 사용하여 정적 자산을 로컬에 캐싱합니다. 서비스 워커는 개인 정보를 수집하거나 전송하지 않습니다.</p>
      <h3 style={headingStyle}>4. 정보 보유 기간</h3>
      <p style={paraStyle}>GA4를 통해 수집된 분석 데이터는 GA4 설정에 따라 최대 14개월간 보관됩니다. 로컬 저장소 데이터는 브라우저에서 직접 삭제할 때까지 유지됩니다.</p>
      <h3 style={headingStyle}>5. 개인정보 처리 위탁</h3>
      <p style={paraStyle}>AIWatch는 다음 제3자 서비스를 통해 데이터를 처리합니다.<br /><br />
        · Google Analytics 4 — 이용 통계 분석<br />
        · Cloudflare Workers — API 프록시 및 캐싱<br />
        · Vercel — 웹 호스팅<br />
        · GitHub API — 저장소 별 수 표시<br /><br />
        위 서비스 외의 제3자에게 정보를 제공하지 않습니다.</p>
      <h3 style={headingStyle}>6. 이용자의 권리</h3>
      <p style={paraStyle}>이용자는 수집된 정보에 대해 열람, 정정, 삭제를 요청할 수 있습니다. AIWatch는 개인 식별 정보를 수집하지 않으므로, 대부분의 데이터는 익명이며 개인과 연결할 수 없습니다. 쿠키 배너를 통해 분석 동의를 언제든 철회할 수 있습니다.</p>
      <h3 style={headingStyle}>7. 14세 미만 아동</h3>
      <p style={paraStyle}>AIWatch는 14세 미만 아동의 정보를 의도적으로 수집하지 않습니다.</p>
      <h3 style={headingStyle}>8. 문의</h3>
      <p>개인정보 처리에 관한 문의는 <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>로 연락해 주세요.</p>
    </div>
  )
}

export function TermsContent() {
  const { lang } = useLang()
  if (lang === 'en') return (
    <div>
      <p style={dateStyle}>Last updated: March 2026</p>
      <h3 style={headingStyle}>1. Service Overview</h3>
      <p style={paraStyle}>AIWatch is a free, open-source dashboard for monitoring the status of major AI services including API platforms, web applications, and coding agents. All information provided is based on the official Status APIs or status pages of each service.</p>
      <h3 style={headingStyle}>2. Accuracy of Information</h3>
      <p style={paraStyle}>While AIWatch strives to provide accurate information, status data depends on official data from each service provider. We do not guarantee the accuracy or timeliness of the information and are not liable for any damages arising from its use.</p>
      <h3 style={headingStyle}>3. Service Availability</h3>
      <p style={paraStyle}>The service may be modified or discontinued without prior notice. Temporary interruptions may occur due to scheduled maintenance or infrastructure issues.</p>
      <h3 style={headingStyle}>4. Public API and Badges</h3>
      <p style={paraStyle}>AIWatch provides a public API (/api/v1/status) and embeddable status badges (/badge/:serviceId) for external use. These endpoints are provided as-is with no uptime or availability guarantee. Excessive automated requests that may disrupt the service are prohibited.</p>
      <h3 style={headingStyle}>5. Usage Restrictions</h3>
      <p style={paraStyle}>The following activities are prohibited:<br /><br />
        · Excessive automated API calls that may disrupt the service<br />
        · Scraping or redistributing data without attribution<br />
        · Any use that violates applicable laws</p>
      <h3 style={headingStyle}>6. Disclaimer</h3>
      <p style={paraStyle}>AIWatch is provided "as is" without warranties of any kind. We are not responsible for decisions made based on the information displayed, including but not limited to business, operational, or financial decisions.</p>
      <h3 style={headingStyle}>7. Open Source and Licensing</h3>
      <p style={paraStyle}>AIWatch is open-source software licensed under the <a href="https://github.com/bentleypark/aiwatch/blob/main/LICENSE" style={linkStyle}>GNU Affero General Public License v3.0 (AGPL-3.0)</a>. The source code is available on GitHub. Contributions and usage are subject to the terms of this license.</p>
      <h3 style={headingStyle}>8. Governing Law</h3>
      <p style={paraStyle}>These terms are governed by and construed in accordance with the laws of the Republic of Korea.</p>
      <h3 style={headingStyle}>9. Changes to Terms</h3>
      <p style={paraStyle}>These terms may be updated from time to time. Significant changes will be announced on the service. Continued use after changes constitutes acceptance.</p>
      <h3 style={headingStyle}>10. Contact</h3>
      <p>For inquiries regarding these terms, please contact <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>.</p>
    </div>
  )

  return (
    <div>
      <p style={dateStyle}>최종 수정일: 2026년 3월</p>
      <h3 style={headingStyle}>1. 서비스 개요</h3>
      <p style={paraStyle}>AIWatch는 AI API 플랫폼, 웹 애플리케이션, 코딩 에이전트 등 주요 AI 서비스의 상태를 모니터링하는 무료 오픈소스 대시보드입니다. 제공되는 모든 정보는 각 서비스의 공식 Status API 또는 상태 페이지를 기반으로 합니다.</p>
      <h3 style={headingStyle}>2. 정보의 정확성</h3>
      <p style={paraStyle}>AIWatch는 정확한 정보 제공을 위해 노력하지만, 각 AI 서비스의 상태 정보는 해당 서비스 제공자의 공식 데이터에 의존합니다. 정보의 정확성이나 최신성을 보장하지 않으며, 이로 인한 손해에 대해 책임지지 않습니다.</p>
      <h3 style={headingStyle}>3. 서비스 가용성</h3>
      <p style={paraStyle}>서비스는 사전 고지 없이 변경, 중단될 수 있습니다. 정기적인 유지보수나 인프라 이슈로 인한 일시적 중단이 발생할 수 있습니다.</p>
      <h3 style={headingStyle}>4. 공개 API 및 배지</h3>
      <p style={paraStyle}>AIWatch는 외부에서 사용할 수 있는 공개 API(/api/v1/status)와 상태 배지(/badge/:serviceId)를 제공합니다. 이 엔드포인트는 가용성이나 안정성을 보장하지 않으며 있는 그대로 제공됩니다. 서비스에 지장을 줄 수 있는 과도한 자동화된 요청은 금지됩니다.</p>
      <h3 style={headingStyle}>5. 이용 제한</h3>
      <p style={paraStyle}>다음 행위는 금지됩니다.<br /><br />
        · 서비스에 지장을 줄 수 있는 과도한 자동화된 API 호출<br />
        · 출처 표기 없이 데이터를 스크래핑하거나 재배포하는 행위<br />
        · 관련 법률을 위반하는 이용</p>
      <h3 style={headingStyle}>6. 면책 조항</h3>
      <p style={paraStyle}>AIWatch는 어떠한 종류의 보증 없이 "있는 그대로" 제공됩니다. 표시된 정보를 기반으로 내린 비즈니스, 운영, 재무 등 모든 결정에 대해 AIWatch는 책임을 지지 않습니다.</p>
      <h3 style={headingStyle}>7. 오픈소스 및 라이선스</h3>
      <p style={paraStyle}>AIWatch는 <a href="https://github.com/bentleypark/aiwatch/blob/main/LICENSE" style={linkStyle}>GNU Affero General Public License v3.0 (AGPL-3.0)</a> 라이선스에 따라 배포되는 오픈소스 소프트웨어입니다. 소스 코드는 GitHub에서 확인할 수 있으며, 기여 및 이용은 해당 라이선스 조건을 따릅니다.</p>
      <h3 style={headingStyle}>8. 준거법</h3>
      <p style={paraStyle}>본 약관은 대한민국 법률에 따라 해석됩니다.</p>
      <h3 style={headingStyle}>9. 약관 변경</h3>
      <p style={paraStyle}>본 약관은 수시로 변경될 수 있습니다. 중요한 변경 사항은 서비스 내에서 공지됩니다. 변경 후 계속 이용하면 변경된 약관에 동의한 것으로 간주됩니다.</p>
      <h3 style={headingStyle}>10. 문의</h3>
      <p>이용약관에 관한 문의는 <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>로 연락해 주세요.</p>
    </div>
  )
}
