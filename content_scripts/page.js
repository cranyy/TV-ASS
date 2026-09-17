const page = {
  _inputEvent: new Event('input', { bubbles: true }),
  _changeEvent: new Event('change', { bubbles: true }),
  _mouseEvents: {}
};

["mouseover", "mousedown", "mouseup", "click",
  "dblclick", "contextmenu"].forEach(eventType => {
  page._mouseEvents[eventType] = new MouseEvent(eventType, {
    bubbles: true,
    cancelable: true,
    view: window,
  })
})

const reactValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

page.$ = function (selector) {
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

// Sleep that keeps its pace in a hidden tab. The browser clamps a hidden page's timers to one tick per second,
// and after five minutes in the background to one per minute, which turns the optimizer's many short waits into
// a crawl as soon as the user switches tabs or minimizes the window. The extension's service worker
// (background.js) is not clamped, so a hidden page delegates the wait to it in short chunks; a page timer stays
// armed as a backstop so an unavailable worker can never leave a run hanging, and a worker that cannot be
// reached at all switches the page back to its own timers for good.
page._SLEEP_CHUNK_MS = 20000
page._bridgeAvailable = true
page._bridgeSleep = (ms) => new Promise(resolve => {
  const startedAt = Date.now()
  let done = false
  let backstop = null
  const finish = () => {
    if (done)
      return
    done = true
    if (backstop)
      clearTimeout(backstop)
    resolve()
  }
  backstop = setTimeout(finish, ms + 1500)
  try {
    chrome.runtime.sendMessage({ iondvSleep: ms }, () => {
      if (chrome.runtime.lastError) {
        page._bridgeAvailable = false
        setTimeout(finish, Math.max(0, ms - (Date.now() - startedAt)))
        return
      }
      finish()
    })
  } catch {
    page._bridgeAvailable = false
    setTimeout(finish, Math.max(0, ms - (Date.now() - startedAt)))
  }
})

page.waitForTimeout = async (timeout = 2500) => {
  const ms = Math.max(0, Number(timeout) || 0)
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const bridge = page._bridgeAvailable && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id
  if (hidden && bridge) {
    let left = ms
    do {
      const chunk = Math.min(left, page._SLEEP_CHUNK_MS)
      await page._bridgeSleep(chunk)
      left -= chunk
    } while (left > 0)
    return
  }
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ask the service worker to exempt this tab from automatic discarding for the run
page.keepTabAlive = () => {
  try {
    chrome.runtime.sendMessage({ iondvKeepTab: true }, () => { void chrome.runtime.lastError })
  } catch {
  }
}


page.waitForSelector = async (selector, timeout = 5000, isHide = false, parentEl = null) => {
  return new Promise(async (resolve) => {
    parentEl = parentEl ? parentEl : document
    let iter = 0
    let elem = null
    try {
      elem = parentEl.querySelector(selector)
    } catch {
    }
    const tikTime = timeout === 0 ? 1000 : 50
    while (timeout === 0 || (!isHide && !elem) || (isHide && !!elem)) {
      await page.waitForTimeout(tikTime)
      try {
        elem = parentEl.querySelector(selector)
      } catch {
      }

      iter += 1
      if (timeout !== 0 && tikTime * iter >= timeout)
        break
      // throw new Error(`Timeout ${timeout} waiting for ${isHide ? 'hide ' : '' } ${selector}`) // break
    }
    return resolve(elem ? elem : null)
  })
}


page.getTextForSel = function (selector, elParent) {
  elParent = elParent ? elParent : document
  const element = elParent.querySelector(selector)
  return element ? element.innerText : null
}

page.setInputElementValue = function (element, value, isChange = false) {
  reactValueSetter.call(element, value)
  element.dispatchEvent(page._inputEvent);
  if (isChange)
    element.dispatchEvent(page._changeEvent);
}


page.mouseClick = function (el) {
  ["mouseover", "mousedown", "mouseup", "click"].forEach((eventType) =>
    el.dispatchEvent(page._mouseEvents[eventType])
  )
}

page.mouseDoubleClick = function (el) {
  ["mouseover", "mousedown", "mouseup", "click", "mousedown", "mouseup", "click"].forEach((eventType) =>
    el.dispatchEvent(page._mouseEvents[eventType])
  )
}

page.mouseClickSelector = function (selector) {
  const el = page.$(selector)
  if (el)
    page.mouseClick(el)
}


page.getElText = (element) => {
  return element.innerText.replaceAll('​', '')
}


page.setSelByText = async (selector, textValue) => {
  let isSet = false
  await page.waitForSelector(selector, 1000)
  await page.waitForTimeout(15) // Some times if list quite long, TV is not filled values yet and it generate an error
  let selectorAllVal = document.querySelectorAll(selector)
  if (!selectorAllVal || !selectorAllVal.length)
    return isSet
  for (let optionsEl of selectorAllVal) {
    if (optionsEl) {//&& options.innerText.startsWith(textValue)) {
      let itemValue = page.getElText(optionsEl)
      if (!itemValue) {
        const ariaLabel = optionsEl.getAttribute('aria-label') || optionsEl.getAttribute('data-label') || optionsEl.getAttribute('data-name')
        if (ariaLabel)
          itemValue = ariaLabel
      }
      if (!itemValue && optionsEl.dataset) {
        if (optionsEl.dataset.value)
          itemValue = optionsEl.dataset.value
        else if (optionsEl.dataset.label)
          itemValue = optionsEl.dataset.label
      }
      const normalizedItem = itemValue ? itemValue.trim().toLowerCase() : ''
      const normalizedTarget = textValue ? textValue.trim().toLowerCase() : ''
      if (normalizedItem && normalizedTarget && (normalizedItem === normalizedTarget || normalizedItem.startsWith(normalizedTarget))) {
        // upstream #354 fix: select dropdown option with native .click() (synthetic mouseClick is ignored by TV's pointer-driven option items)
        optionsEl.click()
        await page.waitForSelector(selector, 1000, true)
        isSet = true
        break
      }
      if (!normalizedItem && optionsEl.textContent) {
        const fallback = optionsEl.textContent.trim().toLowerCase()
        if (fallback && normalizedTarget && (fallback === normalizedTarget || fallback.startsWith(normalizedTarget))) {
          // upstream #354 fix: select dropdown option with native .click() (fallback textContent branch)
          optionsEl.click()
          await page.waitForSelector(selector, 1000, true)
          isSet = true
          break
        }
      }
      itemValue = null
    }
  }
  selectorAllVal = null
  return isSet
}
