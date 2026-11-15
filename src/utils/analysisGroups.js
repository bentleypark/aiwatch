export function groupAnalyses(aiAnalysis, services) {
  // aiAnalysis: Record<svcId, AIAnalysisResult[]>
  //
  // Two-pass grouping (avoids cross-service bleed — see #315):
  //   Pass 1: bucket by incidentId to collect which svcIds each incident affects.
  //           Sibling services sharing an incident (e.g. Claude API + claude.ai + Claude Code
  //           pointing at the same incidentId) collapse into one bucket here.
  //   Pass 2: buckets naming the same services merge into a single card so the service header
  //           and fallback block render once even when a service has multiple distinct incidents
  //           (e.g. Together AI with two concurrent model outages).
  const byIncident = new Map()
  for (const [svcId, rawAnalyses] of Object.entries(aiAnalysis)) {
    const arr = Array.isArray(rawAnalyses) ? rawAnalyses : [rawAnalyses]
    for (const a of arr) {
      const incId = a.incidentId ?? svcId
      const bucket = byIncident.get(incId)
      if (bucket) {
        if (!bucket.svcIds.includes(svcId)) bucket.svcIds.push(svcId)
        continue
      }
      const svc = services.find(s => s.id === svcId)
      const inc = svc?.incidents?.find(i => i.id === incId)
      byIncident.set(incId, {
        incId,
        svcIds: [svcId],
        analysis: a,
        startedAt: inc?.startedAt ?? a.analyzedAt ?? '',
      })
    }
  }
  for (const bucket of byIncident.values()) {
    bucket.ownerIds = [...bucket.svcIds]
    for (const s of services) {
      if (!bucket.svcIds.includes(s.id) && s.incidents?.some(i => i.id === bucket.incId)) bucket.svcIds.push(s.id)
    }
  }

  const groups = []
  const groupBySvcSet = new Map()
  for (const bucket of byIncident.values()) {
    const key = [...bucket.svcIds].sort().join(',')
    const existing = groupBySvcSet.get(key)
    if (existing) {
      existing.incIds.add(bucket.incId)
      existing.analyses.push(bucket.analysis)
      existing.ownerIds.push(...bucket.ownerIds)
      // Keep the card anchored to the most recent incident in the group so sort places
      // freshly erupting issues above long-running ones.
      if (bucket.startedAt && bucket.startedAt > existing.startedAt) {
        existing.startedAt = bucket.startedAt
      }
    } else {
      const g = {
        svcIds: bucket.svcIds,
        ownerIds: bucket.ownerIds,
        incIds: new Set([bucket.incId]),
        analyses: [bucket.analysis],
        startedAt: bucket.startedAt,
      }
      groupBySvcSet.set(key, g)
      groups.push(g)
    }
  }
  return groups.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function baselineCards(groups) {
  const cardOf = new Map()
  groups.forEach((g, gi) => g.ownerIds.forEach(id => { if (!cardOf.has(id)) cardOf.set(id, gi) }))
  return cardOf
}
