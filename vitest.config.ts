import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // 测试超时放宽：apply() 集成用例需要临时目录与多次读写
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
