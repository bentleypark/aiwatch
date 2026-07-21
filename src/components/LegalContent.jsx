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
      <p style={dateStyle}>Last updated: May 2026</p>
      <h3 style={headingStyle}>1. Information We Collect</h3>
      <p style={paraStyle}>AIWatch uses Google Analytics 4 (GA4) to collect the following information for service improvement.<br /><br />
        · Page visit history and session duration<br />
        · Button click events (Refresh, filter changes, etc.)<br />
        · Device type, browser, and operating system<br />
        · Country/region (with IP anonymization)<br /><br />
        We do not collect personally identifiable information such as names or email addresses. Without analytics consent, GA4 operates in cookieless mode under Google Consent Mode v2 — only aggregate, anonymized pings flow, with no client identifier stored.</p>
      <h3 style={headingStyle}>2. Cookies and Local Storage</h3>
      <p style={paraStyle}>AIWatch uses the following types of browser storage:<br /><br />
        <strong>Analytics cookies (optional)</strong> — when you grant consent, GA4 stores _ga, _ga_&lt;measurement_id&gt;, and _gid cookies for usage analytics. _gcl_au may also appear if Google's tag library is loaded; AIWatch does not use it for advertising. You can opt out via the cookie banner or browser settings; on revoke through the banner, AIWatch removes these cookies immediately, and on the next page load when consent has been revoked through other means.<br /><br />
        <strong>Default-denied behavior</strong> — without explicit consent, no analytics or advertising cookies are set on your device, regardless of which AIWatch surface (dashboard, "Is X down?" pages, monthly reports) you arrive on first. The same consent choice applies across all AIWatch pages because they share the ai-watch.dev origin.<br /><br />
        <strong>Essential local storage (always active)</strong> — AIWatch stores the following preferences in your browser's localStorage. This data stays on your device, except the Discord webhook URL, which is also stored encrypted on our server for alert delivery (see below):<br />
        · Theme preference (dark/light)<br />
        · Language preference (ko/en)<br />
        · Dashboard settings (monitoring period, SLA target, enabled services)<br />
        · Cookie consent choice (aiwatch-cookie-consent)<br />
        · PWA install banner dismissal<br />
        · Discord webhook URL — entered voluntarily for alert notifications. Your alert filter preferences are kept in localStorage; the webhook URL itself, after you confirm control of the channel, is stored on our server <strong>encrypted (AES-GCM)</strong> so we can deliver alerts to it (Slack subscriptions use Slack's native /feed RSS app and store no URL). See "Third-Party Services" below for how it is used and deleted.</p>
      <h3 style={headingStyle}>3. Cookie Banner</h3>
      <p style={paraStyle}>On your first visit to any AIWatch page, a cookie banner appears asking for analytics consent (Accept All / Essential Only). Your choice is stored in <code>localStorage.aiwatch-cookie-consent</code> and reused across all subsequent visits to any AIWatch page. The banner does not appear again unless you clear browser storage. Both choices are honored identically across the dashboard, "Is X down?" SEO pages, and monthly reports.</p>
      <h3 style={headingStyle}>4. Advertising</h3>
      <p style={paraStyle}>AIWatch does not display advertisements. The Google Consent Mode v2 signals <code>ad_storage</code>, <code>ad_user_data</code>, and <code>ad_personalization</code> are set to "denied" by default and remain "denied" even after you accept analytics consent — only <code>analytics_storage</code> is upgraded. No advertising profile is built from your visits.</p>
      <h3 style={headingStyle}>5. Service Worker (PWA)</h3>
      <p style={paraStyle}>AIWatch uses a service worker to cache static assets locally for faster loading and limited offline access. The service worker does not collect or transmit any personal data.</p>
      <h3 style={headingStyle}>6. Data Retention</h3>
      <p style={paraStyle}>Analytics data collected via GA4 is retained for up to 14 months per GA4 settings. Local storage data is retained in your browser until you clear it manually. Your encrypted Discord webhook URL is retained on the server until you unsubscribe — unsubscribing deletes it immediately and permanently; subscriptions whose webhook stops accepting deliveries are also pruned automatically.</p>
      <h3 style={headingStyle}>7. Third-Party Services</h3>
      <p style={paraStyle}>AIWatch uses the following third-party services that may process your data:<br /><br />
        · Google Analytics 4 — usage analytics<br />
        · Cloudflare Workers — API proxy and caching<br />
        · Vercel — web hosting<br />
        · GitHub API — repository star count display<br />
        · Discord Webhook API — alert delivery proxy (only when configured by user)<br /><br />
        When you subscribe a Discord webhook for alerts, we store its URL <strong>encrypted (AES-GCM) on our server</strong> and our scheduled worker delivers incident/status alerts to it directly. The URL is used only for that delivery and your chosen alert filters; you can remove it anytime via Settings → Alerts (Unsubscribe), which deletes it immediately and permanently. Slack subscriptions go through Slack's native /feed app reading our public RSS feed — no payload is proxied and no URL is stored.<br /><br />
        Collected information is not shared with any other third parties.</p>
      <h3 style={headingStyle}>8. Your Rights</h3>
      <p style={paraStyle}>You have the right to request access to, correction of, or deletion of your data. Since AIWatch does not collect personally identifiable information, most data is anonymous and cannot be linked to individuals. You can revoke analytics consent at any time:<br /><br />
        · <strong>Recommended</strong>: in your browser's DevTools, run <code>localStorage.removeItem('aiwatch-cookie-consent')</code> to make the cookie banner re-appear, then choose Essential Only. This preserves your dashboard preferences (theme, language, enabled services).<br />
        · <strong>Manual</strong>: run <code>localStorage.setItem('aiwatch-cookie-consent','denied')</code> in your browser's DevTools console. On the next page load, AIWatch reads this value and automatically removes any remaining analytics cookies — the documented manual path produces the same end state as the banner Essential-Only choice.</p>
      <h3 style={headingStyle}>9. Children's Privacy</h3>
      <p style={paraStyle}>AIWatch does not knowingly collect information from children under the age of 14.</p>
      <h3 style={headingStyle}>10. Contact</h3>
      <p>For privacy inquiries, please contact <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>.</p>
      <p style={{ ...paraStyle, marginTop: 8 }}>Using the AIWatch <strong>Chrome extension</strong>? It has its own, separate privacy policy (it uses no analytics or cookies) — see <a href="/extension-privacy" style={linkStyle}>the extension privacy policy</a>.</p>
      <p style={{ ...paraStyle, marginTop: 8 }}>Using the AIWatch <strong>Claude Code plugin</strong>? It also has its own, separate privacy policy (no cookies, no analytics, reads no code) — see <a href="/plugin-privacy" style={linkStyle}>the plugin privacy policy</a>.</p>
    </div>
  )

  return (
    <div>
      <p style={dateStyle}>최종 수정일: 2026년 5월</p>
      <h3 style={headingStyle}>1. 수집하는 정보</h3>
      <p style={paraStyle}>AIWatch는 서비스 개선을 위해 Google Analytics 4(GA4)를 통해 다음 정보를 수집합니다.<br /><br />
        · 페이지 방문 기록 및 체류 시간<br />
        · 버튼 클릭 이벤트 (새로고침, 필터 변경 등)<br />
        · 기기 종류, 브라우저, 운영체제<br />
        · 국가/지역 정보 (IP 익명화 적용)<br /><br />
        개인을 식별할 수 있는 정보(이름, 이메일 등)는 수집하지 않습니다. 분석 동의를 하지 않은 상태에서는 GA4가 Google Consent Mode v2의 cookieless 모드로 동작하며, 클라이언트 식별자가 저장되지 않은 익명 집계 ping만 전송됩니다.</p>
      <h3 style={headingStyle}>2. 쿠키 및 로컬 저장소</h3>
      <p style={paraStyle}>AIWatch는 다음 유형의 브라우저 저장소를 사용합니다.<br /><br />
        <strong>분석 쿠키 (선택)</strong> — 동의 시 GA4가 _ga, _ga_&lt;측정_id&gt;, _gid 쿠키를 이용 통계 분석을 위해 저장합니다. Google 태그 라이브러리 로드 시 _gcl_au가 함께 나타날 수 있으나, AIWatch는 이를 광고 목적으로 사용하지 않습니다. 쿠키 배너 또는 브라우저 설정에서 거부할 수 있으며, 배너에서 거부 시 즉시 삭제되고, 다른 방법으로 동의를 철회한 경우 다음 페이지 로드에서 자동 삭제됩니다.<br /><br />
        <strong>기본 거부 동작</strong> — 명시적 동의가 없는 상태에서는 어떤 AIWatch 페이지(대시보드, "Is X down?" 페이지, 월간 리포트)에 처음 진입하든 분석/광고 쿠키가 기기에 저장되지 않습니다. 같은 ai-watch.dev origin을 공유하므로 모든 AIWatch 페이지에서 동일한 동의 선택이 적용됩니다.<br /><br />
        <strong>필수 로컬 저장소 (항상 활성)</strong> — 다음 설정이 브라우저의 localStorage에 저장됩니다. 이 데이터는 기기에 보관되며, 다만 Discord webhook URL은 알림 전송을 위해 서버에도 암호화되어 저장됩니다(아래 참고):<br />
        · 테마 설정 (다크/라이트)<br />
        · 언어 설정 (한국어/영어)<br />
        · 대시보드 설정 (모니터링 기간, SLA 목표, 활성화된 서비스)<br />
        · 쿠키 동의 선택 (aiwatch-cookie-consent)<br />
        · PWA 설치 배너 닫기 여부<br />
        · Discord Webhook URL — 알림 수신을 위해 사용자가 직접 입력. 알림 필터 설정은 localStorage에 보관되며, Webhook URL 자체는 채널 소유 확인 후 알림 전송을 위해 서버에 <strong>암호화(AES-GCM)되어</strong> 저장됩니다 (Slack 구독은 Slack 내장 /feed RSS 앱을 사용하며 URL을 저장하지 않습니다). 사용 목적·삭제 방법은 아래 "개인정보 처리 위탁" 참고.</p>
      <h3 style={headingStyle}>3. 쿠키 배너</h3>
      <p style={paraStyle}>AIWatch 페이지를 처음 방문하면 분석 동의를 묻는 쿠키 배너가 표시됩니다(모두 동의 / 필수만 사용). 선택 결과는 <code>localStorage.aiwatch-cookie-consent</code>에 저장되어 이후 모든 AIWatch 페이지 방문에서 재사용됩니다. 브라우저 저장소를 비우기 전까지는 배너가 다시 표시되지 않습니다. 두 선택 모두 대시보드, "Is X down?" SEO 페이지, 월간 리포트에서 동일하게 적용됩니다.</p>
      <h3 style={headingStyle}>4. 광고</h3>
      <p style={paraStyle}>AIWatch는 광고를 표시하지 않습니다. Google Consent Mode v2의 <code>ad_storage</code>, <code>ad_user_data</code>, <code>ad_personalization</code> 신호는 기본값이 "denied"이며, 분석 동의를 한 후에도 계속 "denied" 상태로 유지됩니다 — <code>analytics_storage</code>만 동의 시 "granted"로 변경됩니다. 방문 기록을 기반으로 광고 프로필을 생성하지 않습니다.</p>
      <h3 style={headingStyle}>5. 서비스 워커 (PWA)</h3>
      <p style={paraStyle}>AIWatch는 빠른 로딩과 제한적 오프라인 접근을 위해 서비스 워커를 사용하여 정적 자산을 로컬에 캐싱합니다. 서비스 워커는 개인 정보를 수집하거나 전송하지 않습니다.</p>
      <h3 style={headingStyle}>6. 정보 보유 기간</h3>
      <p style={paraStyle}>GA4를 통해 수집된 분석 데이터는 GA4 설정에 따라 최대 14개월간 보관됩니다. 로컬 저장소 데이터는 브라우저에서 직접 삭제할 때까지 유지됩니다. 암호화된 Discord Webhook URL은 구독을 해제할 때까지 서버에 보관되며, 구독 해제 시 즉시 영구 삭제됩니다. Webhook이 더 이상 전송을 받지 못하는 구독은 자동으로 정리됩니다.</p>
      <h3 style={headingStyle}>7. 개인정보 처리 위탁</h3>
      <p style={paraStyle}>AIWatch는 다음 제3자 서비스를 통해 데이터를 처리합니다.<br /><br />
        · Google Analytics 4 — 이용 통계 분석<br />
        · Cloudflare Workers — API 프록시 및 캐싱<br />
        · Vercel — 웹 호스팅<br />
        · GitHub API — 저장소 별 수 표시<br />
        · Discord Webhook API — 알림 전달 프록시 (사용자 설정 시에만)<br /><br />
        알림용 Discord webhook을 구독하면 해당 URL을 서버에 <strong>암호화(AES-GCM)하여</strong> 저장하고, 예약된 worker가 인시던트·상태 알림을 해당 webhook으로 직접 전송합니다. URL은 이 알림 전송과 사용자가 선택한 알림 필터에만 사용되며, 설정 → 알림(구독 해제)에서 언제든 삭제할 수 있고 삭제 시 즉시 영구 제거됩니다. Slack 구독은 Slack 내장 /feed 앱이 공개 RSS 피드를 읽는 방식이라 알림이 프록시되지 않고 URL도 저장되지 않습니다.<br /><br />
        위 서비스 외의 제3자에게 정보를 제공하지 않습니다.</p>
      <h3 style={headingStyle}>8. 사용자의 권리</h3>
      <p style={paraStyle}>사용자는 수집된 정보에 대해 열람, 정정, 삭제를 요청할 수 있습니다. AIWatch는 개인 식별 정보를 수집하지 않으므로, 대부분의 데이터는 익명이며 개인과 연결할 수 없습니다. 분석 동의는 다음 두 가지 방법으로 언제든 철회할 수 있습니다:<br /><br />
        · <strong>권장</strong>: 브라우저 DevTools 콘솔에서 <code>localStorage.removeItem('aiwatch-cookie-consent')</code>을 실행하면 쿠키 배너가 다시 표시되며, "필수만 사용"을 선택할 수 있습니다. 대시보드 설정(테마, 언어, 활성화된 서비스)은 그대로 유지됩니다.<br />
        · <strong>수동</strong>: 브라우저 DevTools 콘솔에서 <code>localStorage.setItem('aiwatch-cookie-consent','denied')</code> 실행. 다음 페이지 로드 시 AIWatch가 이 값을 읽고 남아 있는 분석 쿠키를 자동으로 삭제합니다 — 수동 경로는 배너 "필수만 사용"과 동일한 최종 상태를 만듭니다.</p>
      <h3 style={headingStyle}>9. 14세 미만 아동</h3>
      <p style={paraStyle}>AIWatch는 14세 미만 아동의 정보를 의도적으로 수집하지 않습니다.</p>
      <h3 style={headingStyle}>10. 문의</h3>
      <p>개인정보 처리에 관한 문의는 <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>로 연락해 주세요.</p>
      <p style={{ ...paraStyle, marginTop: 8 }}>AIWatch <strong>Chrome 확장 프로그램</strong>을 사용 중이신가요? 확장 프로그램은 분석·쿠키를 사용하지 않는 별도의 개인정보처리방침을 따릅니다 — <a href="/extension-privacy" style={linkStyle}>확장 프로그램 개인정보처리방침</a> 참고.</p>
      <p style={{ ...paraStyle, marginTop: 8 }}>AIWatch <strong>Claude Code 플러그인</strong>을 사용 중이신가요? 플러그인도 쿠키·분석 없이 코드를 읽지 않는 별도의 개인정보처리방침을 따릅니다 — <a href="/plugin-privacy" style={linkStyle}>플러그인 개인정보처리방침</a> 참고.</p>
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
      <p style={paraStyle}>AIWatch is open-source software licensed under the <a href="https://github.com/bentleypark/aiwatch/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" style={linkStyle}>GNU Affero General Public License v3.0 (AGPL-3.0)</a>. The source code is available on GitHub. Contributions and usage are subject to the terms of this license.</p>
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
      <p style={paraStyle}>AIWatch는 <a href="https://github.com/bentleypark/aiwatch/blob/main/LICENSE" target="_blank" rel="noopener noreferrer" style={linkStyle}>GNU Affero General Public License v3.0 (AGPL-3.0)</a> 라이선스에 따라 배포되는 오픈소스 소프트웨어입니다. 소스 코드는 GitHub에서 확인할 수 있으며, 기여 및 이용은 해당 라이선스 조건을 따릅니다.</p>
      <h3 style={headingStyle}>8. 준거법</h3>
      <p style={paraStyle}>본 약관은 대한민국 법률에 따라 해석됩니다.</p>
      <h3 style={headingStyle}>9. 약관 변경</h3>
      <p style={paraStyle}>본 약관은 수시로 변경될 수 있습니다. 중요한 변경 사항은 서비스 내에서 공지됩니다. 변경 후 계속 이용하면 변경된 약관에 동의한 것으로 간주됩니다.</p>
      <h3 style={headingStyle}>10. 문의</h3>
      <p>이용약관에 관한 문의는 <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>로 연락해 주세요.</p>
    </div>
  )
}
