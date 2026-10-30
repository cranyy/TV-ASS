const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const tvSource = fs.readFileSync(path.join(__dirname, '../content_scripts/tv.js'), 'utf8')
const slice = (from, to) => tvSource.slice(tvSource.indexOf(from), tvSource.indexOf(to))
const legacySetter = slice('tv._setStrategyParamsLegacy = ', 'tv._humanizeStrategyApply = ')
const importAndHelpers = slice('tv.applyInputParams = ', 'tv.getChartSession = ')
const backtestSource = fs.readFileSync(path.join(__dirname, '../content_scripts/backtest.js'), 'utf8')
const pageSource = fs.readFileSync(path.join(__dirname, '../content_scripts/page.js'), 'utf8')
// the real option search and its waits: waitForSelector, getElText, setSelByText
const realSelection = pageSource.slice(pageSource.indexOf('page.waitForSelector = '), pageSource.indexOf('page.getTextForSel = ')) +
  pageSource.slice(pageSource.indexOf('page.getElText = '))

const LABEL = 'Main Trading Signal (S)'
const OPTIONS = ['Supertrend', 'RSI', 'Chandelier Exit', 'Hull Suite']

// One dropdown input in a TradingView-like dialog. `clicks` says what each option click does to the chart:
// 'apply' shows the clicked option, 'ignore' leaves the old value, 'other' shows a different option.
function dialog({ value = 'RSI', clicks = ['apply'] } = {}) {
  const state = { opens: 0, listOpen: false, okClicks: 0, attempt: 0 }
  const button = { innerText: value }
  const label = { innerText: LABEL, getAttribute: () => 'first-x', getBoundingClientRect: () => ({ top: 10, bottom: 20 }),
    checkVisibility: () => true, querySelector: () => null }
  const valueCell = { innerText: value, getAttribute: () => 'cell-x', querySelector: sel => sel === 'button[role="combobox"]' ? button : null }
  const cells = [label, valueCell]
  const page = {
    $: sel => sel === 'ok' ? { click: () => { state.okClicks++ } } : null,
    waitForTimeout: async () => {},
    waitForSelector: async (_sel, _t, hide) => hide ? !state.listOpen : state.listOpen,
    getElText: el => el.innerText,
    mouseClick: el => { if (el === button) { state.listOpen = !state.listOpen; if (state.listOpen) state.opens++ } },
    setInputElementValue: () => {},
    setSelByText: async (_sel, text) => {
      if (!state.listOpen) return false
      const option = OPTIONS.find(o => o.toLowerCase().startsWith(String(text).toLowerCase()))
      if (!option) return false
      const effect = clicks[Math.min(state.attempt++, clicks.length - 1)]
      if (effect === 'apply') button.innerText = option
      if (effect === 'other') button.innerText = 'Supertrend'
      state.listOpen = false
      return true
    }
  }
  const context = vm.createContext({
    tv: { checkAndOpenStrategy: async () => ({}), changeDialogTabToInput: async () => true },
    SEL: { indicatorProperty: 'cells', strategyListOptions: 'options', okBtn: 'ok', indicatorScroll: 'scroll' },
    document: { querySelectorAll: () => cells, querySelector: sel => sel === 'options' && state.listOpen ? {} : null },
    page, console
  })
  vm.runInContext(importAndHelpers + legacySetter, context)
  return { context, state, button }
}

const plain = value => JSON.parse(JSON.stringify(value))

test('optimizer setter reports a dropdown the chart did not take, after a second try', async () => {
  const d = dialog({ value: 'RSI', clicks: ['ignore', 'ignore'] })
  const r = plain(await d.context.tv._setStrategyParamsLegacy('S', { [LABEL]: 'Hull Suite' }))
  assert.equal(r.success, false)
  assert.deepEqual(r.failed, [LABEL])
  assert.deepEqual(r.applied, [])
  assert.deepEqual(r.missing, [])
  assert.equal(d.state.opens, 2)
  assert.equal(d.button.innerText, 'RSI')
})

test('optimizer setter reports a dropdown that landed on an unexpected option', async () => {
  const d = dialog({ value: 'RSI', clicks: ['other', 'other'] })
  const r = plain(await d.context.tv._setStrategyParamsLegacy('S', { [LABEL]: 'Hull Suite' }))
  assert.equal(r.success, false)
  assert.deepEqual(r.failed, [LABEL])
  assert.equal(d.button.innerText, 'Supertrend')
})

test('optimizer setter succeeds when the second try takes', async () => {
  const d = dialog({ value: 'RSI', clicks: ['ignore', 'apply'] })
  const r = plain(await d.context.tv._setStrategyParamsLegacy('S', { [LABEL]: 'Hull Suite' }))
  assert.equal(r.success, true)
  assert.deepEqual(r.applied, [LABEL])
  assert.deepEqual(r.failed, [])
  assert.equal(d.state.opens, 2)
})

