// About AIWatch Score — explains the scoring methodology

import { useLang } from '../hooks/useLang'
import { SCORE_BG_CLASS, SCORE_TEXT_CLASS } from '../utils/constants'

function Section({ title, children }) {
  return (
    <section className="bg-[var(--bg1)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="border-b border-[var(--border)]" style={{ padding: '12px 16px' }}>
        <div className="mono text-[10px] text-[var(--text1)] uppercase tracking-wider flex items-center gap-1.5">
          <span className="rounded-full shrink-0" style={{ width: '5px', height: '5px', background: 'var(--teal)' }} />
          {title}
        </div>
      </div>
      <div style={{ padding: '16px' }}>
        {children}
      </div>
    </section>
  )
}

function FormulaTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full mono text-[11px]" style={{ borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([input, score], i) => (
            <tr key={i} className="border-b border-[var(--border)]">
              <td className="text-[var(--text2)]" style={{ padding: '6px 12px 6px 0' }}>{input}</td>
              <td className="text-[var(--text0)] font-medium text-right" style={{ padding: '6px 0' }}>{score}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function AboutScore() {
  const { t } = useLang()

  const grades = [
    { min: 85, key: 'excellent' },
    { min: 70, key: 'good' },
    { min: 55, key: 'fair' },
    { min: 40, key: 'degrading' },
    { min: 0, key: 'unstable' },
  ]

  const d = (n) => `${n}${t('aboutScore.day')}`
  const m = (n) => `${n}${t('aboutScore.min')}`
  const h = (n) => `${n}${t('aboutScore.hour')}`

  return (
    <div className="flex flex-col" style={{ maxWidth: '720px', gap: '20px' }}>

      {/* Header */}
      <div>
        <h2 className="mono text-[10px] text-[var(--text2)] uppercase flex items-center gap-2" style={{ letterSpacing: '0.1em', marginBottom: '8px' }}>
          <span className="text-[var(--green)] font-semibold">//</span>
          {t('aboutScore.title')}
        </h2>
        <p className="text-xs text-[var(--text1)]" style={{ lineHeight: 1.6 }}>
          {t('aboutScore.intro')}
        </p>
      </div>

      {/* Formula Overview */}
      <Section title={t('aboutScore.formula')}>
        <div className="mono text-[13px] text-[var(--text0)] font-medium" style={{ marginBottom: '16px' }}>
          {t('aboutScore.formulaStr')}
        </div>
        <div className="grid grid-cols-3" style={{ gap: '10px' }}>
          {[
            { label: 'Uptime', max: 50, color: 'var(--green)' },
            { label: 'Incidents', max: 30, color: 'var(--blue)' },
            { label: 'Recovery', max: 20, color: 'var(--teal)' },
          ].map(({ label, max, color }) => (
            <div key={label} className="bg-[var(--bg2)] border border-[var(--border)] rounded-lg text-center" style={{ padding: '12px' }}>
              <div className="mono text-[18px] font-semibold" style={{ color }}>{max}</div>
              <div className="mono text-[9px] text-[var(--text2)] uppercase">{label}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* Uptime Score */}
      <Section title={t('aboutScore.uptimeSection')}>
        <div className="mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] rounded p-3" style={{ marginBottom: '12px' }}>
          (uptime% − 95%) / 5% × 50
        </div>
        <FormulaTable rows={[
          ['100% uptime', '50'],
          ['99.5% uptime', '45'],
          ['99.0% uptime', '40'],
          ['97.0% uptime', '20'],
          [`95% ${t('aboutScore.below')}`, '0'],
        ]} />
      </Section>

      {/* Incident Score */}
      <Section title={t('aboutScore.incidentSection')}>
        <div className="mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] rounded p-3" style={{ marginBottom: '12px' }}>
          30 × exp(−affected_days / 10)
        </div>
        <FormulaTable rows={[
          [d(0), '30.0'],
          [d(5), '18.2'],
          [d(10), '11.0'],
          [d(18), '5.0'],
          [d(30), '1.5'],
        ]} />
        <div className="bg-[var(--bg2)] border border-[var(--border)] rounded-lg" style={{ padding: '12px', marginTop: '12px' }}>
          <div className="mono text-[10px] text-[var(--teal)] font-medium" style={{ marginBottom: '6px' }}>
            {t('aboutScore.whyDays')}
          </div>
          <p className="text-[11px] text-[var(--text2)]" style={{ lineHeight: 1.6 }}>
            {t('aboutScore.whyDaysDesc')}
          </p>
        </div>
      </Section>

      {/* Recovery Score */}
      <Section title={t('aboutScore.recoverySection')}>
        <div className="mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] rounded p-3" style={{ marginBottom: '12px' }}>
          20 × exp(−MTTR_hours / 4)
        </div>
        <FormulaTable rows={[
          [m(30), '17.6'],
          [h(1), '15.6'],
          [h(2), '12.1'],
          [h(4), '7.4'],
          [h(10), '1.6'],
        ]} />
      </Section>

      {/* Grade Table */}
      <Section title={t('aboutScore.grades')}>
        <div className="flex flex-col gap-2">
          {grades.map(({ min, key }) => (
            <div key={key} className="flex items-center gap-3">
              <span className={`w-14 text-center mono text-[11px] font-medium rounded py-1 ${SCORE_BG_CLASS[key]} text-[var(--bg0)]`}>
                {min}+
              </span>
              <span className={`mono text-[12px] font-medium ${SCORE_TEXT_CLASS[key]}`}>
                {t(`aboutScore.grade.${key}`)}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* No Uptime Data */}
      <Section title={t('aboutScore.noUptime')}>
        <p className="text-[11px] text-[var(--text2)]" style={{ lineHeight: 1.6, marginBottom: '10px' }}>
          {t('aboutScore.noUptimeDesc')}
        </p>
        <div className="mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] rounded" style={{ padding: '12px 16px' }}>
          Score = (Uptime_45 + Incidents + Recovery) × 0.9<br />
          Confidence: Medium
        </div>
        <p className="text-[11px] text-[var(--text2)]" style={{ lineHeight: 1.6, marginTop: '10px' }}>
          {t('aboutScore.naDesc')}
        </p>
      </Section>

      {/* Ranking Exclusion */}
      <Section title={t('aboutScore.rankExclude')}>
        <p className="text-[11px] text-[var(--text2)]" style={{ lineHeight: 1.6, marginBottom: '10px' }}>
          {t('aboutScore.rankExcludeDesc')}
        </p>
        <div className="mono text-[11px] text-[var(--text1)] bg-[var(--bg2)] rounded" style={{ padding: '12px 16px' }}>
          {t('aboutScore.rankExcludeExample')}
        </div>
      </Section>

      {/* Data Sources */}
      <Section title={t('aboutScore.sources')}>
        <div className="flex flex-col gap-2 text-[11px] text-[var(--text2)]" style={{ lineHeight: 1.6 }}>
          <div>• <strong className="text-[var(--text1)]">Uptime %</strong> — {t('aboutScore.sourceUptime')}</div>
          <div>• <strong className="text-[var(--text1)]">{t('aboutScore.sourceIncLabel')}</strong> — Atlassian Statuspage, incident.io, Google Cloud Status, Better Stack, RSS</div>
          <div>• <strong className="text-[var(--text1)]">{t('aboutScore.sourceUpdateLabel')}</strong> — {t('aboutScore.sourceUpdateValue')}</div>
        </div>
      </Section>

    </div>
  )
}
