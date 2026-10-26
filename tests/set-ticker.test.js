const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../content_scripts/tv.js'), 'utf8')
const setter = source.slice(source.indexOf('tv.setTicker = '), source.indexOf('tv._isTestingPeriodPresetSelected = '))

async function select(target, rows, reportedSymbol, categorySelected = false) {
  let open = false
  let chosen = null
  let scans = 0
  let categoryReset = false
  const reset = { dispatchEvent() {}, click() { categorySelected = false; categoryReset = true } }
  const input = { dispatchEvent: () => { open = false } }
  const button = { dispatchEvent() {}, click: () => { open = true } }
  const elements = rows.map(([symbol, text]) => ({
    innerText: text,
    getAttribute: name => name === 'data-symbol-name' ? symbol : null,
    dispatchEvent() {},
    click() { chosen = symbol; open = false }
  }))
  const context = vm.createContext({
    tv: { getChartSymbol: async () => {
      const symbol = reportedSymbol === undefined ? chosen : reportedSymbol
      return symbol ? { symbol, shortName: symbol.split(':').pop() } : null
    } },
    SEL: { symbolSearchButton: 'button', symbolSearchInput: 'input', symbolSearchDialog: 'dialog', symbolSearchItem: 'rows', symbolSearchTab: 'tabs', symbolSearchCategoryReset: 'reset' },
    document: {
      querySelector: selector => selector === 'reset' && categorySelected ? reset : selector === 'button' ? button : selector === 'input' && open ? input : null,
      querySelectorAll: selector => { if (selector === 'rows') { scans++; return categorySelected ? [] : elements } return [] }
    },
    page: { waitForSelector: async () => open ? {} : null, waitForTimeout: async () => {}, setInputElementValue() {} },
    MouseEvent: class {}, KeyboardEvent: class {}, console
  })
  vm.runInContext(setter, context)
  const ok = await context.tv.setTicker(target)
  return { ok, chosen, open, scans, categoryReset }
}

// Live TradingView rows expose the exchange through a logo/tooltip, not innerText.
const apple = ['NASDAQ:AAPL', 'A\nAAPL\nApple Inc.\nstock']

test('selects the qualified row when its exchange is absent from visible text', async () => {
  const result = await select(' nasdaq:aapl ', [apple])
  assert.equal(result.ok, true)
  assert.equal(result.chosen, 'NASDAQ:AAPL')
})

test('ignores wrong exchanges, symbol prefixes, and description-only matches', async () => {
  const result = await select('NASDAQ:AAPL', [
    ['BATS:AAPL', 'AAPL\nNASDAQ listing'],
    ['NASDAQ:AAPLDXX', 'AAPLDXX\nNASDAQ'],
    ['NASDAQ:AAPU', 'Direxion Daily AAPL Bull 2X ETF\nNASDAQ'],
    apple
  ])
  assert.equal(result.ok, true)
  assert.equal(result.chosen, 'NASDAQ:AAPL')
})

test('preserves exact short-symbol selection for unqualified targets', async () => {
  const result = await select('AAPL', [['NASDAQ:AAPLDXX', 'AAPLDXX'], apple])
  assert.equal(result.ok, true)
  assert.equal(result.chosen, 'NASDAQ:AAPL')
})

test('fails and closes the dialog without clicking an unidentified or foreign row', async () => {
  const result = await select('NASDAQ:AAPL', [[null, 'NASDAQ\nAAPL'], ['BATS:AAPL', 'AAPL']])
  assert.equal(result.ok, false)
  assert.equal(result.chosen, null)
  assert.equal(result.open, false)
  assert.equal(result.scans, 20)
})

test('still requires the chart read-back to match the requested exchange', async () => {
  const result = await select('NASDAQ:AAPL', [apple], 'BATS:AAPL')
  assert.equal(result.chosen, 'NASDAQ:AAPL')
  assert.equal(result.ok, false)
})


test('clears the selected-category pill before searching another asset type', async () => {
  const result = await select('TVC:GOLD', [['TVC:GOLD', 'G\nGOLD\nGold\ncommodity cfd']], undefined, true)
  assert.equal(result.categoryReset, true)
  assert.equal(result.ok, true)
  assert.equal(result.chosen, 'TVC:GOLD')
})
