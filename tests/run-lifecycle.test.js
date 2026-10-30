const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')

const read = file => fs.readFileSync(path.join(__dirname, '../content_scripts', file), 'utf8')
const actionSource = read('action.js')
const uiSource = read('ui.js')
const actionHead = actionSource.slice(0, actionSource.indexOf('const message = {'))
const closeOpenPopup = uiSource.slice(uiSource.indexOf('ui.closeOpenPopup = '), uiSource.indexOf('ui.statusMessageRemove = '))
const controller = read('controller.js')

// The real controller listener, work tracking and popup closing, with a fake popup and status box. Runs are fakes
// that record what they see.
function tab() {
  const log = []
  const dom = { popup: null, paramWindow: null, statusOwner: null }
  let listener = null
  const context = vm.createContext({
    console: { log() {}, error() {}, warn() {}, info() {} },
    setInterval() {},
    SEL: { tvDialogRoot: 'root' },
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn } } } },
    page: { waitForSelector: async () => null, waitForTimeout: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))) },
    document: { getElementById: id => id === 'iondvAlertPopup' ? dom.popup : id === 'iondvStratParam' ? dom.paramWindow : null },
    ui: {
      checkInjectedElements() {},
      statusMessage: () => { dom.statusOwner = dom.statusOwner || 'waiting' },
      statusMessageRemove: () => { log.push(`status removed (owner ${dom.statusOwner})`); dom.statusOwner = null },
      autoCloseAlert: msg => log.push(`refused: ${msg}`),
      showErrorPopup: async () => {}
    }
  })
  vm.runInContext(actionHead + closeOpenPopup + controller, context)
  const action = vm.runInContext('action', context)

  // a report popup like ui.reportPopup: one at a time, closed by its OK button
  const showReport = name => new Promise(resolve => {
    const ok = { onclick: () => { dom.popup = null; resolve() }, click() { this.onclick() } }
    dom.popup = { querySelector: sel => sel === '#iondvPopupCloseBtn' ? ok : null, remove() { dom.popup = null } }
    log.push(`${name} report shown`)
  })
  // the strategy parameters window: Skip&Run resolves with settings, Cancel with null (ui.showAndUpdateStrategyParameters)
  const showParamWindow = name => new Promise(resolve => {
    const cancel = { onclick: () => { dom.paramWindow = null; resolve(null) }, click() { this.onclick() } }
    const run = { onclick: () => { dom.paramWindow = null; resolve({ cycles: 3 }) }, click() { this.onclick() } }
    dom.paramWindow = { querySelector: sel => sel === '#stratParamCancel' ? cancel : sel === '#stratParamDefRun' ? run : null, remove() { dom.paramWindow = null } }
    log.push(`${name} parameters window shown`)
  })
  const gates = {}
  const started = {}
  for (const name of ['A', 'B', 'C', 'P']) {
    started[name] = new Promise(resolve => { gates[name] = { started: resolve } })
    gates[name].done = new Promise(resolve => { gates[name].finish = resolve })
  }
  action.testStrategy = async request => {
    const name = request.name
    log.push(`${name} started with workerStatus ${action.workerStatus}`)
    dom.statusOwner = name
    gates[name].started()
    if (name === 'A') {
      await showReport('A')
      log.push('A report closed')
    } else if (name === 'P') {
      const settings = await showParamWindow('P')
      log.push(settings ? 'P ran with its own start inputs' : 'P cancelled at its parameters window')
    } else {
      await gates[name].done
    }
  }
  const start = name => listener({ action: 'testStrategy', name }, {}, () => {})
  return { action, dom, log, start, started, gates }
}

