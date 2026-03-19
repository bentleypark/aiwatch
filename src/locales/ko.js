const ko = {
  // App
  'app.tagline': 'AI API 서비스 실시간 모니터링 대시보드',

  // Navigation
  'nav.overview': '개요',
  'nav.latency': '레이턴시',
  'nav.incidents': '인시던트',
  'nav.uptime': '업타임 리포트',
  'nav.settings': '설정',
  'nav.dashboard': '대시보드',
  'nav.services': '서비스',
  'sidebar.footer': 'aiwatch.dev · v1.0',

  // Topbar
  'topbar.live': 'LIVE',
  'topbar.refresh': '↻ Refresh',
  'topbar.refresh.loading': '↻ 로딩 중...',
  'topbar.analyze': '분석',
  'topbar.analyze.soon': '준비 중',
  'topbar.analyze.tooltip.title': '준비 중인 기능',
  'topbar.analyze.tooltip.body': '이상 감지 시 자동으로 원인을 분석하고 알림을 보내는 기능을 준비 중입니다',
  'topbar.refreshed': '새로고침',
  'topbar.menu.open': '메뉴 열기',

  // Status
  'status.operational': 'Operational',
  'status.degraded': 'Degraded',
  'status.down': 'Down',

  // Overview
  'overview.last.updated': '마지막 업데이트',
  'overview.stats.operational': '서비스 운영 중',
  'overview.stats.degraded': '부분 영향',
  'overview.stats.down': '서비스 중단',
  'overview.stats.uptime': '평균 업타임',
  'overview.filter.all': '전체',
  'overview.filter.operational': '정상',
  'overview.filter.issues': '이슈',
  'overview.incidents.title': '최근 인시던트',
  'overview.latency.title': '레이턴시 순위',
  'overview.ai.title': 'AI 분석',
  'overview.ai.soon': '준비 중',

  // Empty States
  'empty.issues.title': '현재 이슈 없음',
  'empty.issues.desc': '모든 서비스가 정상 운영 중입니다',
  'empty.filter.title': '해당 조건 인시던트 없음',
  'empty.filter.action': '필터 초기화',
  'empty.error.title': '데이터를 불러올 수 없습니다',
  'empty.error.action': '다시 시도',

  // Latency
  'latency.rankings': '현재 순위',
  'latency.fastest': '가장 빠름',
  'latency.average': '평균',
  'latency.slowest': '가장 느림',
  'latency.trend': '24시간 추세',
  'latency.dummy': '데이터 수집 중 (24시간 후 실데이터로 전환)',

  // Incidents
  'incidents.filter.service': '서비스',
  'incidents.filter.status': '상태',
  'incidents.filter.period': '기간',
  'incidents.filter.all': '전체',
  'incidents.col.time': '시간',
  'incidents.col.title': '제목',
  'incidents.col.service': '서비스',
  'incidents.col.duration': '기간',
  'incidents.col.status': '상태',
  'incidents.status.ongoing': '진행 중',
  'incidents.status.monitoring': '모니터링',
  'incidents.status.resolved': '해결됨',
  'incidents.duration.ongoing': '진행 중',
  'incidents.period.7d': '7일',
  'incidents.period.30d': '30일',
  'incidents.period.90d': '90일',
  'incidents.period.all': '전체 기간',
  'incidents.timeline.title': '타임라인',
  'incidents.timeline.investigating': '조사 중',
  'incidents.timeline.identified': '원인 파악',
  'incidents.timeline.monitoring': '모니터링',
  'incidents.timeline.resolved': '해결됨',

  // Uptime
  'uptime.stable': '가장 안정적',
  'uptime.average': '평균 업타임',
  'uptime.issues': '인시던트 최다',
  'uptime.sla': 'SLA 기준',
  'uptime.rankings': '업타임 순위',
  'uptime.matrix': '3개월 이력',
  'uptime.incidents': '인시던트',

  // Service Details
  'svc.latency': '현재 레이턴시',
  'svc.uptime30d': '30일 업타임',
  'svc.incidents': '인시던트 수',
  'svc.mttr': 'MTTR',
  'svc.mttr.collecting': '수집 중',
  'svc.cal.legend': '상태 캘린더',
  'svc.no.incidents': '인시던트 없음 — 안정적으로 운영 중',
  'svc.status.link': '공식 Status',

  // Settings
  'settings.general': '일반',
  'settings.theme': '테마',
  'settings.theme.dark': '다크',
  'settings.theme.light': '라이트',
  'settings.theme.system': '시스템',
  'settings.language': '언어',
  'settings.period': '기본 조회 기간',
  'settings.sla': 'SLA 기준값',
  'settings.monitoring': '모니터링',
  'settings.alerts': '알림',
  'settings.slack': 'Slack Webhook URL',
  'settings.period.7d': '7일',
  'settings.period.30d': '30일',
  'settings.period.90d': '90일',
  'settings.alert.condition': '알림 조건',
  'settings.alert.target': '알림 대상',
  'settings.save': '저장',
  'settings.saved': '저장됨 ✓',

  // Modal
  'modal.close': '닫기',
  'modal.loading': '불러오는 중',

  // Footer
  'footer.privacy': '개인정보처리방침',
  'footer.terms': '이용약관',
  'footer.copyright': '© 2026 AIWatch. All rights reserved.',
}

export default ko
