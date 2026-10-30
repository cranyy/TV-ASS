const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const read = file => fs.readFileSync(path.join(__dirname, '../content_scripts', file), 'utf8')
const tvSource = read('tv.js')
const compare = tvSource.slice(tvSource.indexOf('tv._valuesLooseEqual = '), tvSource.indexOf('tv._readCommittedInputs = '))
const TARGET = 'Net profit: All'

// The real walk-forward validation, getTestIterationResult and CSV export against a fake chart. `takes(check, key, n)`
// decides whether the n-th attempt to set `key` while testing `check` reaches the chart; the setter reports success
// either way, like a number or checkbox the dialog silently ignored.
function walkForward({ takes = () => true, readable = () => true, runtimeError = () => false, refreshOk = true, onRead } = {}) {
  const chart = { Signal: 'RSI', Len: 100 }
  const attempts = {}
  const setterCalls = []
  const saved = []
  const autosaved = []
  let current = null
  const context = vm.createContext({
    console: { log() {}, warn() {}, info() {}, error() {} },
    page: { waitForTimeout: async () => {} },
    ui: { statusMessage() {} },
    tv: {
      _reportSignature: () => 'sig',
      setStrategyParams: async (_name, payload) => {
        setterCalls.push({ check: current && current.kind, payload: { ...payload } })
        Object.keys(payload).forEach(key => {
          const n = attempts[`${current ? current.kind : 'apply'}:${key}`] = (attempts[`${current ? current.kind : 'apply'}:${key}`] || 0) + 1
          if (!current || takes(current, key, n))
            chart[key] = payload[key]
        })
        context.tv.lastSetStrategyResult = { method: 'legacy', legacy: { applied: Object.keys(payload), missing: [], failed: [] } }
        return true
      },
      getPerformance: async () => runtimeError(current)
        ? { error: 2, runtimeError: 'Runtime error', data: {} }
        : { error: null, data: { [TARGET]: (chart.Signal === 'Hull Suite' ? 1000 : 500) + chart.Len } },
      _readCommittedInputs: async () => {
        if (onRead) onRead(current)
        return readable(current) ? { ...chart } : null
      }
    }
  })
  vm.runInContext(compare, context)
  for (const file of ['backtest.js', 'file.js', 'action.js'])
    vm.runInContext(read(file), context)
  const action = vm.runInContext('action', context)
  const backtest = vm.runInContext('backtest', context)
  const file = vm.runInContext('file', context)
  backtest.delay = async () => {}
  backtest._autosaveOnBest = (_tr, res, options) => autosaved.push(options.suffix)
  file.saveAs = (text, name) => saved.push({ text, name })
  action.workerStatus = 'testStrategy'

  const checks = [
    { kind: 'winner', rank: 1, propVal: { Signal: 'Hull Suite', Len: 200 }, trainingRow: { [TARGET]: 9 } },
    { kind: 'runner', rank: 2, propVal: { Signal: 'Chandelier Exit', Len: 300 }, trainingRow: { [TARGET]: 8 } },
    { kind: 'start', isStart: true, propVal: { Signal: 'RSI', Len: 100 }, trainingRow: { [TARGET]: 7 } }
  ]
  action._wfaCandidates = async () => checks
  action._wfaSetWindow = async () => ({ periodSet: true, ok: refreshOk, error: refreshOk ? null : 3, message: 'the dates did not update' })
  const original = backtest.getTestIterationResult
  backtest.getTestIterationResult = (testResults, propVal) => {
    current = checks.find(check => check.propVal === propVal)
    return original(testResults, propVal)
  }
  const testResults = {
    shortName: 'S', ticker: 'XAUUSD', timeFrame: '10m', cycles: 3, isMaximizing: true, method: 'brute force',
    optParamName: TARGET, backtestDelay: 0, paramsNames: ['Signal', 'Len'],
    wfa: { validation: { from: '2025-10-12', to: '2025-12-31', days: 80 } }
  }
  const wfa = { winnerPropVal: checks[0].propVal }
  // quoted fields may hold commas; a doubled quote is a literal quote
  const cellsOf = line => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].slice(0, -1).map(m => m[1])
  const csvRows = () => {
    const lines = saved[0].text.trim().split('\n').map(cellsOf)
    const header = lines[0].map(cell => JSON.parse(cell))
    return lines.slice(1).map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i]])))
  }
  return { run: () => action._wfaValidate(testResults, wfa), action, checks, testResults, wfa, setterCalls, saved, autosaved, csvRows }
}

