import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '../..')
const REVIEW_CONFIG = 'eslint.review.config.mjs'

// depend/ban-dependencies は dev と prod を区別しないので、配布物に入らない
// dev 専用パッケージだけをここで許している。増やすときは必ずこのテストと
// eslint.review.config.mjs のコメントの両方を通すこと。
const ALLOWED_BANNED_DEPENDENCIES = ['moment']

type RuleEntry = unknown
type RuleMap = Record<string, RuleEntry>

interface Probe {
  official: RuleMap
  resolved: Record<string, RuleMap>
}

// eslint-plugin-obsidianmd は ESM 専用で、jest は CJS で走っている。
// 子プロセスに追い出せば Node のバージョンに関係なく読める。
const PROBE_SOURCE = `
import { ESLint } from "eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
const eslint = new ESLint({ overrideConfigFile: ${JSON.stringify(REVIEW_CONFIG)} });
const official = {};
for (const block of obsidianmd.configs.recommended) {
  if (!block || typeof block !== "object" || !block.rules) continue;
  for (const [name, value] of Object.entries(block.rules)) official[name] = value;
}
const resolved = {};
for (const file of ["src/main.ts", "manifest.json", "LICENSE", "package.json"]) {
  resolved[file] = (await eslint.calculateConfigForFile(file)).rules ?? {};
}
console.log(JSON.stringify({ official, resolved }));
`

function severityOf(entry: RuleEntry): number {
  const raw = Array.isArray(entry) ? entry[0] : entry
  if (raw === 'error' || raw === 2) return 2
  if (raw === 'warn' || raw === 1) return 1
  return 0
}

describe('Obsidian review gate configuration', () => {
  let probe: Probe

  beforeAll(() => {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    probe = JSON.parse(stdout) as Probe
  }, 180_000)

  // validate-manifest は「lint 対象のファイル名が manifest.json のときだけ」動く。
  // eslint.config.mjs は src/**/*.ts のブロックに書いていたので一度も発火して
  // いなかった。同じ取りこぼしを二度とやらないための番人。
  test('manifest.json is actually linted by validate-manifest', () => {
    expect(severityOf(probe.resolved['manifest.json']['obsidianmd/validate-manifest'])).toBe(2)
  })

  // validate-license も同じで、LICENSE そのものを lint したときだけ動く。
  test('LICENSE is actually linted by validate-license', () => {
    expect(severityOf(probe.resolved['LICENSE']['obsidianmd/validate-license'])).toBe(2)
  })

  // レビュー基準を手写しした瞬間にズレが始まる（#123 / #130 がその後始末だった）。
  // 公式 recommended が有効にしているルールは、必ずどこかの対象ファイルで
  // 公式以上の強さで効いていること。
  test('every rule the official recommended config enables stays enabled', () => {
    const drift: string[] = []
    for (const [name, entry] of Object.entries(probe.official)) {
      const required = severityOf(entry)
      if (required === 0) continue
      const strongest = Math.max(
        ...Object.values(probe.resolved).map((rules) =>
          name in rules ? severityOf(rules[name]) : 0,
        ),
      )
      if (strongest < required) {
        drift.push(`${name} (official ${required}, ours ${strongest})`)
      }
    }
    expect(drift).toEqual([])
    // 空の recommended を読んでしまったのに通った、を防ぐ
    expect(Object.keys(probe.official).length).toBeGreaterThan(100)
  })

  test('the banned-dependency exemptions stay exactly the documented ones', () => {
    const entry = probe.resolved['package.json']['depend/ban-dependencies']
    expect(severityOf(entry)).toBe(2)
    const options = Array.isArray(entry) ? (entry[1] as { allowed?: string[] }) : undefined
    expect(options?.allowed).toEqual(ALLOWED_BANNED_DEPENDENCIES)
  })

  // 手写しに戻っていないこと。公式 config を spread しているのが唯一の正解。
  test('the review config derives from the official recommended config', () => {
    const source = fs.readFileSync(path.join(ROOT, REVIEW_CONFIG), 'utf8')
    expect(source).toContain('...obsidianmd.configs.recommended')
  })

  test('the release workflow runs the review before it touches the branch', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')

    const reviewAt = workflow.indexOf('npm run review:obsidian')
    const gitUserAt = workflow.indexOf('Configure git user')

    expect(reviewAt).toBeGreaterThan(-1)
    expect(gitUserAt).toBeGreaterThan(-1)
    // bump コミットとタグの push より後ろに置くと、落ちたときに main だけ
    // 進んだ状態が残る
    expect(reviewAt).toBeLessThan(gitUserAt)

    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(scripts.scripts['review:obsidian']).toBe('node scripts/obsidian-review.mjs')
  })
})
