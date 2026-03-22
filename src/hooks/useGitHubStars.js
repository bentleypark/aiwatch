import { useState, useEffect } from 'react'

export function useGitHubStars() {
  const [stars, setStars] = useState(null)
  useEffect(() => {
    fetch('https://api.github.com/repos/bentleypark/aiwatch')
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => { if (typeof d.stargazers_count === 'number') setStars(d.stargazers_count) })
      .catch(() => {})
  }, [])
  return stars
}
