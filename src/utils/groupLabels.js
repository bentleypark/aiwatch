import { formatDate } from './time'

/** A group row's date range. #1623 — a multi-day outage states days only, ending "ongoing" while it runs. */
export function groupRangeText(group, lang, t) {
  if (group.run) {
    const day = (d) => formatDate(d, lang, { dayOnly: true, day: d })
    return `${day(group.startDay)} → ${group.ongoing ? t('incidents.duration.ongoing') : day(group.endDay)}`
  }
  return `${formatDate(group.rangeStart, lang)} → ${formatDate(group.rangeEnd, lang)}`
}

/** A group row's count badge: "× N flaps", or #1623 "N days" for a multi-day outage. */
export function groupBadgeText(group, t) {
  return t(group.run ? 'incidents.group.days' : 'incidents.group.flaps').replace('{n}', String(group.count))
}

/** #1623 — a past day inside a multi-day outage group carries no status of its own: the group states it. */
export function hidesEntryStatus(group, inc) {
  return !!group.run && inc.status === 'resolved'
}
