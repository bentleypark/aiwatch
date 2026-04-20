import { describe, it, expect } from 'vitest'
import { parseRedditResponse, matchesKeywords, matchesSecurityKeywords, isPromotable, formatRedditAlert, formatSecurityAlert, REDDIT_TARGETS } from '../reddit'
import type { RedditAlert } from '../reddit'

describe('parseRedditResponse', () => {
  it('parses valid Reddit JSON response', () => {
    const json = {
      data: {
        children: [
          {
            data: {
              id: 'abc123',
              title: 'Is Claude down for anyone else?',
              author: 'testuser',
              subreddit: 'ClaudeAI',
              score: 15,
              permalink: '/r/ClaudeAI/comments/abc123/is_claude_down/',
              created_utc: 1742860800,
            },
          },
        ],
      },
    }
    const posts = parseRedditResponse(json)
    expect(posts).toHaveLength(1)
    expect(posts[0].id).toBe('abc123')
    expect(posts[0].title).toBe('Is Claude down for anyone else?')
    expect(posts[0].author).toBe('testuser')
    expect(posts[0].url).toContain('/r/ClaudeAI/comments/abc123/')
    expect(posts[0].score).toBe(15)
  })

  it('handles empty response', () => {
    expect(parseRedditResponse(null)).toEqual([])
    expect(parseRedditResponse({})).toEqual([])
    expect(parseRedditResponse({ data: { children: [] } })).toEqual([])
  })

  it('skips posts with missing id or title', () => {
    const json = {
      data: {
        children: [
          { data: { id: '', title: 'test', author: 'a', subreddit: 'x', score: 0, permalink: '/x', created_utc: 0 } },
          { data: { id: 'ok', title: '', author: 'a', subreddit: 'x', score: 0, permalink: '/x', created_utc: 0 } },
          { data: { id: 'ok2', title: 'valid', author: 'a', subreddit: 'x', score: 0, permalink: '/x', created_utc: 0 } },
        ],
      },
    }
    const posts = parseRedditResponse(json)
    expect(posts).toHaveLength(1)
    expect(posts[0].id).toBe('ok2')
  })
})

describe('matchesKeywords', () => {
  it('matches outage-related keywords', () => {
    expect(matchesKeywords('Is Claude down right now?')).toBe(true)
    expect(matchesKeywords('ChatGPT not working for anyone?')).toBe(true)
    expect(matchesKeywords('OpenAI API error 500')).toBe(true)
    expect(matchesKeywords('Major outage reported')).toBe(true)
    expect(matchesKeywords('Service is broken')).toBe(true)
    expect(matchesKeywords('Server seems offline')).toBe(true)
    expect(matchesKeywords('API is slow today')).toBe(true)
    expect(matchesKeywords('currently unavailable')).toBe(true)
  })

  it('matches weak keywords only with context', () => {
    // Weak + context = match
    expect(matchesKeywords('API errors for anyone today?')).toBe(true)
    expect(matchesKeywords('Server slow right now')).toBe(true)
    expect(matchesKeywords('Issues with the service currently')).toBe(true)
    // Weak without context = no match
    expect(matchesKeywords('Issues with my prompt engineering')).toBe(false)
    expect(matchesKeywords('Slow rollout of new features')).toBe(false)
    expect(matchesKeywords('Common errors in fine-tuning')).toBe(false)
  })

  it('does not match unrelated posts', () => {
    expect(matchesKeywords('How to use Claude for coding')).toBe(false)
    expect(matchesKeywords('Best prompts for GPT-4')).toBe(false)
    expect(matchesKeywords('New feature announcement')).toBe(false)
    expect(matchesKeywords('Pricing comparison')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(matchesKeywords('IS CLAUDE DOWN?')).toBe(true)
    expect(matchesKeywords('Not Working at all')).toBe(true)
  })
})

describe('matchesSecurityKeywords', () => {
  it('matches AI service security incidents', () => {
    expect(matchesSecurityKeywords('OpenAI data breach exposes user emails')).toBe(true)
    expect(matchesSecurityKeywords('Claude Code RCE vulnerability CVE-2025-59536')).toBe(true)
    expect(matchesSecurityKeywords('Anthropic API key leak found on GitHub')).toBe(true)
    expect(matchesSecurityKeywords('HuggingFace credentials leaked in breach')).toBe(true)
    expect(matchesSecurityKeywords('DeepSeek database compromised with unauthorized access')).toBe(true)
    expect(matchesSecurityKeywords('Gemini prompt injection exploit discovered')).toBe(true)
    expect(matchesSecurityKeywords('xAI Grok hacked — data exfiltration confirmed')).toBe(true)
  })

  it('matches strong security signals with AI-adjacent keywords', () => {
    expect(matchesSecurityKeywords('Major breach at AI cloud provider')).toBe(true)
    expect(matchesSecurityKeywords('CVE-2025-12345 remote code execution in LLM API')).toBe(true)
    expect(matchesSecurityKeywords('Data leak exposes GPT model weights')).toBe(true)
  })

  it('does not match strong security signals without AI context', () => {
    expect(matchesSecurityKeywords('Major breach at cloud provider')).toBe(false)
    expect(matchesSecurityKeywords('CVE-2025-12345 remote code execution in Linux kernel')).toBe(false)
    expect(matchesSecurityKeywords('Data leak exposes millions of records')).toBe(false)
  })

  it('matches security context + AI service', () => {
    expect(matchesSecurityKeywords('OpenAI security vulnerability patched')).toBe(true)
    expect(matchesSecurityKeywords('Anthropic disclosure of exploit')).toBe(true)
    expect(matchesSecurityKeywords('Copilot malicious injection attack')).toBe(true)
  })

  it('does not match unrelated posts', () => {
    expect(matchesSecurityKeywords('How to use Claude for coding')).toBe(false)
    expect(matchesSecurityKeywords('Best security practices for web apps')).toBe(false)
    expect(matchesSecurityKeywords('New feature announcement from Google')).toBe(false)
    expect(matchesSecurityKeywords('Pricing comparison of AI services')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(matchesSecurityKeywords('OPENAI BREACH CONFIRMED')).toBe(true)
    expect(matchesSecurityKeywords('Claude vulnerability DISCLOSURE')).toBe(true)
  })
})

describe('formatSecurityAlert', () => {
  it('formats Reddit security alert with red color and lock icon', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:sec123',
      subreddit: 'netsec',
      post: {
        id: 'sec123',
        title: 'OpenAI API key leak discovered',
        author: 'secresearcher',
        subreddit: 'netsec',
        score: 42,
        url: 'https://www.reddit.com/r/netsec/comments/sec123/',
        createdUtc: Math.floor(Date.now() / 1000) - 300,
      },
      type: 'security',
    }
    const formatted = formatSecurityAlert(alert)
    expect(formatted.title).toBe('🔒 Security: r/netsec')
    expect(formatted.description).toContain('OpenAI API key leak')
    expect(formatted.color).toBe(0xf85149) // red
  })
})

