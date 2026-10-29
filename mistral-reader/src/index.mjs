import puppeteer from '@cloudflare/puppeteer'
import { createReader } from '../../scripts/mistral-browser-run.mjs'

export default createReader((binding) => puppeteer.launch(binding))
