import puppeteer from '@cloudflare/puppeteer'
import { runBrowserRead } from '../../scripts/mistral-browser-run.mjs'

export default {
  async scheduled(_controller, env) {
    await runBrowserRead({
      withPage: async (fn) => {
        const browser = await puppeteer.launch(env.BROWSER)
        try {
          return await fn(await browser.newPage())
        } finally {
          await browser.close()
        }
      },
      // The service binding delivers to aiwatch-worker whatever the host; its router reads only the path.
      workerUrl: 'https://aiwatch-worker',
      token: env.MISTRAL_FEED_TOKEN,
      transport: (url, init) => env.AIWATCH.fetch(url, init),
      record: (point) => env.ANALYTICS.writeDataPoint(point),
    })
  },
}
