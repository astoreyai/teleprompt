import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: '**/stress.spec.ts',
  timeout: Number(process.env.TELEPROMPT_STRESS_MS ?? 300000) + 120000,
  retries: 0,
  use: { ...base.use, trace: 'off' },
})
