const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const read = file => fs.readFileSync(path.join(__dirname, '../content_scripts', file), 'utf8')

// enough of the browser's FileReader for file.parseCSV
class FileReader {
  constructor() { this.listeners = [] }
  addEventListener(type, fn) { if (type === 'load') this.listeners.push(fn) }
  readAsText(blob) { blob.text().then(result => this.listeners.forEach(fn => fn({ target: { result } }))) }
}

const csv = (from, to, step) => `Parameter,From,To,Step,Default,Priority,Enabled\nLen,${from},${to},${step},${from},1,true\n`
const strategyData = { name: 'S', properties: { Len: 100, Signal: 'RSI;Hull Suite;Chandelier Exit' } }

// The real model, CSV reader, range selection and result saving of a run, with shared storage that another tab can
// rewrite and a testing period the test moves.
function tabWith(stored) {
  const storage = { value: stored, writes: [] }
  const chart = { period: null, saved: [] }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} }, File, FileReader, Date, Math, JSON,
    storage: {
      STRATEGY_KEY_PARAM: 'strategy_param',
      getKey: async () => storage.value,
      setKeys: async (_key, value) => { storage.writes.push(value); storage.value = value },
      loadChunks: async () => []
    },
    tv: { _readTestingPeriod: () => chart.period },
    ui: { showAndUpdateStrategyParameters: async () => ({ paramRange: null, cycles: 3 }), alertPopup: async () => true,
      showErrorPopup: async () => {}, showWarningPopup: async () => {}, statusMessageRemove() {}, statusMessage() {}, statusApplyLine() {} }
  })
  for (const file of ['file.js', 'model.js', 'backtest.js', 'action.js'])
    vm.runInContext(read(file), context)
  vm.runInContext('file.saveAs = (text, name) => savedFiles.push(name)', Object.assign(context, { savedFiles: chart.saved }))
  const action = vm.runInContext('action', context)
  const plain = value => JSON.parse(JSON.stringify(value))
  const start = async request => plain((await action._getRangeParams(strategyData, await action._requestedRange(request, strategyData)))[0])
  return { action, storage, start, context, chart }
}

const storedRange = (from, to) => ({ Len: [from, to, 100, from, 1, true], Signal: ['RSI', 'Hull Suite', '', 'RSI', 2, false] })

test('interleaved starts each use the ranges they were started with', async () => {
  const tab = tabWith(storedRange(500, 600))
  const first = tab.start({ rangesCsv: csv(100, 200, 50) })
  tab.storage.value = storedRange(700, 800) // another tab saves its ranges meanwhile
  const second = tab.start({ rangesCsv: csv(300, 400, 50) })
  assert.deepEqual((await first).Len, [100, 150, 200])
  assert.deepEqual((await second).Len, [300, 350, 400])
  assert.deepEqual(tab.storage.writes, [])
  assert.deepEqual(tab.storage.value.Len, [700, 800, 100, 700, 1, true])
})

test('a start without ranges still reads the stored ones and keeps normalizing them', async () => {
  const tab = tabWith({ Len: [500, 600, 100, 500, 1] }) // an old 5-field entry is normalized and saved back
  assert.deepEqual((await tab.start({})).Len, [500, 600])
  assert.equal(tab.storage.writes.length, 1)
  assert.equal(tab.storage.writes[0].Len[5], true)
})

test('ranges for inputs the strategy does not have stop the start', async () => {
  const tab = tabWith(storedRange(500, 600))
  const bad = 'Parameter,From,To,Step,Default,Priority,Enabled\nNot An Input,1,2,1,1,1,true\n'
  await assert.rejects(tab.start({ rangesCsv: bad }), /not part of the current strategy/)
})

test('a start can hand over the stored ranges as they were when it began', async () => {
  const tab = tabWith(storedRange(500, 600))
  const captured = JSON.parse(JSON.stringify(tab.storage.value)) // what the harness read when it started the run
  tab.storage.value = storedRange(700, 800) // another tab saves its ranges before this run reads them
  assert.deepEqual((await tab.start({ paramRange: captured })).Len, [500, 600])
  assert.deepEqual(tab.storage.writes, [])
})

test('a start that found nothing stored uses the strategy defaults, whatever is stored later', async () => {
  const defaults = await tabWith(null).start({}) // what a start with nothing stored generates
  const tab = tabWith(null)
  tab.storage.value = storedRange(700, 800)
  const used = await tab.start({ paramRange: {} })
  assert.deepEqual(used, defaults)
  assert.notDeepEqual(used.Len, [700, 800])
  assert.deepEqual(tab.storage.writes, [])
})

test('a run clears its tab result when it starts', async () => {
  const { action } = tabWith(storedRange(500, 600))
  action.lastRunResults = { runId: 'older run' }
  action._getStrategyData = async () => { throw new Error('the chart could not be read') }
  await action.testStrategy({})
  assert.equal(action.lastRunResults, null)
})

// _wfaRun saves the training results, then the validation autosaves rewrite the same run context with the new dates
test('the recorded results keep their training rows and dates after validation autosaves', async () => {
  const { action, context, chart } = tabWith(storedRange(500, 600))
  const backtest = vm.runInContext('backtest', context)
  const training = { label: 'Jan 4, 2019 — Apr 4, 2025', from: '2019-01-04', to: '2025-04-04' }
  const validation = { label: 'Apr 5, 2025 — Oct 27, 2026', from: '2025-04-05', to: '2026-10-27' }
  const metrics = (net, len) => ({ 'Net profit: All': net, 'Net profit %: All': net / 50, 'Percent profitable: All': 55,
    'Max equity drawdown %: All': 5, 'Total trades: All': 100, __Len: len, comment: '' })
  const run = { runId: '261030-020656-k3x9', shortName: 'S', ticker: 'XAUUSD', timeFrame: '10m', cycles: 2, isMaximizing: true,
    optParamName: 'Net profit: All', method: 'brute force', wfaWindow: 'training', paramsNames: ['Len'],
    perfomanceSummary: [metrics(120, 100), metrics(80, 150)], filteredSummary: [],
    runContext: { dateRange: { label: 'Jan 4, 2019 — Oct 27, 2026', from: '2019-01-04', to: '2026-10-27' } } }

  chart.period = training
  await action._saveTestResults(run, run, false)
  chart.period = validation
  run.wfaWindow = 'validation'
  backtest._autosaveOnBest(run, { data: metrics(300, 100), bestPropVal: { Len: 100 } }, { force: true, suffix: 'final', ignoreFilters: true })

  assert.equal(run.runContext.dateRange.from, '2025-04-05') // the run itself has moved on to the validation dates
  const recorded = action.lastRunResults
  assert.notEqual(recorded, run)
  assert.equal(recorded.runId, run.runId)
  assert.equal(recorded.wfaWindow, 'training')
  assert.deepEqual(JSON.parse(JSON.stringify(recorded.runContext.dateRange)), training)
  assert.deepEqual(recorded.perfomanceSummary.map(row => row['Net profit: All']), [120, 80])
  assert.ok(chart.saved.length >= 2) // the training save and the validation autosave really wrote files
})
