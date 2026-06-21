const ui = {
  isMsgShown: false,
  // shared single-flight state for injected import/export controls
  importExportBusy: false
}

const scriptFonts = document.createElement('style')
scriptFonts.innerHTML = '@font-face {' +
  '    font-family: "Font Awesome 5 Free";' +
  '    font-style: normal;\n' +
  '    font-weight: 900;' +
  '    font-display: block;' +
  `    src: url(${chrome.runtime.getURL('fonts/fa-solid-900.woff2')}) format('woff2');` +
  '}\n' +
  '.iondv_icon::before {\n' +
  '    display: inline-block;\n' +
  '    font-style: normal;\n' +
  '    font-variant: normal;\n' +
  '    text-rendering: auto;\n' +
  '    -webkit-font-smoothing: antialiased;\n' +
  '  }\n' +
  '.iondv_download::before {\n' +
  '    font-family: "Font Awesome 5 Free"; font-weight: 900; font-size: 1.25em; content: "\\f56d";\n' +
  '  }\n' +
  '.iondv_upload::before {\n' +
  '    font-family: "Font Awesome 5 Free"; font-weight: 900; font-size: 1.25em; content: "\\f574";\n' +
  '  }\n' +
  '.iondv_copy::before {\n' +
  '    font-family: "Font Awesome 5 Free"; font-weight: 900; font-size: 1.25em; content: "\\f0c5";\n' +
  '  }\n'
document.documentElement.appendChild(scriptFonts)

ui.checkInjectedElements = () => {
  if (action && !action.workerStatus) { // If there is not running process
    const strategyDefaultEl = document.querySelector(SEL.strategyDefaultElement)
    if (!strategyDefaultEl)
      return

    // idempotent injection: get-or-create container, normalize style even on existing container, then patch missing buttons individually
	    // give injected controls stable button layout with visible CSV/JSON labels to avoid upload-icon ambiguity
	    const containerStyle = 'padding-left: 10px;padding-right: 10px; padding-top: 8px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;'
	    const buttonStyle = 'cursor:pointer;border:1px solid #9ca3af;border-radius:4px;padding:3px 7px;background:#ffffff;color:#111827;font-size:12px;line-height:16px;font-family:Arial,sans-serif;text-decoration:none;'
	    let importExportEl = document.querySelector(SEL.strategyImportExport)
    if (!importExportEl) {
      importExportEl = document.createElement('div')
      importExportEl.id = 'iondvImportExport'
      importExportEl.setAttribute('style', containerStyle)
      strategyDefaultEl.after(importExportEl)
    } else {
      // Normalize existing container style so hard buttons lay out inline alongside old buttons
      importExportEl.setAttribute('style', containerStyle)
    }

    // Old CSV import button
	    if (!document.getElementById('iondvImport')) {
	      const a = document.createElement('a')
	      a.id = 'iondvImport'
	      a.setAttribute('href', '#')
	      a.setAttribute('style', buttonStyle)
	      a.setAttribute('title', 'Import strategy Inputs (CSV)')
	      a.textContent = 'CSV Import'
	      importExportEl.appendChild(a)
	    }
    // Old CSV export button
	    if (!document.getElementById('iondvExport')) {
	      const a = document.createElement('a')
	      a.id = 'iondvExport'
	      a.setAttribute('href', '#')
	      a.setAttribute('style', buttonStyle)
	      a.setAttribute('title', 'Export strategy Inputs (CSV)')
	      a.textContent = 'CSV Export'
	      importExportEl.appendChild(a)
	    }
    // the Hard JSON Import/Export UI buttons were removed (redundant — the auto-best winner CSV already embeds the same run context, and its upload-restore is a superset of hard import). The backend action.hardExport/hardImport (+ the shared _setHard*Verified helpers used by the CSV restore path) are intentionally kept, just unreachable from the UI by design.

    // wire import/export buttons idempotently with event isolation and a worker-safe busy guard
    const setImportExportDisabled = (isDisabled) => {
	      importExportEl.setAttribute('aria-busy', isDisabled ? 'true' : 'false')
	      for (const btn of importExportEl.querySelectorAll('a')) {
	        btn.setAttribute('aria-disabled', isDisabled ? 'true' : 'false')
	        btn.style.pointerEvents = isDisabled ? 'none' : ''
	        btn.style.opacity = isDisabled ? '0.55' : ''
	      }
	    }
	    const runImportExportAction = async (event, actionName, fn) => {
	      if (event) {
	        event.preventDefault()
	        event.stopPropagation()
	        if (typeof event.stopImmediatePropagation === 'function')
	          event.stopImmediatePropagation()
	      }
	      if (ui.importExportBusy || action.workerStatus)
	        return
	      ui.importExportBusy = true
	      action.workerStatus = actionName
	      setImportExportDisabled(true)
	      try {
	        console.log('[TV-ASS] import/export click', {
	          actionName,
	          detail: event ? event.detail : null,
	          timeStamp: event ? event.timeStamp : null,
	          targetId: event && event.target ? event.target.id : null,
	          currentTargetId: event && event.currentTarget ? event.currentTarget.id : null
	        })
	        await fn()
	      } finally {
	        if (action.workerStatus === actionName)
	          action.workerStatus = null
	        ui.importExportBusy = false
	        setImportExportDisabled(false)
	      }
	    }
	    const bindImportExportButton = (btn, actionName, fn) => {
	      if (!btn || btn.dataset.iondvClickBound)
	        return
	      btn.onclick = null
	      btn.dataset.iondvClickBound = 'true'
	      btn.addEventListener('click', event => runImportExportAction(event, actionName, fn), true)
	    }
	    const exportBtn = document.getElementById('iondvExport')
	    const importBtn = document.getElementById('iondvImport')
	    bindImportExportButton(exportBtn, 'saveParameters', action.saveParameters)
	    bindImportExportButton(importBtn, 'loadParameters', action.loadParameters)

  }
}