describe('isPromotable', () => {
  it('detects question-style posts as promotable', () => {
    expect(isPromotable('Is Claude down right now?')).toBe(true)
    expect(isPromotable('Anyone else having issues with ChatGPT?')).toBe(true)
    expect(isPromotable('Claude not working for anyone?')).toBe(true)
    expect(isPromotable('Does anyone know the status?')).toBe(true)
    expect(isPromotable('What is going on with OpenAI?')).toBe(true)
    expect(isPromotable('Is it just me or is Cursor down')).toBe(true)
  })

  it('detects help-seeking posts as promotable', () => {
    expect(isPromotable('Help - Claude API returning 500s')).toBe(true)
    expect(isPromotable('How to check if OpenAI is down')).toBe(true)
    expect(isPromotable("What's happening with Claude today")).toBe(true)
  })

  it('rejects statement/rant posts', () => {
    expect(isPromotable('Claude is terrible today, switching to Gemini')).toBe(false)
    expect(isPromotable('OpenAI outage lasted 3 hours yesterday')).toBe(false)
    expect(isPromotable('Moved all my code to Cursor')).toBe(false)
  })

  it('rejects non-outage posts with ambiguous keywords', () => {
    expect(isPromotable('Anyone want to share their Claude prompts')).toBe(false)
    expect(isPromotable('Someone at OpenAI posted an update')).toBe(false)
    expect(isPromotable('Check out this cool project')).toBe(false)
    expect(isPromotable('When Claude launched last year it was great')).toBe(false)
    expect(isPromotable('Why I switched from OpenAI to Anthropic')).toBe(false)
  })
})

