import { useState, useEffect } from 'react'

export const GITHUB_REPO_API = 'https://api.github.com/repos/bentleypark/aiwatch'

export function useGitHubStars() {
  const [stars, setStars] = useState(null)
  useEffect(() => {
    fetch(GITHUB_REPO_API)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => { if (typeof d.stargazers_count === 'number') setStars(d.stargazers_count) })
      .catch(() => {})
  }, [])
  return stars
}
