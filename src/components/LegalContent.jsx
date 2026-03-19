// Legal content for Privacy Policy and Terms of Service modals.
// Content from design mockup — bilingual (ko/en).
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
        · Button click events (Refresh, AI Analysis, etc.)<br />
        · Device type, browser, and operating system<br />
        · Country/region (with IP anonymization)<br /><br />
        We do not collect personally identifiable information such as names or email addresses.</p>
      <h3 style={headingStyle}>2. Cookies</h3>
      <p style={paraStyle}>GA4 uses cookies for analytics purposes. You may disable cookies in your browser settings, though some features may be limited as a result.</p>
      <h3 style={headingStyle}>3. Data Retention</h3>
      <p style={paraStyle}>Collected data is retained for up to 2 months per GA4 settings.</p>
      <h3 style={headingStyle}>4. Third-Party Sharing</h3>
      <p style={paraStyle}>Collected information is not shared with third parties beyond what is required for Google Analytics operation.</p>
      <h3 style={headingStyle}>5. Contact</h3>
      <p>For privacy inquiries, please contact <a href="mailto:contact@aiwatch.dev" style={linkStyle}>contact@aiwatch.dev</a>.</p>
    </div>
  )

  return (
    <div>
      <p style={dateStyle}>최종 수정일: 2026년 3월</p>
      <h3 style={headingStyle}>1. 수집하는 정보</h3>
      <p style={paraStyle}>AIWatch는 서비스 개선을 위해 Google Analytics 4(GA4)를 통해 다음 정보를 수집합니다.<br /><br />
        · 페이지 방문 기록 및 체류 시간<br />
        · 버튼 클릭 이벤트 (Refresh, AI Analysis 등)<br />
        · 기기 종류, 브라우저, 운영체제<br />
        · 국가/지역 정보 (IP 익명화 적용)<br /><br />
        개인을 식별할 수 있는 정보(이름, 이메일 등)는 수집하지 않습니다.</p>
      <h3 style={headingStyle}>2. 쿠키 사용</h3>
      <p style={paraStyle}>GA4는 분석 목적으로 쿠키를 사용합니다. 브라우저 설정에서 쿠키를 비활성화할 수 있으며, 이 경우 일부 기능이 제한될 수 있습니다.</p>
      <h3 style={headingStyle}>3. 정보 보유 기간</h3>
      <p style={paraStyle}>수집된 데이터는 GA4 설정에 따라 최대 2개월간 보관됩니다.</p>
      <h3 style={headingStyle}>4. 제3자 공유</h3>
      <p style={paraStyle}>수집된 정보는 Google Analytics 서비스 운영 외의 목적으로 제3자에게 제공되지 않습니다.</p>
      <h3 style={headingStyle}>5. 문의</h3>
      <p>개인정보 처리에 관한 문의는 <a href="mailto:contact@aiwatch.dev" style={linkStyle}>contact@aiwatch.dev</a>로 연락해 주세요.</p>
    </div>
  )
}

export function TermsContent() {
  const { lang } = useLang()
  if (lang === 'en') return (
    <div>
      <p style={dateStyle}>Last updated: March 2026</p>
      <h3 style={headingStyle}>1. Service Overview</h3>
      <p style={paraStyle}>AIWatch is a free dashboard for monitoring the status of major AI API services. All information provided is based on the official Status APIs of each service.</p>
      <h3 style={headingStyle}>2. Accuracy of Information</h3>
      <p style={paraStyle}>While AIWatch strives to provide accurate information, status data depends on official data from each service provider. We do not guarantee the accuracy or timeliness of the information and are not liable for any damages arising from its use.</p>
      <h3 style={headingStyle}>3. Service Availability</h3>
      <p style={paraStyle}>The service may be modified or discontinued without prior notice. Temporary interruptions may occur due to scheduled maintenance.</p>
      <h3 style={headingStyle}>4. Intellectual Property</h3>
      <p style={paraStyle}>All rights to AIWatch's design, code, and content belong to AIWatch.</p>
      <h3 style={headingStyle}>5. Contact</h3>
      <p>For inquiries regarding these terms, please contact <a href="mailto:contact@aiwatch.dev" style={linkStyle}>contact@aiwatch.dev</a>.</p>
    </div>
  )

  return (
    <div>
      <p style={dateStyle}>최종 수정일: 2026년 3월</p>
      <h3 style={headingStyle}>1. 서비스 개요</h3>
      <p style={paraStyle}>AIWatch는 주요 AI API 서비스의 상태를 모니터링하는 무료 대시보드입니다. 제공되는 모든 정보는 각 서비스의 공식 Status API를 기반으로 합니다.</p>
      <h3 style={headingStyle}>2. 정보의 정확성</h3>
      <p style={paraStyle}>AIWatch는 정확한 정보 제공을 위해 노력하지만, 각 AI 서비스의 상태 정보는 해당 서비스 제공자의 공식 데이터에 의존합니다. 정보의 정확성이나 최신성을 보장하지 않으며, 이로 인한 손해에 대해 책임지지 않습니다.</p>
      <h3 style={headingStyle}>3. 서비스 가용성</h3>
      <p style={paraStyle}>서비스는 사전 고지 없이 변경, 중단될 수 있습니다. 정기적인 유지보수로 인한 일시적 중단이 발생할 수 있습니다.</p>
      <h3 style={headingStyle}>4. 지적 재산권</h3>
      <p style={paraStyle}>AIWatch의 디자인, 코드, 콘텐츠에 대한 모든 권리는 AIWatch에 귀속됩니다.</p>
      <h3 style={headingStyle}>5. 문의</h3>
      <p>이용약관에 관한 문의는 <a href="mailto:contact@aiwatch.dev" style={linkStyle}>contact@aiwatch.dev</a>로 연락해 주세요.</p>
    </div>
  )
}
