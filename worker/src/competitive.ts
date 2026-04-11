// GitHub competitive monitoring — detect new repos in AI monitoring space
// Uses GitHub's public search API (no auth required, 10 req/min limit)

export interface GitHubRepo {
  fullName: string
  description: string
  stars: number
  url: string
  createdAt: string
}

export interface GitHubAlert {
  key: string  // KV dedup key: github:seen:{owner/repo}
  repo: GitHubRepo
}

const SEARCH_TOPICS = ['ai-monitoring', 'llm-status', 'ai-status', 'api-uptime-monitor']

/**
 * Search GitHub for new repos matching AI monitoring topics.
 * Returns repos created in the last 7 days with 5+ stars.
 */
export async function detectNewRepos(kv: KVNamespace | null): Promise<GitHubAlert[]> {
  if (!kv) return []

  const alerts: GitHubAlert[] = []
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0]

  const results = await Promise.allSettled(
    SEARCH_TOPICS.map(async (topic) => {
      const query = encodeURIComponent(`topic:${topic} created:>${weekAgo} stars:>=5`)
      const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=5`

      const res = await fetch(url, {
        headers: {
          'User-Agent': 'AIWatch/1.0 (ai-watch.dev; competitive monitoring)',
          'Accept': 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(5000),
      })

      if (!res.ok) {
        console.warn(`[competitive] GitHub search failed for ${topic}: HTTP ${res.status}`)
        res.body?.cancel()
        return []
      }

      const data = await res.json() as { items?: Array<Record<string, unknown>> }
      return (data.items ?? []).map((item): GitHubRepo => ({
        fullName: String(item.full_name ?? ''),
        description: String(item.description ?? '').slice(0, 200),
        stars: Number(item.stargazers_count ?? 0),
        url: String(item.html_url ?? ''),
        createdAt: String(item.created_at ?? ''),
      }))
    }),
  )

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const repo of result.value) {
      const key = `github:seen:${repo.fullName}`
      const seen = await kv.get(key).catch(() => null)
      if (seen) continue
      alerts.push({ key, repo })
    }
  }

  return alerts
}

/**
 * Format a GitHub repo alert for Discord
 */
export function formatGitHubAlert(alert: GitHubAlert): { title: string; description: string; color: number; url: string } {
  return {
    title: '🔍 New Competitor Repo',
    description: `**${alert.repo.fullName}** ⭐ ${alert.repo.stars}\n${alert.repo.description}\nCreated: ${alert.repo.createdAt.split('T')[0]}`,
    color: 0x8b949e, // gray
    url: alert.repo.url,
  }
}
