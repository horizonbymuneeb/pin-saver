/* Popup UI: detects whether the active tab is a board and offers the ZIP
   action. Everything real happens in the content script; this is a shortcut. */

const onBoard = document.getElementById("on-board");
const offBoard = document.getElementById("off-board");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

/**
 * A board URL is /<user>/<slug>/ and not one of Pinterest's app routes.
 * The same rule ships in the content script, so it lives in one place.
 */
function isBoardUrl(url) {
  var pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (_) {
    return false;
  }
  var parts = pathname.split("?")[0].split("/").filter(Boolean);
  if (parts.length < 2) return false;
  var reserved = [
    "pin", "search", "ideas", "settings", "notifications",
    "messages", "explore", "today", "home", "following", "business",
  ];
  return reserved.indexOf(parts[0].toLowerCase()) === -1;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

/** Ask the content script on the page to start the board export. */
async function triggerBoardZip(tab) {
  const response = await chrome.tabs.sendMessage(tab.id, { action: "downloadBoard" }).catch(
    function () {
      return null;
    },
  );
  if (response && response.ok) {
    setStatus("Started — watch the panel on the page");
    window.close();
  } else {
    setStatus("Reload the Pinterest tab once, then try again");
  }
}

async function init() {
  const tab = await activeTab();
  const url = (tab && tab.url) || "";
  const isPinterest = /^https:\/\/([a-z0-9-]+\.)?pinterest\.com\//.test(url);

  if (isPinterest && isBoardUrl(url)) {
    onBoard.hidden = false;
    setStatus("Board detected");
    document
      .getElementById("btn-zip")
      .addEventListener("click", function () {
        triggerBoardZip(tab);
      });
  } else {
    offBoard.hidden = false;
    setStatus(isPinterest ? "Not a board page" : "Not on Pinterest");
    document.getElementById("btn-open").addEventListener("click", function () {
      chrome.tabs.create({ url: "https://www.pinterest.com/" });
    });
  }
}

init();