test('a stopped run waiting on its report finishes before the next run starts', async () => {
  const t = tab()
  const a = t.start('A')
  await t.started.A
  t.action.workerStatus = null // Stop while A's report is open

  const b = t.start('B')
  await t.started.B
  assert.equal(t.dom.popup, null)
  assert.equal(t.action.workerStatus, 'testStrategy')
  assert.equal(t.dom.statusOwner, 'B')
  assert.deepEqual(t.log, [
    'A started with workerStatus testStrategy',
    'A report shown',
    'A report closed',
    'status removed (owner A)',
    'B started with workerStatus testStrategy'
  ])
  await a
  assert.equal(t.action.workerStatus, 'testStrategy', 'A must not clear B\'s busy flag')
  assert.equal(t.dom.statusOwner, 'B', 'A must not remove B\'s status box')

  t.gates.B.finish()
  await b
  assert.equal(t.action.workerStatus, null)
  assert.equal(t.action._unfinishedWork.size, 0)
})

test('two starts waiting on the same stopped run: only one proceeds', async () => {
  const t = tab()
  t.start('A')
  await t.started.A
  t.action.workerStatus = null
  const b = t.start('B')
  const c = t.start('C')
  await Promise.race([t.started.B, t.started.C])
  await new Promise(r => setTimeout(r, 20))
  const ran = t.log.filter(line => / started with /.test(line) && !line.startsWith('A'))
  assert.equal(ran.length, 1)
  assert.equal(t.log.filter(line => line.startsWith('refused')).length, 1)
  t.gates.B.finish()
  t.gates.C.finish()
  await Promise.all([b, c])
  assert.equal(t.action.workerStatus, null)
})

test('a start with nothing pending closes a leftover popup and runs at once', async () => {
  const t = tab()
  let closed = false
  t.dom.popup = { querySelector: sel => sel === '#iondvPopupCloseBtn' ? { click: () => { closed = true; t.dom.popup = null } } : null }
  const b = t.start('B')
  await t.started.B
  assert.equal(closed, true)
  assert.equal(t.action.workerStatus, 'testStrategy')
  t.gates.B.finish()
  await b
})

// A start that awaits between waiting and claiming (the test harness reads storage there) can still be waiting while
// another start claims the tab. That run is not leftover work: the waiting start must stop, and leave its popup open.
test('waiting covers only work unfinished when it began, and stops once another start claims the tab', async () => {
  const t = tab()
  const finishA = t.action.beginWork() // a stopped run still waiting on its report
  const waiting = t.action.finishPreviousWork()
  t.action.workerStatus = 'testStrategy' // another start claims the tab and opens a popup
  t.action.beginWork()
  let closed = false
  t.dom.popup = { querySelector: sel => sel === '#iondvPopupCloseBtn' ? { click: () => { closed = true } } : null }
  finishA()
  const ended = await Promise.race([waiting.then(() => true), new Promise(r => setTimeout(() => r(false), 200))])
  assert.equal(ended, true, 'must not wait for the run that started meanwhile')
  assert.equal(closed, false, "must not close that run's popup")
})

// A run stopped while its parameters window is open keeps waiting there. The next start must cancel that window and let
// the run end first; otherwise it waits forever, or (the test harness looks for the window by its id) the old window's
// Skip&Run restarts the stopped run with the inputs it read before the newer import.
test('a run stopped at its parameters window is cancelled by the next start, which then runs', async () => {
  const t = tab()
  const p = t.start('P')
  await t.started.P
  t.action.workerStatus = null // Stop while P's parameters window is open
  const b = t.start('B')
  const started = await Promise.race([t.started.B.then(() => true), new Promise(r => setTimeout(() => r(false), 200))])
  assert.equal(started, true, 'the next start must not wait forever')
  assert.equal(t.dom.paramWindow, null)
  assert.deepEqual(t.log, [
    'P started with workerStatus testStrategy',
    'P parameters window shown',
    'P cancelled at its parameters window',
    'status removed (owner P)',
    'B started with workerStatus testStrategy'
  ])
  await p
  assert.equal(t.action.workerStatus, 'testStrategy')
  t.gates.B.finish()
  await b
})