test('confirmed inputs keep their results and downloads', async () => {
  const w = walkForward()
  await w.run()
  assert.deepEqual(w.checks.map(check => check.row[TARGET]), [1200, 800, 600])
  assert.deepEqual(w.checks.map(check => check.error), [false, false, false])
  assert.deepEqual(w.autosaved, ['final', '2', 'start'])
})

test('an input the chart ignored is sent once more and then counts', async () => {
  const w = walkForward({ takes: (check, key, n) => !(check.kind === 'start' && key === 'Signal' && n === 1) })
  await w.run()
  const start = w.checks[2]
  assert.equal(start.error, false)
  assert.equal(start.row[TARGET], 600)
  assert.deepEqual(w.setterCalls.filter(call => call.check === 'start').map(call => call.payload), [{ Signal: 'RSI', Len: 100 }, { Signal: 'RSI' }])
  assert.deepEqual(w.autosaved, ['final', '2', 'start'])
})

test('a persistent mismatch is exported without numbers and never downloaded as a winner', async () => {
  const w = walkForward({ takes: (check, key) => !(check.kind === 'start' && key === 'Signal') })
  await w.run()
  const start = w.checks[2]
  assert.equal(start.error, true)
  assert.match(start.message, /Not tested: the chart did not take Signal/)
  assert.equal(Object.hasOwn(start.row, TARGET), false)
  const exported = w.csvRows().find(row => /Not tested/.test(row.comment))
  assert.equal(exported[TARGET], '')
  assert.equal(exported.__Signal, '"RSI"')
  assert.deepEqual(w.autosaved, ['final', '2'])
  assert.equal(Object.hasOwn(w.testResults.lastAppliedParams, 'Signal'), false)
  assert.equal(Object.hasOwn(w.testResults.lastAppliedParams, 'Len'), false)
})

test('mismatch, retry, then an unreadable dialog is not accepted', async () => {
  let reads = 0
  const w = walkForward({
    takes: (check, key, n) => !(check.kind === 'runner' && key === 'Signal' && n === 1),
    readable: check => !(check && check.kind === 'runner' && ++reads > 1)
  })
  await w.run()
  const runner = w.checks[1]
  assert.equal(runner.error, true)
  assert.match(runner.message, /could not be confirmed/)
  assert.equal(w.csvRows().find(row => /Training #2/.test(row.comment))[TARGET], '')
  assert.deepEqual(w.autosaved, ['final', 'start'])
})

test('Stop before the retry: no retry, the check is not counted, the check stops', async () => {
  const w = walkForward({
    takes: (check, key) => !(check.kind === 'runner' && key === 'Signal'),
    onRead: check => { if (check && check.kind === 'runner') w.action.workerStatus = null }
  })
  await w.run()
  assert.equal(w.setterCalls.filter(call => call.check === 'runner').length, 1)
  assert.equal(w.checks[1].error, true)
  assert.equal(w.wfa.stopped, 'validation')
  assert.equal(w.checks[2].row, undefined)
})

test('runtime errors and a failed date refresh keep their own handling without a read-back', async () => {
  let reads = 0
  const w = walkForward({ refreshOk: false, runtimeError: check => check && check.kind === 'runner', onRead: () => { reads++ } })
  await w.run()
  assert.equal(w.checks[0].error, true)
  assert.equal(w.checks[0].message, 'the dates did not update')
  assert.equal(w.checks[1].error, true)
  assert.match(w.checks[1].message, /runtime error/)
  assert.equal(reads, 1) // only the start check was read back
  assert.deepEqual(w.autosaved, ['start'])
})