ui.stylePopup = `<style>
  .iondvpopup {
    display: table;
    position: relative;
    margin: 40px auto 0;
    width: 500px;
    background-color: #8acaff;
    color: #000000;
    transition: all 0.2s ease;
  }
  .iondvpopup-orange {
    background-color: #ffdeb1;
  }
  .iondvpopup-red {
    background-color: #fab5af;
  }
  .iondvpopup-green {
    background-color: #aefdd7;
  }
  .iondvpopup-icon {
    display: table-cell;
    vertical-align: middle;
    width: 40px;
    padding: 20px;
    text-align: center;
    background-color: rgba(0, 0, 0, 0.25);
  }
  .iondvpopup-header {
    display: table-caption;
    vertical-align: middle;
    width: 500px;
    padding: 5px 0;
    text-align: center;
    background-color: {headerBgColor};
  }
  .iondvpopup-body {
    display: table-cell;
    vertical-align: middle;
    padding: 20px 20px 20px 10px;
  }
  .iondvpopup-body > p {
      line-height: 1.35;
      margin-top: 6px;
      /* render the newline section separators that file._applyParamsOnly emits (applied / fallback / failed-missing) as real line breaks; wrap long parameter-name lists inside the 500px popup. CSS-only, plain text — no HTML around untrusted parameter names. */
      white-space: pre-line;
      word-break: break-word;
    }
  .iondvpopup-button {
    position: relative;
    margin: 15px 5px -10px;
    background-color: rgba(0, 0, 0, 0.25);
    box-shadow: 0 3px rgba(0, 0, 0, 0.4);
    border:none;
    padding: 10px 15px;
    font-size: 16px;
    font-family: 'Source Sans Pro';
    color: #000000;
    outline: none;
    cursor: pointer;
  }
  .iondvpopup-button:hover {
      background: rgba(0, 0, 0, 0.3);
  }
  .iondvpopup-button:active {
      background: rgba(0, 0, 0, 0.3);
      box-shadow: 0 0 rgba(0, 0, 0, 0.4);
      top: 3px;
  }
  .iondvpopup-sub {
    font-style: italic;
  }
</style>`
ui.styleValWindowShadow = `background-color:rgba(0, 0, 0, 0.2);
position:absolute;
width:100%;
height:100%;
top:0px;
left:0px;
z-index:10000;`

