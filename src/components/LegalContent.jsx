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
      <h3 style={headingStyle}>2. Cookies</h3>
      <p style={paraStyle}>GA4 uses cookies for analytics purposes. You may disable cookies in your browser settings, though some features may be limited as a result.</p>
      <h3 style={headingStyle}>3. Data Retention</h3>
      <p style={paraStyle}>Collected data is retained for up to 2 months per GA4 settings.</p>
      <h3 style={headingStyle}>4. Third-Party Services</h3>
      <p style={paraStyle}>AIWatch uses the following third-party services that may process your data:<br /><br />
        · Google Analytics 4 — usage analytics<br />
        · Cloudflare Workers — API proxy and caching<br />
        · Vercel — web hosting<br /><br />
        Collected information is not shared with any other third parties.</p>
      <h3 style={headingStyle}>5. Your Rights</h3>
      <p style={paraStyle}>You have the right to request access to, correction of, or deletion of your data. Since AIWatch does not collect personally identifiable information, most data is anonymous and cannot be linked to individuals.</p>
      <h3 style={headingStyle}>6. Children's Privacy</h3>
      <p style={paraStyle}>AIWatch does not knowingly collect information from children under the age of 14.</p>
      <h3 style={headingStyle}>7. Contact</h3>
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
      <h3 style={headingStyle}>2. 쿠키 사용</h3>
      <p style={paraStyle}>GA4는 분석 목적으로 쿠키를 사용합니다. 브라우저 설정에서 쿠키를 비활성화할 수 있으며, 이 경우 일부 기능이 제한될 수 있습니다.</p>
      <h3 style={headingStyle}>3. 정보 보유 기간</h3>
      <p style={paraStyle}>수집된 데이터는 GA4 설정에 따라 최대 2개월간 보관됩니다.</p>
      <h3 style={headingStyle}>4. 개인정보 처리 위탁</h3>
      <p style={paraStyle}>AIWatch는 다음 제3자 서비스를 통해 데이터를 처리합니다.<br /><br />
        · Google Analytics 4 — 이용 통계 분석<br />
        · Cloudflare Workers — API 프록시 및 캐싱<br />
        · Vercel — 웹 호스팅<br /><br />
        위 서비스 외의 제3자에게 정보를 제공하지 않습니다.</p>
      <h3 style={headingStyle}>5. 이용자의 권리</h3>
      <p style={paraStyle}>이용자는 수집된 정보에 대해 열람, 정정, 삭제를 요청할 수 있습니다. AIWatch는 개인 식별 정보를 수집하지 않으므로, 대부분의 데이터는 익명이며 개인과 연결할 수 없습니다.</p>
      <h3 style={headingStyle}>6. 14세 미만 아동</h3>
      <p style={paraStyle}>AIWatch는 14세 미만 아동의 정보를 의도적으로 수집하지 않습니다.</p>
      <h3 style={headingStyle}>7. 문의</h3>
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
      <p style={paraStyle}>AIWatch is a free dashboard for monitoring the status of major AI services. All information provided is based on the official Status APIs or status pages of each service.</p>
      <h3 style={headingStyle}>2. Accuracy of Information</h3>
      <p style={paraStyle}>While AIWatch strives to provide accurate information, status data depends on official data from each service provider. We do not guarantee the accuracy or timeliness of the information and are not liable for any damages arising from its use.</p>
      <h3 style={headingStyle}>3. Service Availability</h3>
      <p style={paraStyle}>The service may be modified or discontinued without prior notice. Temporary interruptions may occur due to scheduled maintenance or infrastructure issues.</p>
      <h3 style={headingStyle}>4. Usage Restrictions</h3>
      <p style={paraStyle}>The following activities are prohibited:<br /><br />
        · Excessive automated API calls that may disrupt the service<br />
        · Scraping or redistributing data without attribution<br />
        · Any use that violates applicable laws</p>
      <h3 style={headingStyle}>5. Disclaimer</h3>
      <p style={paraStyle}>AIWatch is provided "as is" without warranties of any kind. We are not responsible for decisions made based on the information displayed, including but not limited to business, operational, or financial decisions.</p>
      <h3 style={headingStyle}>6. Intellectual Property</h3>
      <p style={paraStyle}>All rights to AIWatch's design, code, and content belong to AIWatch.</p>
      <h3 style={headingStyle}>7. Changes to Terms</h3>
      <p style={paraStyle}>These terms may be updated from time to time. Significant changes will be announced on the service. Continued use after changes constitutes acceptance.</p>
      <h3 style={headingStyle}>8. Contact</h3>
      <p>For inquiries regarding these terms, please contact <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>.</p>
    </div>
  )

  return (
    <div>
      <p style={dateStyle}>최종 수정일: 2026년 3월</p>
      <h3 style={headingStyle}>1. 서비스 개요</h3>
      <p style={paraStyle}>AIWatch는 주요 AI 서비스의 상태를 모니터링하는 무료 대시보드입니다. 제공되는 모든 정보는 각 서비스의 공식 Status API 또는 상태 페이지를 기반으로 합니다.</p>
      <h3 style={headingStyle}>2. 정보의 정확성</h3>
      <p style={paraStyle}>AIWatch는 정확한 정보 제공을 위해 노력하지만, 각 AI 서비스의 상태 정보는 해당 서비스 제공자의 공식 데이터에 의존합니다. 정보의 정확성이나 최신성을 보장하지 않으며, 이로 인한 손해에 대해 책임지지 않습니다.</p>
      <h3 style={headingStyle}>3. 서비스 가용성</h3>
      <p style={paraStyle}>서비스는 사전 고지 없이 변경, 중단될 수 있습니다. 정기적인 유지보수나 인프라 이슈로 인한 일시적 중단이 발생할 수 있습니다.</p>
      <h3 style={headingStyle}>4. 이용 제한</h3>
      <p style={paraStyle}>다음 행위는 금지됩니다.<br /><br />
        · 서비스에 지장을 줄 수 있는 과도한 자동화된 API 호출<br />
        · 출처 표기 없이 데이터를 스크래핑하거나 재배포하는 행위<br />
        · 관련 법률을 위반하는 이용</p>
      <h3 style={headingStyle}>5. 면책 조항</h3>
      <p style={paraStyle}>AIWatch는 어떠한 종류의 보증 없이 "있는 그대로" 제공됩니다. 표시된 정보를 기반으로 내린 비즈니스, 운영, 재무 등 모든 결정에 대해 AIWatch는 책임을 지지 않습니다.</p>
      <h3 style={headingStyle}>6. 지적 재산권</h3>
      <p style={paraStyle}>AIWatch의 디자인, 코드, 콘텐츠에 대한 모든 권리는 AIWatch에 귀속됩니다.</p>
      <h3 style={headingStyle}>7. 약관 변경</h3>
      <p style={paraStyle}>본 약관은 수시로 변경될 수 있습니다. 중요한 변경 사항은 서비스 내에서 공지됩니다. 변경 후 계속 이용하면 변경된 약관에 동의한 것으로 간주됩니다.</p>
      <h3 style={headingStyle}>8. 문의</h3>
      <p>이용약관에 관한 문의는 <a href="mailto:contact@ai-watch.dev" style={linkStyle}>contact@ai-watch.dev</a>로 연락해 주세요.</p>
    </div>
  )
}