test('an already selected dropdown is not clicked', async () => {
  const d = dialog({ value: 'Hull Suite' })
  const r = plain(await d.context.tv._setStrategyParamsLegacy('S', { [LABEL]: 'Hull Suite' }))
  assert.equal(r.success, true)
  assert.equal(d.state.opens, 0)
})

test('CSV import opens the dropdown once per try and reports a failed one', async () => {
  const ok = dialog({ value: 'RSI', clicks: ['apply'] })
  const applied = plain(await ok.context.tv.applyInputParams({ [LABEL]: 'Chandelier Exit' }))
  assert.deepEqual(applied, { applied: [LABEL], missing: [], failed: [] })
  assert.equal(ok.state.opens, 1)
  assert.equal(ok.button.innerText, 'Chandelier Exit')

  const bad = dialog({ value: 'RSI', clicks: ['ignore', 'ignore'] })
  const failed = plain(await bad.context.tv.applyInputParams({ [LABEL]: 'Chandelier Exit' }))
  assert.deepEqual(failed, { applied: [], missing: [], failed: [LABEL] })
  assert.equal(bad.state.opens, 2)
})

// With the real setSelByText, an option click the menu ignores still reports a click and leaves the menu open.
// The next try must reopen the menu, not toggle the open one shut.
function realMenu({ takesClick }) {
  const state = { open: false, opens: 0, optionClicks: 0 }
  const button = { innerText: 'RSI' }
  const options = OPTIONS.map(text => ({ innerText: text, textContent: text, dataset: {}, getAttribute: () => null,
    click() { if (takesClick(++state.optionClicks)) { button.innerText = text; state.open = false } } }))
  const label = { innerText: LABEL }
  const valueCell = { innerText: 'RSI', querySelector: sel => sel === 'button[role="combobox"]' ? button : null }
  const context = vm.createContext({
    tv: {}, console,
    SEL: { indicatorProperty: 'cells', strategyListOptions: 'options' },
    document: {
      querySelectorAll: sel => sel === 'cells' ? [label, valueCell] : sel === 'options' && state.open ? options : [],
      querySelector: sel => sel === 'options' && state.open ? options[0] : null
    },
    page: { waitForTimeout: async () => {}, mouseClick: el => { if (el === button) { state.open = !state.open; if (state.open) state.opens++ } } }
  })
  vm.runInContext(realSelection + importAndHelpers, context)
  return { context, state, button, valueCell }
}

test('an ignored option click is retried in a reopened menu (real setSelByText)', async () => {
  const m = realMenu({ takesClick: n => n > 1 })
  assert.equal(await m.context.tv._selectComboValue(LABEL, m.valueCell, 'Hull Suite'), true)
  assert.equal(m.state.optionClicks, 2)
  assert.equal(m.state.opens, 2)
  assert.equal(m.button.innerText, 'Hull Suite')
  assert.equal(m.state.open, false)
})

test('a dropdown that never takes the click fails and leaves the menu closed (real setSelByText)', async () => {
  const m = realMenu({ takesClick: () => false })
  assert.equal(await m.context.tv._selectComboValue(LABEL, m.valueCell, 'Hull Suite'), false)
  assert.equal(m.state.optionClicks, 2)
  assert.equal(m.button.innerText, 'RSI')
  assert.equal(m.state.open, false)
})

// The real getTestIterationResult with only TradingView stubbed: a failed set must not leave the chart's old value
// cached, or a later candidate asking for that old value would skip the setter and be recorded under the wrong input.
test('after a failed set, a candidate asking for the previous value is sent to the chart', async () => {
  const sent = []
  let failNext = true
  const context = vm.createContext({
    console: { log() {}, warn() {}, info() {}, error() {} },
    page: { waitForTimeout: async () => {} },
    tv: {
      _reportSignature: () => 'sig',
      setStrategyParams: async (_name, payload) => {
        sent.push({ ...payload })
        const ok = !failNext
        failNext = false
        context.tv.lastSetStrategyResult = { method: ok ? 'legacy' : 'legacy-error',
          legacy: { applied: ok ? Object.keys(payload) : [], missing: [], failed: ok ? [] : Object.keys(payload) } }
        return ok
      },
      getPerformance: async () => ({ error: null, data: { 'Net profit: All': 1 } })
    }
  })
  vm.runInContext(backtestSource, context)
  const backtest = vm.runInContext('backtest', context)
  const testResults = { backtestDelay: 0, optParamName: 'Net profit: All', shortName: 'S',
    lastAppliedParams: { [LABEL]: 'RSI', 'EMA¹': 100 } }

  const first = await backtest.getTestIterationResult(testResults, { [LABEL]: 'Hull Suite', 'EMA¹': 100 })
  assert.equal(first.error, 1)
  assert.match(first.message, /1failed/)
  assert.equal(Object.hasOwn(testResults.lastAppliedParams, LABEL), false)

  const second = await backtest.getTestIterationResult(testResults, { [LABEL]: 'RSI', 'EMA¹': 100 })
  assert.equal(second.error, null)
  assert.deepEqual(sent[1], { [LABEL]: 'RSI' })
  assert.equal(testResults.lastAppliedParams[LABEL], 'RSI')
})
