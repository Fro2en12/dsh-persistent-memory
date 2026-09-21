import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// F8：README 架构图里的「N 个可调参数」必须等于 src/index.ts 的 Config 顶层键数。
// 这个数字已经漂移过多轮（README 停留 30，Config 实际 31），人工同步不可靠——以源码为唯一事实源。
// 计数口径：顶层键 = Config 块内「恰好两个空格缩进 + 键名:」的行；块内嵌套对象（≥4 空格缩进）
// 与注释行都不计入，所以 Config 以后长成嵌套结构（例如 levels: z.object({...})）也不会把计数带偏。
// 反过来，Config 增删一个顶层键、或 README 那行的数字被改动，本测试立刻变红。

const ROOT = join(__dirname, '..')

/** 抽出 `export const Config = z.object({` … 顶格 `})` 之间的块体（块内缩进行撞不上这个锚点）。 */
const CONFIG_BLOCK = /^export const Config = z\.object\(\{\r?\n([\s\S]*?)^\}\)/m
/** 顶层键：恰好两个空格缩进 + `键名:`。 */
const TOP_LEVEL_KEY = /^ {2}([A-Za-z_$][\w$]*):/
/** README 架构图那行：`├─ Config（schemastery）      N 个可调参数（…）、加载期校验`。 */
const README_COUNT = /Config（schemastery）\s+(\d+)\s*个可调参数/

/** Config 顶层键名；抽不到 Config 块时返回空数组（由断言连同错误消息一起报出）。 */
function configTopLevelKeys(source: string): string[] {
  const block = CONFIG_BLOCK.exec(source)
  if (!block) return []
  return block[1]
    .split(/\r?\n/)
    .map((line) => TOP_LEVEL_KEY.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1])
}

/** README 宣称的可调参数个数；抽不到时返回 -1（由断言连同错误消息一起报出）。 */
function readmeParameterCount(readme: string): number {
  const match = README_COUNT.exec(readme)
  return match ? Number(match[1]) : -1
}

describe('F8 README 可调参数计数与 Config 防漂移', () => {
  // 只放一条断言：失败原因只有「两侧口径不一致」这一类；哪一侧漂移、漂成多少，全部写进消息。
  it('README 宣称的可调参数个数必须等于 Config 顶层键数：口径漂移会让部署者按错的参数表配置', () => {
    const configKeys = configTopLevelKeys(readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8'))
    const readmeCount = readmeParameterCount(readFileSync(join(ROOT, 'README.md'), 'utf8'))

    expect(
      readmeCount,
      [
        `README 宣称 ${readmeCount} 个可调参数，src/index.ts 的 Config 顶层有 ${configKeys.length} 个键。`,
        `  README 侧：${readmeCount < 0 ? '未解析出数字（架构图里「├─ Config（schemastery）  N 个可调参数」这行的写法被改动了）' : readmeCount}`,
        `  Config 侧：${configKeys.length}${configKeys.length > 0 ? `（${configKeys.join(', ')}）` : '（未抽到 Config 块：export const Config = z.object({ … }) 锚点被改动了）'}`,
        '以 Config 为准更新 README 架构图的数字；不要反过来删 Config 键去凑 README。',
      ].join('\n'),
    ).toBe(configKeys.length)
  })
})
