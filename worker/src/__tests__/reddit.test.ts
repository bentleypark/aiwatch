import { describe, it, expect } from 'vitest'
import { parseRedditResponse, matchesKeywords, formatRedditAlert } from '../reddit'
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

describe('formatRedditAlert', () => {
  it('formats alert for Discord', () => {
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
        createdUtc: Math.floor(Date.now() / 1000) - 180, // 3 min ago
      },
    }
    const formatted = formatRedditAlert(alert)
    expect(formatted.title).toBe('📢 Reddit: r/ClaudeAI')
    expect(formatted.description).toContain('Is Claude down?')
    expect(formatted.description).toContain('u/testuser')
    expect(formatted.description).toContain('5 upvotes')
    expect(formatted.description).toContain('3m ago')
    expect(formatted.color).toBe(0xFF4500)
    expect(formatted.url).toContain('abc123')
  })
})
