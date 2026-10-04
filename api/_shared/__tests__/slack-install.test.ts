import { describe, it, expect } from 'vitest'
import { slackInstallUrl, SLACK_INSTALL_URL } from '../slack-install'

describe('slackInstallUrl', () => {
  it('points at the worker install route', () => {
    expect(SLACK_INSTALL_URL).toBe('https://aiwatch-worker.p2c2kbf.workers.dev/api/slack/install')
  })
  it('without services installs for every service', () => {
    expect(slackInstallUrl()).toBe(SLACK_INSTALL_URL)
    expect(slackInstallUrl([])).toBe(SLACK_INSTALL_URL)
  })
  it('scopes to the given service ids, deduplicated', () => {
    expect(slackInstallUrl(['claude', 'openai', 'claude'])).toBe(`${SLACK_INSTALL_URL}?services=claude,openai`)
  })
  it('drops anything that is not a service id shape', () => {
    expect(slackInstallUrl(['claude', 'x&y', '<b>', ''])).toBe(`${SLACK_INSTALL_URL}?services=claude`)
  })
})
