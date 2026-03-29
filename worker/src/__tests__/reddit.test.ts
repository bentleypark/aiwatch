import { describe, it, expect } from 'vitest'
import { parseRedditResponse, matchesKeywords, isPromotable, formatRedditAlert } from '../reddit'
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
  it('formats promotable alert with tag and suggested reply', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:abc123',
      subreddit: 'ClaudeAI',
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
    expect(formatted.description).toContain('Suggested reply')
    expect(formatted.description).toContain('ai-watch.dev')
    expect(formatted.description).toContain('Claude')
    expect(formatted.color).toBe(0x3fb950) // green
  })

  it('uses generic service name for unknown subreddit', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:xyz',
      subreddit: 'UnknownSub',
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
    expect(formatted.description).toContain('AI services')
  })

  it('formats non-promotable alert without tag', () => {
    const alert: RedditAlert = {
      key: 'reddit:seen:def456',
      subreddit: 'OpenAI',
      post: {
        id: 'def456',
        title: 'OpenAI outage lasted 3 hours',
        author: 'reporter',
        subreddit: 'OpenAI',
        score: 20,
        url: 'https://www.reddit.com/r/OpenAI/comments/def456/',
        createdUtc: Math.floor(Date.now() / 1000) - 300,
      },
    }
    const formatted = formatRedditAlert(alert)
    expect(formatted.title).toBe('📢 Reddit: r/OpenAI')
    expect(formatted.description).not.toContain('PROMOTE')
    expect(formatted.description).not.toContain('Suggested reply')
    expect(formatted.color).toBe(0xFF4500) // Reddit orange
  })
})
