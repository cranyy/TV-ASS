const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const actionSource = fs.readFileSync(path.join(__dirname, '../content_scripts/action.js'), 'utf8')

function load(extra = {}) {
  const context = vm.createContext({ console: { log() {}, warn() {} }, Math, ...extra })
  vm.runInContext(actionSource, context)
  return vm.runInContext('action', context)
}

const results = (extra = {}) => ({ ticker: 'OANDA:XAUUSD', timeFrame: '10m', shortName: 'AlgoPro Bot V3', cycles: 24,
  isMaximizing: true, optParamName: 'Net profit: All', method: 'brute force', ...extra })

test('two runs started in the same second get different ids', () => {
  const action = load()
  const second = new Date(2026, 9, 30, 2, 6, 56)
  const a = action._newRunId(second)
  const b = action._newRunId(second)
  assert.notEqual(a, b)
  assert.match(a, /^261030-020656-[a-z0-9]{4}$/)
  assert.equal(action._isRunId(a), true)
  assert.equal(action._isRunId('2026-10-30'), false)
})

test("a run's training and validation files and the report footer share its id", () => {
  const action = load()
  const runId = action._newRunId(new Date(2026, 9, 30, 2, 6, 56))
  const tr = results({ runId, wfa: { training: {}, validation: {} } })
  const training = action._resultsCsvName({ ...tr, wfaWindow: 'training' })
  const validation = action._resultsCsvName({ ...tr, wfaWindow: 'validation' })
  assert.equal(training, `OANDA:XAUUSD:10m AlgoPro Bot V3 - 24_max_Net profit: All_brute force_run-${runId}_training.csv`)
  assert.equal(validation, training.replace('_training.csv', '_validation.csv'))
  const footer = action._wfaFooter(tr, { checks: [{ row: {} }], original: {} }, [])
  assert.ok(footer.includes(validation.replace(/[\\/:*?"<>|]/g, '_')))
})

test('results saved by an older version keep the old name', () => {
  const action = load()
  assert.equal(action._resultsCsvName(results({ wfaWindow: 'validation' })),
    'OANDA:XAUUSD:10m AlgoPro Bot V3 - 24_max_Net profit: All_brute force_validation.csv')
})

test('the manual results download uses the same name as the end-of-run save', async () => {
  const saved = []
  const stored = results({ runId: '261030-020656-k3x9', perfomanceSummary: [{ 'Net profit: All': 1 }], paramsNames: [] })
  const action = load({
    storage: { STRATEGY_KEY_RESULTS: 'r', getKey: async () => stored },
    model: { buildExportSummaries: async tr => ({ fullSummary: tr.perfomanceSummary, fullFiltered: [] }) },
    file: { convertResultsToCSV: () => 'csv', saveAs: (_text, name) => saved.push(name) },
    ui: { showWarningPopup: async () => {} },
    backtest: { DEF_MAX_PARAM_NAME: 'Net profit: All' }
  })
  action._currentResultsContextMatch = async () => ({ match: false })
  action._resultsMismatchMessage = () => ''
  await action.downloadStrategyTestResults()
  assert.deepEqual(saved, [action._resultsCsvName(stored)])
})
