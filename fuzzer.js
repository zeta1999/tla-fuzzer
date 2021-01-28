import * as fs from 'fs'
import * as path from 'path'
import * as url from 'url'

import { nativeStrategy } from './strategy.native.js'
import { registryStrategy } from './strategy.registry.js'
import { rollupStrategy } from './strategy.rollup.js'
import { webpackStrategy } from './strategy.webpack.js'
import { systemJSStrategy } from './strategy.system.js'

const strategies = [
  registryStrategy,
  rollupStrategy,
  webpackStrategy,
  systemJSStrategy,
]

function generateTestCase() {
  const files = {}

  for (let i = 0; i < 10; i++) {
    let isAsync = Math.random() < 0.5
    let code = ''
    if (isAsync) {
      code = `
tlaTrace('${i} before')
await 0
tlaTrace('${i} in between')
Promise.resolve().then(() => {
  tlaTrace('${i} after')
})
`
    } else {
      code = `
tlaTrace('${i} before')
Promise.resolve().then(() => {
  tlaTrace('${i} after')
})
`
    }
    if (i > 0) {
      if (Math.random() < 0.5) {
        let other = Math.random() * i | 0
        code += `
import "./${other}.mjs"
`
      } else {
        let other1 = Math.random() * i | 0
        let other2 = Math.random() * i | 0
        code += `
import "./${other1}.mjs"
import "./${other2}.mjs"
`
      }
    }
    files[`${i}.mjs`] = code
  }

  return files
}

let currentTrace
global.tlaTrace = text => currentTrace.push(text)

async function runStrategy(strategy, files, dir) {
  const strategyDir = path.join(dir, strategy.name)
  fs.mkdirSync(strategyDir, { recursive: true })
  const js = await strategy(files, strategyDir)
  const file = path.join(dir, strategy.name + '.js')
  fs.writeFileSync(file, js)
  try {
    currentTrace = []
    await import(file)
    return currentTrace.join('\n')
  } catch (e) {
    return (e && e.stack || e) + ''
  }
}

async function main() {
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
  const dir = path.join(__dirname, '.tests')
  try { fs.rmdirSync(dir, { recursive: true }) } catch (e) { }

  let counterexamples = []
  for (let i = 0; i < strategies.length; i++) {
    counterexamples.push(null)
  }

  const decorate = (name, fail) => fail ? `    🚫 \x1b[31m${name}\x1b[0m` : `    ✅ \x1b[32m${name}\x1b[0m`
  for (let i = 0; i < 100; i++) {
    const testDir = path.join(dir, i.toString())
    fs.mkdirSync(testDir, { recursive: true })

    // V8 is assumed to be correct
    const files = generateTestCase()
    const expectedStdout = await runStrategy(nativeStrategy, files, testDir)
    let isImportantFailure = false

    // Test the correctness of other strategies
    for (let i = 0; i < strategies.length; i++) {
      if (counterexamples[i]) continue
      const observedStdout = await runStrategy(strategies[i], files, testDir)
      if (observedStdout !== expectedStdout) {
        counterexamples[i] = { files, expectedStdout, observedStdout }
        isImportantFailure = true
      }
    }

    // Visualize current test status
    process.stdout.write(
      `\r${i + 1} run${i ? 's' : ''}:` + [decorate(nativeStrategy.name, false)].concat(
        strategies.map((strategy, i) => decorate(strategy.name, counterexamples[i]))).join(''))

    // Only keep this directory if it contains a counter-example
    if (!isImportantFailure) try { fs.rmdirSync(testDir, { recursive: true }) } catch (e) { }

    // Stop now if all tests are failing
    if (counterexamples.every(x => x)) break
  }

  process.stdout.write('\n')

  // Print information about failed strategies
  const indent = text => '  ' + text.trim().replace(/\n/g, '\n  ')
  for (let i = 0; i < strategies.length; i++) {
    const counter = counterexamples[i]
    if (!counter) continue
    console.log(`\n${'='.repeat(80)}\n🚫 \x1b[31m${strategies[i].name}\x1b[0m`)
    for (const name in counter.files) {
      console.log(`\n\x1b[1m[${name}]\x1b[0m\n${indent(counter.files[name])}`)
    }
    console.log(`\n\x1b[1m[Expected stdout]\x1b[0m\n${indent(counter.expectedStdout)}`)
    console.log(`\n\x1b[1m[Observed stdout]\x1b[0m\n${indent(counter.observedStdout)}\n`)
  }

  // Update the readme
  let readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8')
  let index = readme.indexOf('## Current results\n')
  if (index !== -1) {
    readme = readme.slice(0, index) + '## Current results\n\n' +
      `"Correct" here means that the bundled code behaves exactly the same as the unbundled code. ` +
      `"Incorrect" here means that the bundled code behaves differently (i.e. is evaluated in a different order) than unbundled code.\n\n`
    for (let i = 0; i < strategies.length; i++) {
      readme += `* ${strategies[i].version}: ${counterexamples[i] ? `🚫 Incorrect` : `✅ Correct`}\n`
    }
    fs.writeFileSync(path.join(__dirname, 'README.md'), readme)
  }
}

await main()