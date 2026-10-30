const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../content_scripts/tv.js'), 'utf8')
const handler = source.slice(source.indexOf('async function messageHandler(event) {'), source.indexOf('// opt-in 4th param captureFullContext'))
const callPageAction = source.slice(source.indexOf('tv.callPageAction = '))
const ORIGIN = 'https://www.tradingview.com'

function page() {
  const posted = []
  const context = vm.createContext({
    tv: {}, tvPageMessageData: {}, posted, setTimeout, clearTimeout,
    window: { location: { origin: ORIGIN }, postMessage: message => posted.push(message) }
  })
  vm.runInContext(`${handler}\n${callPageAction}\nthis.messageHandler = messageHandler`, context)
  const reply = data => context.messageHandler({ origin: ORIGIN, data: { name: 'iondvPage', ...data } })
  return { context, posted, reply }
}

test('a reply that arrives after its request timed out is not kept', async () => {
  const p = page()
  for (let i = 0; i < 3; i++) {
    await assert.rejects(p.context.tv.callPageAction('pruneStrategyInputListeners', null, 1), /Timeout/)
    const { action, requestId } = p.posted[i]
    await p.reply({ action, requestId, data: { removed: 0 } })
  }
  assert.deepEqual(Object.keys(p.context.tvPageMessageData), [])
})

test('a reply that arrives in time still resolves its request', async () => {
  const p = page()
  const pending = p.context.tv.callPageAction('getChartSymbol', null, 1000)
  const { action, requestId } = p.posted[0]
  await p.reply({ action, requestId, data: { symbol: 'OANDA:XAUUSD' } })
  assert.equal((await pending).data.symbol, 'OANDA:XAUUSD')
  assert.deepEqual(Object.keys(p.context.tvPageMessageData), [])
})

test('replies without a requestId are still stored for getPageData', async () => {
  const p = page()
  await p.reply({ action: 'studyTemplates', data: ['a'] })
  assert.deepEqual(p.context.tvPageMessageData.studyTemplates, ['a'])
})