ui.alertPopup =  async (msgText, isError = null, isConfirm = false) => {
  return new Promise(resolve => {
    function removeAlertPopup () {
      const iondvAlertPopupEl = document.getElementById('iondvAlertPopup')
      if (iondvAlertPopupEl)
        iondvAlertPopupEl.parentNode.removeChild(iondvAlertPopupEl)
      return resolve(true)
    }

    function cancelAlertPopup () {
      const iondvAlertPopupEl = document.getElementById('iondvAlertPopup')
      if (iondvAlertPopupEl)
        iondvAlertPopupEl.parentNode.removeChild(iondvAlertPopupEl)
      return resolve(false)
    }

    if (document.getElementById('iondvAlertPopup'))
      return resolve()

    const mObj = document.getElementsByTagName('body')[0].appendChild(document.createElement('div'))
    mObj.id = 'iondvAlertPopup'
    mObj.setAttribute('style', ui.styleValWindowShadow)
    mObj.style.height = document.documentElement.scrollHeight + 'px'
    const warnIcon = '<svg xmlns="http://www.w3.org/2000/svg"  width="40px" height="40px" viewBox="0 0 40 40" stroke-width="3" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><circle cx="20" cy="20" r="18"></circle><line x1="20" y1="12" x2="20" y2="22"></line><line x1="20" y1="27" x2="20" y2="28"></line></svg>'
    const errorIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="40px" height="40px" viewBox="0 0 40 40" stroke-width="3" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"></path><rect x="4" y="4" width="34" height="34" rx="2"></rect><path d="M14 14l14 14m0 -14l-14 14"></path></svg>'
    const okIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="40px" height="40px" viewBox="0 0 40 40" stroke-width="3" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h40v40H0z" fill="none"></path><path d="M5 20l12 12l22 -20"></path></svg>'
    const icon = isError === null ? okIcon : isError ? errorIcon : warnIcon
    const headerText = isError === null ? 'Information' : isError ? 'Error' : 'Warning'
    const bgColorClass = isError === null ? 'iondvpopup-green' : isError ? 'iondvpopup-red' : 'iondvpopup-orange'
    const headerBgColor = isError === null ? '#80ffad' : isError ? '#ff9286' : '#fdc987'
    mObj.innerHTML = ui.stylePopup.replaceAll('{bgColorClass}', bgColorClass) + `
<div class="iondvpopup ${bgColorClass}">
    <div class="iondvpopup-header">${headerText}</div>
    <div class="display: table-row">
      <div class="iondvpopup-icon">
        ${icon}
      </div>
      <div class="iondvpopup-body">
        <p>${msgText}</p>
        <button class="iondvpopup-button" id="iondvPopupCloseBtn">OK</button>
        ${isConfirm ? '<button class="iondvpopup-button" id="iondvPopupCancelBtn">Cancel</button>' : ''}
      </div>
    </div>
</div>`
    const btnOk = document.getElementById('iondvPopupCloseBtn')
    if (btnOk) {
      btnOk.focus()
      btnOk.onclick = removeAlertPopup
    }
    const btnCancel = document.getElementById('iondvPopupCancelBtn')
    if (btnCancel) {
      btnCancel.onclick = cancelAlertPopup
    }
  })
}

ui.showPopup = async (msgText) => {
  return await ui.alertPopup(msgText, null)
}

ui.showErrorPopup = async (msgText) => {
  return await ui.alertPopup(msgText, true)
}

ui.showWarningPopup = async (msgText) => {
  return await ui.alertPopup(msgText, false)
}

ui.statusMessageRemove = () => {
  const statusMessageEl = document.getElementById('iondvStatus')
  if (statusMessageEl)
    statusMessageEl.parentNode.removeChild(statusMessageEl)
}

ui.autoCloseAlert = (msg, duration = 3000) => {
  const altEl = document.createElement('div')
  altEl.setAttribute('style', 'background-color: #ffeaa7;color:black; width: 350px;height: 200px;position: absolute;top:0;bottom:0;left:0;right:0;margin:auto;border: 1px solid black;font-family:arial;font-size:15px;font-weight:bold;display: flex; align-items: center; justify-content: center; text-align: center;')
  altEl.setAttribute('id', 'iondvAlertAutoClose')
  altEl.innerHTML = msg
  setTimeout(function () {
    altEl.parentNode.removeChild(altEl)
  }, duration)
  document.body.appendChild(altEl)
}


ui.styleValStausMessage = `
.button {
    background-color: white;
    border: none;
    color: white;
    padding: 10px 2px;
    text-align: center;
    text-decoration: none;
    font-size: 14px;
    margin-top:-10px;
    margin-right:-0px;
    -webkit-transition-duration: 0.4s; /* Safari */
    transition-duration: 0.4s;
    cursor: pointer;
    width: 50px;
    float: right;
    border-radius: 3px;
    display: inline-block;
    line-height: 0;
}
.button-close:hover {
    background-color: gray;
    color: white;
}
.button-close {
    background-color: white;
    color: black;
    border: 2px solid gray;
}`


