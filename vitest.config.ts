import { defineConfig } from 'vitest/config'

// 独立于 monorepo 根配置的最小 vitest 配置(scratch 不在 workspace 内)
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
