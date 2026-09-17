// Service worker behind the content script's waits. The browser clamps a hidden tab's own timers to one tick
// per second, and to one per minute after five minutes in the background, so an optimization slows to a crawl
// as soon as the chart tab is behind another tab or the window is minimized. The worker's timers are not
// clamped, so page.waitForTimeout delegates to it while the tab is hidden (see content_scripts/page.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object')
    return false
  if (Object.prototype.hasOwnProperty.call(msg, 'iondvSleep')) {
    const ms = Math.max(0, Math.min(Number(msg.iondvSleep) || 0, 25000))
    setTimeout(() => sendResponse({ ok: true }), ms)
    return true
  }
  if (msg.iondvKeepTab && sender.tab && typeof sender.tab.id === 'number') {
    // a tab discarded by the browser's memory saver loses the run, so exempt the chart tab for the run's lifetime
    chrome.tabs.update(sender.tab.id, { autoDiscardable: false }, () => {
      void chrome.runtime.lastError
      sendResponse({ ok: true })
    })
    return true
  }
  return false
})