ui.styleValStatusMessage = `background-color: #fffde0; color: black;
      width: 800px; height: 260px; position: fixed;       top: 50px;     right: 0;    left: 0;
      margin: auto;       border: 1px solid lightblue;       box-shadow: 3px 3px 7px #777;
      align-items: center;       justify-content: left;       text-align: left;`
// running status box is a plain fixed height (260px) so the apply line + the cycle stats both fit without spilling


ui.statusMessage = (msgText, extraHeader = null) => {
  const isStatusPresent = document.getElementById('iondvStatus')
  const mObj = isStatusPresent ? document.getElementById('iondvStatus') : document.createElement('div')
  let msgEl
  if (!isStatusPresent) {
    mObj.id = 'iondvStatus'
    mObj.setAttribute('style', ui.styleValWindowShadow)
    mObj.style.height = document.documentElement.scrollHeight + 'px'
    const msgStyleEl = mObj.appendChild(document.createElement('style'))
    msgStyleEl.innerHTML = ui.styleValStausMessage
    msgEl = mObj.appendChild(document.createElement('div'))
    msgEl.setAttribute('style', ui.styleValStatusMessage)
  } else {
    msgEl = mObj.querySelector('div')
  }
  if (isStatusPresent && msgEl && document.getElementById('iondvMsg') && !extraHeader) {
    document.getElementById('iondvMsg').innerHTML = msgText
  } else {
    extraHeader = extraHeader !== null ? `<div style="font-size: 12px;margin-left: 5px;margin-right: 5px;text-align: left;">${extraHeader}</div>` : '' //;margin-bottom: 10px
    // dedicated, persistent #iondvApplyLine region before #iondvMsg: ui.statusApplyLine() writes the "Applying N settings…" line here so it coexists with the per-cycle stats in #iondvMsg instead of overwriting them. Empty by default; the per-cycle replace-path never touches it.
    msgEl.innerHTML = '<button class="button button-close" id="iondvBoxClose">stop</button>' +
      '<div style="color: blue;font-size: 26px;margin: 5px 5px;text-align: center;">Attention!</div>' +
      '<div style="font-size: 18px;margin-left: 5px;margin-right: 5px;text-align: center;">The page elements are controlled by the browser extension. Please do not click on the page elements.You can reload the page and the results for the last iteration will be saved.</div>' +
      extraHeader +
      '<div id="iondvApplyLine" style="margin: 5px 10px; font-style: italic;"></div>' +
      '<div id="iondvMsg" style="margin: 5px 10px">' +
      msgText + '</div>'
  }
  if (!isStatusPresent) {
    const tvDialog = document.getElementById('overlap-manager-root')
    if (tvDialog)
      document.body.insertBefore(mObj, tvDialog) // For avoid problem if msg overlap tv dialog window
    else
      document.body.appendChild(mObj)
  }
  const btnClose = document.getElementById('iondvBoxClose')
  if (btnClose) {
    btnClose.onclick = () => {
      console.log('Stop clicked')
      action.workerStatus = null
    }
  }
}

// dedicated updater for the #iondvApplyLine region so the "Applying/Applied N settings" line coexists with the per-cycle stats in #iondvMsg. Falsy/empty text clears the line; it is also auto-removed with the whole #iondvStatus box by ui.statusMessageRemove. No-op when the running status box is absent, so one-off imports/autosave never spawn the box. If the box exists but the region is missing (older DOM), it is created just before #iondvMsg.
ui.statusApplyLine = (text) => {
  try {
    if (!document.getElementById('iondvStatus'))
      return
    let lineEl = document.getElementById('iondvApplyLine')
    if (!lineEl) {
      const msgEl = document.getElementById('iondvMsg')
      if (!msgEl || !msgEl.parentNode)
        return
      lineEl = document.createElement('div')
      lineEl.id = 'iondvApplyLine'
      lineEl.setAttribute('style', 'margin: 5px 10px; font-style: italic;')
      msgEl.parentNode.insertBefore(lineEl, msgEl)
    }
    // build the line via a DOM text node, never interpolated innerHTML: `text` carries untrusted strategy/input titles, so textContent renders them literally and safely (innerHTML could corrupt the box or inject markup).
    while (lineEl.firstChild)
      lineEl.removeChild(lineEl.firstChild)
    if (text) {
      const p = document.createElement('p')
      p.textContent = text
      lineEl.appendChild(p)
    }
  } catch {}
}

