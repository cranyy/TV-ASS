const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../content_scripts/tv.js'), 'utf8')
const apply = source.slice(source.indexOf('tv.applyInputParams = '), source.indexOf('tv.getChartSession = '))

async function run(request, { checked = false, labelClass = 'first-', checkbox = true, numeric = false } = {}) {
  const cb = { checked }
  const dropdown = { innerText: 'UTC' }
  const input = { value: 10 }
  let clicks = 0
  const selected = []
  const cell = (text, cls, controls) => ({
    innerText: text, getAttribute: () => cls,
    getBoundingClientRect: () => ({ top: 10, bottom: 20 }), checkVisibility: () => true,
    querySelector: selector => controls[selector] || null
  })
  // Actual layout: the first cell owns the checkbox; the next cell owns UTC.
  const cells = [cell('Custom Timezone', labelClass, checkbox ? { 'input[type="checkbox"]': cb } : {}),
    cell('UTC', '', numeric ? { input } : { 'button[role="combobox"]': dropdown })]
  const context = vm.createContext({
    tv: {}, SEL: { indicatorProperty: 'cells', strategyListOptions: 'options' },
    document: { querySelectorAll: () => cells },
    page: {
      $: () => null, waitForTimeout: async () => {},
      mouseClick: el => { if (el === cb) { clicks++; cb.checked = !cb.checked } },
      setInputElementValue: (el, value) => { el.value = value },
      setSelByText: async (_selector, value) => { selected.push(value); dropdown.innerText = value; return typeof value === 'string' }
    }
  })
  vm.runInContext(apply, context)
  const result = JSON.parse(JSON.stringify(await context.tv.applyInputParams({ 'Custom Timezone': request })))
  return { result, checked: cb.checked, timezone: dropdown.innerText, clicks, selected, value: input.value }
}

for (const [before, wanted] of [[false, true], [true, false], [false, false]]) {
  test(`inline checkbox ${before} -> ${wanted} leaves its adjacent timezone untouched`, async () => {
    const r = await run(wanted, { checked: before })
    assert.deepEqual(r.result, { applied: ['Custom Timezone'], missing: [], failed: [] })
    assert.equal(r.checked, wanted)
    assert.equal(r.timezone, 'UTC')
    assert.deepEqual(r.selected, [])
    assert.equal(r.clicks, before === wanted ? 0 : 1)
  })
}

test('saved timezone strings still use the adjacent dropdown', async () => {
  const r = await run('UTC+2')
  assert.equal(r.checked, false)
  assert.equal(r.timezone, 'UTC+2')
  assert.deepEqual(r.result.failed, [])
})

test('standalone fill checkboxes still apply', async () => {
  const r = await run(true, { labelClass: 'fill-' })
  assert.equal(r.checked, true)
  assert.deepEqual(r.result.failed, [])
})

test('ordinary numeric label/control pairs still apply', async () => {
  const r = await run(25, { checkbox: false, numeric: true })
  assert.equal(r.value, 25)
  assert.deepEqual(r.result.failed, [])
})