describe('formatRedditAlert', () => {
  it('formats alert with PROMOTE tag and Is X Down link', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:abc123',
      subreddit: 'ClaudeAI',
      type: 'outage',
      post: {
        id: 'abc123',
        title: 'Is Claude down?',
        author: 'testuser',
        subreddit: 'ClaudeAI',
        score: 5,
        url: 'https://www.reddit.com/r/ClaudeAI/comments/abc123/',
        createdUtc: Math.floor(Date.now() / 1000) - 180,
      },
    }
    const formatted = formatRedditAlert(alert)
    expect(formatted.title).toBe('📢 Reddit: r/ClaudeAI [🎯 PROMOTE]')
    expect(formatted.description).toContain('Is Claude down?')
    expect(formatted.description).toContain('ai-watch.dev/is-claude-down')
    expect(formatted.description).not.toContain('Suggested reply')
    expect(formatted.color).toBe(0x3fb950)
  })

  it('filters promotable alerts from mixed list (integration)', () => {
    const alerts: RedditAlert[] = [
      { key: 'k1', subreddit: 'ClaudeAI', type: 'outage' as const, post: { id: '1', title: 'Is Claude down?', author: 'a', subreddit: 'ClaudeAI', score: 5, url: '', createdUtc: 0 } },
      { key: 'k2', subreddit: 'OpenAI', type: 'outage' as const, post: { id: '2', title: 'OpenAI outage lasted 3 hours', author: 'b', subreddit: 'OpenAI', score: 20, url: '', createdUtc: 0 } },
      { key: 'k3', subreddit: 'ChatGPT', type: 'outage' as const, post: { id: '3', title: 'Anyone having issues with ChatGPT?', author: 'c', subreddit: 'ChatGPT', score: 8, url: '', createdUtc: 0 } },
    ]
    const promotable = alerts.filter(a => isPromotable(a.post.title))
    expect(promotable).toHaveLength(2)
    expect(promotable[0].post.id).toBe('1')
    expect(promotable[1].post.id).toBe('3')
  })

  it('omits Is X Down link for unknown subreddit', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:xyz',
      subreddit: 'UnknownSub',
      type: 'outage',
      post: {
        id: 'xyz',
        title: 'Is this service down?',
        author: 'user',
        subreddit: 'UnknownSub',
        score: 1,
        url: 'https://www.reddit.com/r/UnknownSub/comments/xyz/',
        createdUtc: Math.floor(Date.now() / 1000) - 60,
      },
    }
    const formatted = formatRedditAlert(alert)
    expect(formatted.description).not.toContain('is-')
    expect(formatted.title).toContain('PROMOTE')
  })
})

describe('REDDIT_TARGETS — playbook coverage (#280)', () => {
  // Locks the playbook Subreddit list ↔ cron coverage mapping. If this table diverges from
  // docs/marketing-playbook.md, either update this test or the playbook — whichever reflects
  // the intent. Do not silently drop a playbook engagement target.
  const modeOf = (service: string) =>
    service === '_competitive' ? 'competitive'
      : service === '_security' ? 'security' : 'outage'

  it('includes all playbook engagement targets in outage mode', () => {
    const subsInOutageMode = REDDIT_TARGETS
      .filter(t => modeOf(t.service) === 'outage')
      .map(t => t.subreddit)
    // Playbook-listed subs where cron should auto-detect outage posts for Discord 🎯 PROMOTE
    expect(subsInOutageMode).toContain('ClaudeAI')
    expect(subsInOutageMode).toContain('ChatGPT')
    expect(subsInOutageMode).toContain('OpenAI')
    // #280: r/LocalLLaMA switched from competitive → outage to match the playbook's
    // "API reliability in local-vs-hosted threads" engagement hook.
    expect(subsInOutageMode).toContain('LocalLLaMA')
    // #280: r/AINews added for press-adjacent outage threads.
    expect(subsInOutageMode).toContain('AINews')
  })

  it('keeps coding agent subs in outage mode (existing coverage)', () => {
    const subsInOutageMode = REDDIT_TARGETS
      .filter(t => modeOf(t.service) === 'outage')
      .map(t => t.subreddit)
    expect(subsInOutageMode).toContain('ClaudeCode')
    expect(subsInOutageMode).toContain('cursor')
    expect(subsInOutageMode).toContain('windsurf')
    expect(subsInOutageMode).toContain('Codeium')
  })

  it('keeps competitive-only subs in competitive mode (not outage)', () => {
    const competitive = REDDIT_TARGETS.filter(t => modeOf(t.service) === 'competitive').map(t => t.subreddit)
    expect(competitive).toContain('devops')
    expect(competitive).toContain('artificial')
    // Guard against regression: LocalLLaMA must not be demoted back to competitive
    expect(competitive).not.toContain('LocalLLaMA')
  })

  it('keeps security subs in security mode', () => {
    const security = REDDIT_TARGETS.filter(t => modeOf(t.service) === 'security').map(t => t.subreddit)
    expect(security).toContain('netsec')
    expect(security).toContain('cybersecurity')
  })

  it('does not monitor r/MachineLearning yet — deferred pending stricter matcher (#280)', () => {
    const subs = REDDIT_TARGETS.map(t => t.subreddit)
    // Playbook says r/MachineLearning is out-of-scope for auto-detection because
    // research posts naturally contain outage keywords ("broken loss curve", etc.).
    // Adding it without a service-name-required matcher would spam Discord.
    expect(subs).not.toContain('MachineLearning')
  })

  it('uses only known service-field conventions', () => {
    // _competitive and _security are special markers; everything else falls to outage mode.
    // A typo like '_competetive' would silently route to outage — this test catches that.
    const specialMarkers = new Set(['_competitive', '_security'])
    for (const target of REDDIT_TARGETS) {
      if (target.service.startsWith('_')) {
        expect(specialMarkers.has(target.service)).toBe(true)
      }
    }
  })
})