ui.styleParamWindow = `<style>
.iondv-button {
  background-color: white;
  border: 1px;
  color: black;
  padding: 10px 10px;
  text-align: center;
  text-decoration: none;
  font-size: 14px;
  -webkit-transition-duration: 0.4s; /* Safari */
  transition-duration: 0.4s;
  cursor: pointer;
  width: 75px;      
  border-radius: 3px;
  line-height: 0;
}
.iondv-button-close:hover {
  background-color: gray;
  color: white;
}
.iondv-button-close {
  background-color: white;
  color: black;
  border: 2px solid gray;
}
.iondv-button-run:hover {
  background-color: lightgreen;
}
.iondv-button-run {
  background-color: white;
  border: 2px solid lightgreen;
}
.iondv-button-def:hover {
  background-color: skyblue;
}
.iondv-button-def {
  background-color: white;
  border: 2px solid skyblue;
}
table.stratParamTable {
    width: 100%;
     border-collapse: collapse;
    border: 2px solid grey;
    empty-cells: show;
    table-layout: fixed;
}
.stratParamTable thead {
    caption-side: bottom;
   text-align: center;
   padding: 5px 0;
   font-size: 100%;
}
.stratParamTable td {
   border: 1px solid grey;
    font-size: 90%;
    padding: 2px 2px;
}
</style>`

ui.styleValParamWindow = `background-color: white; color: black;
width: 800px; height: 800px; position: fixed; top: 50px; right: 0; left: 0;
margin: auto; border: 1px solid lightblue; box-shadow: 3px 3px 7px #777;
align-items: center;  justify-content: left; text-align: left;`

ui.showAndUpdateStrategyParameters = async (testParams) => {
  return new Promise(resolve => {
    function updateParamsAndSpace() {
      const allRange = {}
      let space = null
      const rowsContainer = document.getElementById('stratParamData')
      if (rowsContainer) {
        const allFiltersRows = rowsContainer.getElementsByTagName('tr')
        if (allFiltersRows) {
          for (let row of allFiltersRows) {
            const cells = row.getElementsByTagName('td')
            if (!cells || cells.length !== 7)
              continue
            const activeCheckbox = cells[0].querySelector('input')
            const nameCell = cells[1]
            const fromInput = cells[2].querySelector('input')
            const toInput = cells[3].querySelector('input')
            const stepInput = cells[4].querySelector('input')
            const defaultInput = cells[5].querySelector('input')
            const priorityInput = cells[6].querySelector('input')
            if (!activeCheckbox || !nameCell || !nameCell.innerText || !fromInput || !toInput || !stepInput || !defaultInput || !priorityInput)
              continue
            try {
              const key = nameCell.innerText
              const isActive = Boolean(activeCheckbox.checked)
              const priorityParsed = parseInt(priorityInput.value)
              const priority = Number.isNaN(priorityParsed) ? priorityInput.value : priorityParsed
              const sourceRange = testParams.paramRangeSrc && testParams.paramRangeSrc[key] ? testParams.paramRangeSrc[key] :
                (testParams.paramRange && testParams.paramRange[key] ? testParams.paramRange[key] : null)
              if (!sourceRange || sourceRange.length < 5)
                continue
              let entry = null
              let paramSpace = 1
              if (typeof sourceRange[0] === 'boolean' && typeof sourceRange[1] === 'boolean') {
                const defVal = defaultInput.value.toString().toLowerCase() === 'true'
                entry = [true, false, 0, defVal, priority, isActive]
                paramSpace = 2
              } else if (typeof sourceRange[0] === 'string' && sourceRange[0].includes(';')) {
                const fromValue = fromInput.value
                const defaultVal = fromValue.split(';')[0]
                entry = [fromValue, '', 0, defaultVal, priority, isActive]
                const variants = fromValue.split(';').filter(item => item)
                paramSpace = variants.length ? variants.length : 1
              } else {
                let isInteger = sourceRange[0] === Math.round(sourceRange[0]) &&
                  sourceRange[1] === Math.round(sourceRange[1]) &&
                  sourceRange[2] === Math.round(sourceRange[2])
                if (!Number.isNaN(Number(fromInput.value))) {
                  if (parseInt(fromInput.value) !== Number(fromInput.value) ||
                    (Number(toInput.value) && parseInt(toInput.value) !== Number(toInput.value)) ||
                    (Number(stepInput.value) && parseInt(stepInput.value) !== Number(stepInput.value)))
                    isInteger = false
                  const fromVal = isInteger ? parseInt(fromInput.value) : Number(fromInput.value)
                  const rawToVal = Number(toInput.value)
                  const toVal = Number.isFinite(rawToVal) ? rawToVal : fromVal
                  let step = isInteger ? parseInt(stepInput.value) : Number(stepInput.value)
                  if (!Number.isFinite(step))
                    step = toVal < fromVal ? -1 : 1
                  step = step !== 0 ? step : toVal < fromVal ? -1 : 1
                  const rawDefVal = isInteger ? parseInt(defaultInput.value) : Number(defaultInput.value)
                  const defVal = Number.isFinite(rawDefVal) ? rawDefVal : (isInteger ? fromVal : fromVal)
                  entry = [fromVal, toVal, step, defVal, priority, isActive]
                  const diff = Math.abs(fromVal - toVal)
                  paramSpace = step !== 0 ? Math.floor(diff / Math.abs(step)) + 1 : 1
                  if (!Number.isFinite(paramSpace) || paramSpace <= 0)
                    paramSpace = 1
                } else {
                  const fromValue = fromInput.value
                  entry = [fromValue, '', 0, fromValue, priority, isActive]
                  paramSpace = 1
                }
              }
              if (entry)
                allRange[key] = entry
              if (isActive && entry) {
                paramSpace = paramSpace || 1
                space = space == null ? paramSpace : space * paramSpace
              }
            } catch (err) {
              console.error('updateParamsAndSpace error', err)
            }
          }
        }
      }
      const cyclesEl = document.getElementById('cyclesAll')
      if (cyclesEl)
        cyclesEl.innerHTML = String(space !== null ? space : 0)
      return { allRange, activeSpace: space }
    }


    function prepareRow(name, param, isActive) {
      const isBoolean = typeof param[0] === 'boolean'
      return `<td><input type="checkbox" ${isActive ? 'checked' : ''} style="width:1em; background-color : #f1f1f1;" name="iondv-active-check-box"></td><td>${name}</td>
              <td><input type="text" value="${isBoolean ? 'true' : param[0]}" style="width:4em; ${!isBoolean ? 'background-color :#f1f1f1;' : ''}" ${isBoolean ? 'disabled' : ''}></td>
              <td><input type="text" value="${isBoolean ? 'false' : param[1]}" style="width:4em; ${!isBoolean ? 'background-color :#f1f1f1;' : ''}" ${isBoolean ? 'disabled' : ''}></td>
              <td><input type="number" step="any" value="${param[2]}" style="width:4em; ${!isBoolean ? 'background-color :#f1f1f1;' : ''}" ${isBoolean ? 'disabled' : ''}></td>
              <td><input type="text" value="${param[3]}" style="width:4em; background-color : #f1f1f1;"></td>
              <td><input type="number" value="${param[4]}" style="width:4em; background-color : #f1f1f1;"></td>`
    }

    function removeParamWindow() {
      const stratParamWindowEl = document.getElementById('iondvStratParam')
      if (stratParamWindowEl)
        stratParamWindowEl.parentNode.removeChild(stratParamWindowEl)
    }

    function getCycles() {
      try {
        const cyclesEl = document.getElementById('stratParamCycles')
        return cyclesEl && cyclesEl.value ? parseInt(cyclesEl.value) : 100
      } catch {}
      return 100
    }

    function ensureParamRangeSrcCoverage() {
      if (!testParams.paramRangeSrc)
        testParams.paramRangeSrc = {}
      if (!testParams.paramRange)
        testParams.paramRange = {}
      Object.keys(testParams.paramRange).forEach(key => {
        if (!testParams.paramRangeSrc.hasOwnProperty(key)) {
          const stored = testParams.paramRange[key]
          if (stored && stored.length >= 5)
            testParams.paramRangeSrc[key] = stored.slice(0, 5)
        }
      })
    }

    function renderParamRows() {
      ensureParamRangeSrcCoverage()
      if (!testParams.allowedKeys || !testParams.allowedKeys.length)
        testParams.allowedKeys = Object.keys(testParams.paramRangeSrc || {})
      const tbody = document.getElementById('stratParamData')
      if (!tbody)
        return

      const activeRows = []
      const inactiveRows = []
      const processedParams = new Set()

      Object.keys(testParams.paramRange).forEach(name => {
        if (!Object.prototype.hasOwnProperty.call(testParams.paramRange, name))
          return
        if (testParams.allowedKeys && testParams.allowedKeys.length && !testParams.allowedKeys.includes(name))
          return
        const entry = testParams.paramRange[name]
        if (!entry || entry.length < 5)
          return
        const normalized = entry.slice(0, 5)
        const isActive = entry.length > 5 ? Boolean(entry[5]) : true
        processedParams.add(name)
        ;(isActive ? activeRows : inactiveRows).push({ name, data: normalized, isActive })
      })

      Object.keys(testParams.paramRangeSrc).forEach(name => {
        if (!Object.prototype.hasOwnProperty.call(testParams.paramRangeSrc, name) || processedParams.has(name))
          return
        if (testParams.allowedKeys && testParams.allowedKeys.length && !testParams.allowedKeys.includes(name))
          return
        const entry = testParams.paramRangeSrc[name]
        if (!entry || entry.length < 5)
          return
        activeRows.push({ name, data: entry.slice(0, 5), isActive: true })
      })

      let paramRows = ''
      activeRows.concat(inactiveRows).forEach(item => {
        paramRows += `\n<tr>${prepareRow(item.name, item.data, item.isActive)}</tr>`
      })
      tbody.innerHTML = paramRows
    }

    try{
      const isStratParamElPresent = document.getElementById('iondvStratParam')
      let stratParamEl = isStratParamElPresent ? document.getElementById('iondvStratParam') : document.createElement('div')
      let popupEl
      if (!isStratParamElPresent) {
        stratParamEl.id = 'iondvStratParam'
        stratParamEl.setAttribute('style', ui.styleValWindowShadow)
        stratParamEl.style.height = document.documentElement.scrollHeight + 'px'
        const stratParamStyleEl = stratParamEl.appendChild(document.createElement('style'))
        stratParamStyleEl.innerHTML = ui.styleParamWindow
        popupEl = stratParamEl.appendChild(document.createElement('div'))
        popupEl.setAttribute('style', ui.styleValParamWindow )
      } else {
        popupEl = stratParamEl.querySelector('div')
      }
      popupEl.innerHTML = `<div style="height: 150px; overflow-y: hidden; vertical-align:top;">
  <h1 style="padding: 25px">Strategy parameters</h1>
  <div style="align-content: center"><span style="padding:5px 15px">
  Cycles <input id="stratParamCycles" type="number" value="10" style="width:8em; background-color :#f1f1f1;"> 
  <a id="iondvCycleCopy" style="cursor: pointer;padding-right: 5px"><i class="iondv_icon iondv_copy"></i></a>
  from ~<span id="cyclesAll">100</span></span>
  <span style="padding:5px 10px 5px 0">
    <a id="iondvParamUpload" style="cursor: pointer;padding-right: 5px" title="Upload parameters from CSV"><i class="iondv_icon iondv_upload"></i></a>
    <a id="iondvParamDownload" style="cursor: pointer;" title="Download current parameters"><i class="iondv_icon iondv_download"></i></a>
  </span>
  <button id="stratParamSaveRun" class="iondv-button iondv-button-run">Save&Run</button>
  <button id="stratParamDefRun" class="iondv-button iondv-button-def">Skip&Run</button>
  <button id="stratParamCancel" class="iondv-button iondv-button-close">Cancel</button>
  </div>
  </div>
  <div style="height: 640px; overflow-y: auto; vertical-align:top;">
  <table class="stratParamTable">
   <thead><td style="width: 10%"><input type="checkbox" id="iondvCheckAll" style="width:1em;background-color :#f1f1f1;">Active</td><td style="width: 40%">Parameter</td><td>From</td><td>To</td><td>Step</td><td>Default</td><td>Priority</td></thead>
   <tbody id="stratParamData"></tbody>
  </table></div>`
      if (!isStratParamElPresent) {
        const tvDialog = document.getElementById('overlap-manager-root')
        if (tvDialog)
          document.body.insertBefore(stratParamEl, tvDialog) // For avoid problem if msg overlap tv dialog window
        else
          document.body.appendChild(stratParamEl)
      }
      const tbody = document.getElementById('stratParamData')

      renderParamRows()

      const initialState = updateParamsAndSpace()
      if (initialState && initialState.allRange)
        testParams.paramRange = initialState.allRange
      if (tbody)
        tbody.addEventListener('change', () => {
          const state = updateParamsAndSpace()
          if (state && state.allRange)
            testParams.paramRange = state.allRange
        })
      const copyCycleBtn = document.getElementById('iondvCycleCopy')
      if (copyCycleBtn) {
        copyCycleBtn.onclick = async () => {
          const cylceEl = document.getElementById('stratParamCycles')
          const cyclesAllEl = document.getElementById('cyclesAll')
          if(cylceEl)
            cylceEl.value = isNaN(parseInt(cyclesAllEl.innerText)) ? 10 : parseInt(cyclesAllEl.innerText)
        }
      }
      const downloadBtn = document.getElementById('iondvParamDownload')
      if (downloadBtn) {
        downloadBtn.onclick = async () => {
          const state = updateParamsAndSpace()
          if (!state || !state.allRange || !Object.keys(state.allRange).length) {
            await ui.showWarningPopup('There are no parameters to export yet.')
            return
          }
          testParams.paramRange = state.allRange
          const csvData = model.convertStrategyRangeToTemplate(state.allRange)
          const strategyName = testParams.strategyName ? testParams.strategyName : 'strategy'
          file.saveAs(csvData, `${strategyName} strategy parameters.csv`)
        }
      }
      const uploadBtn = document.getElementById('iondvParamUpload')
      if (uploadBtn) {
        uploadBtn.onclick = async () => {
          await file.upload(async (fileData) => {
            const allowedKeys = testParams.allowedKeys && testParams.allowedKeys.length ? testParams.allowedKeys : Object.keys(testParams.paramRangeSrc || {})
            const baseRange = testParams.paramRangeSrc || {}
            const msg = await model.parseStrategyParamsAndGetMsg(fileData, allowedKeys, baseRange)
            if (msg && msg.includes('Upload canceled'))
              return msg
            const newParamRange = await storage.getKey(storage.STRATEGY_KEY_PARAM)
            if (newParamRange && typeof newParamRange === 'object') {
              const filtered = model.filterRangeByAllowedKeys(newParamRange, allowedKeys)
              testParams.paramRange = filtered.filteredRange
              renderParamRows()
              const state = updateParamsAndSpace()
              if (state && state.allRange)
                testParams.paramRange = state.allRange
            }
            return msg
          }, '', false)
        }
      }
      const checkAllEl = document.getElementById('iondvCheckAll')
      if (checkAllEl) {
        checkAllEl.onchange = () => {
          const allCheckbox = document.getElementById('iondvCheckAll')
          const checkAllEl = document.querySelectorAll('[name="iondv-active-check-box"]')
          if(checkAllEl && allCheckbox) {
            for(const el of checkAllEl) {
              el.checked = allCheckbox.checked
            }
            const state = updateParamsAndSpace()
            if (state && state.allRange)
              testParams.paramRange = state.allRange
          }
        }
      }
      const btnClose = document.getElementById('stratParamCancel')
      if (btnClose) {
        btnClose.onclick = () => {
          console.log('Cancel')
          removeParamWindow()
          return resolve(null)
        }
      }
      const btnSaveRun = document.getElementById('stratParamSaveRun')
      if (btnSaveRun) {
        btnSaveRun.onclick = () => {
          const state = updateParamsAndSpace()
          const paramRange = state ? state.allRange : null
          if (paramRange)
            testParams.paramRange = paramRange
          console.log('Save and run')
          const cycles = getCycles()
          removeParamWindow()
          return resolve({cycles: cycles, paramRange: paramRange })
        }
      }
      const btnDefRun = document.getElementById('stratParamDefRun')
      if (btnDefRun) {
        btnDefRun.onclick = () => {
          console.log('Run default')
          const cycles = getCycles()
          removeParamWindow()
          return resolve({cycles: cycles, paramRange: null })
        }
      }
    } catch (err) {
      removeParamWindow()
      throw err
    }
  })
}
