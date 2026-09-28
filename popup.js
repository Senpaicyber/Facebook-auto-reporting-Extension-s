// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
// Each step is matched by visible text on screen; a missing step fails the run.
//
// v1.3: dropped the fixed trailing "Next" entry. FB doesn't always put a
// "Next" screen in the same spot -- it can show up between the category and
// sub-type screens, between sub-type and review, after Submit, or not at
// all, and a screen that has one on one run may not on the next. A Next
// button pinned to one fixed position in this list means every OTHER
// position where FB actually shows one gets missed entirely -- which is the
// "skipping the Next button" bug. Instead, waitForStepClickingThroughNext()
// below watches for a "Next" button WHILE it waits for each of these
// targets and clicks through as many as show up, so it no longer matters
// where FB puts them.
const REPORT_FLOW_STEPS = [
  { text: "Report post", avoid: ["report post to group admins"] },
  { text: "Selling or promoting restricted items" },
  { text: "Tobacco" },
  { text: "Submit" },
];

// Adjust these to match whatever you actually have open -- Marketplace
// listing pages and normal post permalinks are both covered. Only used
// when no links are pasted into the textarea.
const TAB_URL_PATTERNS = [
  "*://www.facebook.com/marketplace/item/*",
  "*://facebook.com/marketplace/item/*",
  "*://www.facebook.com/*/posts/*",
  "*://facebook.com/*/posts/*",
  "*://www.facebook.com/permalink.php*",
  "*://facebook.com/permalink.php*",
];

// Matches a real FB post/listing link -- used to validate pasted links so
// obvious junk (wrong domain, profile links, typos) is skipped instantly
// instead of burning a tab-open + 15s load-wait finding out the hard way.
// Ported from the IG extension's IG_LINK_RE, widened to FB's several valid
// link shapes (marketplace item, .../posts/, permalink.php, story.php,
// photo(.php), /watch). Group posts get their own branch
// (groups/<groupId>/posts|permalink/<postId>) since they have an extra
// path segment before "posts" that the plain "<name>/posts/<id>" branch
// doesn't account for -- without it, links like
// facebook.com/groups/123/posts/456 were being flagged as invalid.
//
// groups/<groupId>/user/<userId> was briefly accepted in v1.5 on the
// thinking that it's a real page worth checking rather than a throwaway
// profile link. Reverted: that URL shape is a member's whole group-posts
// page, not a single post, and just as often resolves to a normal profile
// listing (its "..." menu only offers "Block", no "Report post") as it does
// to a dead "content isn't available" page -- there's no way to tell which
// from the URL alone, and the valid-page case isn't something this
// post-reporting flow can act on anyway. So it's back to being auto-skipped
// like other profile links, same as before v1.5.
// v1.10: widened. Real post links were being rejected because of (a) missing
// "https://" when pasted, (b) m./web./mbasic. hosts, (c) "photo/?fbid=" (slash
// before the "?"), and (d) shapes that weren't listed at all (share/p|v|r,
// reel, <name>/videos|photos, video.php). Links are now normalized to
// https://www.facebook.com first (see normalizeFbLink), then tested here.
// groups/<id>/user/<id> is still deliberately NOT accepted (see v1.7 note).
const FB_LINK_RE = new RegExp(
  "^https://www\\.facebook\\.com/(" +
    [
      "marketplace/item/\\d+",
      "groups/[^/?#]+/(posts|permalink)/[\\w-]+",
      "share/(p|v|r)/[\\w-]+",
      "reel/\\d+",
      "[^/?#]+/(posts|videos|photos)/[\\w-]+",
      "permalink\\.php(\\?|$)",
      "story\\.php(\\?|$)",
      "photo(\\.php)?/?(\\?|$)",
      "video\\.php(\\?|$)",
      "watch/?(\\?|$)",
    ].join("|") +
    ")",
  "i"
);

// profile.php?id=... -- a profile page, not a post/listing. Never opened;
// listed in its own box.
const FB_PROFILE_RE = /^https:\/\/www\.facebook\.com\/profile\.php(\?|$)/i;

// Cleans a pasted line and forces it onto https://www.facebook.com so
// m.facebook.com / web.facebook.com / protocol-less links validate and open
// on a host the extension has permission for. Non-Facebook input is
// returned unchanged (and then fails FB_LINK_RE).
function normalizeFbLink(raw) {
  let s = raw.trim().replace(/^[<"'(\[]+|[>"')\],.;]+$/g, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  try {
    const u = new URL(s);
    if (/(^|\.)facebook\.com$/i.test(u.hostname)) {
      u.protocol = "https:";
      u.hostname = "www.facebook.com";
      return u.toString();
    }
  } catch (e) {}
  return raw.trim();
}

// v1.2: dropped the old fixed OPEN_TAB_SETTLE_MS (5000ms) blind sleep --
// every opened link now waits only as long as the tab actually takes to
// finish loading (see waitForTabComplete), with this as just a safety cap
// for pages that never fire "complete". Ported from the IG extension.
const TAB_LOAD_TIMEOUT_MS = 15000;

// v1.2: the confirmation wait doubles as the gap before the next tab, same
// as the IG extension -- no separate fixed pause needed on top of it. This
// small buffer is just for window/tab-focus switching to settle, not a
// meaningful delay.
const GAP_BETWEEN_TABS_MS = 300;
// v1.4: this is now just a ceiling, not a mandatory sit-out -- see
// waitForConfirmation(), which returns as soon as "Done" actually appears.
// Raised from 2500 since a longer ceiling no longer costs any time on the
// common case, only gives slow-loading confirmations more room before
// giving up and leaving the tab open.
const CONFIRM_WAIT_MS = 5000;

let mode = "tabs"; // "tabs" (use already-open tabs) or "links" (open pasted links one at a time)
let queue = [];
let currentIndex = -1;
let stopRequested = false;
const results = [];

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const tabInfo = document.getElementById("tabInfo");
const progress = document.getElementById("progress");
const logBox = document.getElementById("log");
const linksInput = document.getElementById("linksInput");
const enforcedBox = document.getElementById("enforcedBox");
const enforcedText = document.getElementById("enforcedText");
const enforcedTitle = document.getElementById("enforcedTitle");
const profileBox = document.getElementById("profileBox");
const profileText = document.getElementById("profileText");
const profileTitle = document.getElementById("profileTitle");
const attentionBox = document.getElementById("attentionBox");
const attentionText = document.getElementById("attentionText");
const attentionTitle = document.getElementById("attentionTitle");

progress.textContent = "Ready. Safe to switch to other tabs while this runs.";

startBtn.addEventListener("click", startAutoRun);
stopBtn.addEventListener("click", () => {
  stopRequested = true;
  progress.textContent = "Stopping after current tab…";
});

document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = document.getElementById(btn.dataset.target);
    target.select();
    let copied = false;
    try {
      await navigator.clipboard.writeText(target.value);
      copied = true;
    } catch (e) {
      try {
        copied = document.execCommand("copy");
      } catch (e2) {}
    }
    const original = btn.textContent;
    btn.textContent = copied ? "Copied!" : "Copy failed";
    setTimeout(() => (btn.textContent = original), 1200);
  });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Splits pasted lines into valid FB post/listing URLs vs. everything else.
// Ported from the IG extension's splitValidLinks -- invalid lines are
// rejected up front and never get a tab opened for them.
function splitValidLinks(raw) {
  const lines = raw
    .split(/[\r\n,]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const validLinks = [];
  const profileLinks = [];
  const invalidLinks = [];
  for (const original of lines) {
    const url = normalizeFbLink(original);
    if (FB_LINK_RE.test(url)) validLinks.push(url);
    else if (FB_PROFILE_RE.test(url)) profileLinks.push(original);
    else invalidLinks.push(original); // keep exactly what was pasted
  }
  return { validLinks, profileLinks, invalidLinks };
}

async function startAutoRun() {
  currentIndex = 0;
  stopRequested = false;
  results.length = 0;
  logBox.innerHTML = "";
  enforcedBox.style.display = "none";
  profileBox.style.display = "none";
  attentionBox.style.display = "none";

  const rawLinks = linksInput.value.trim();

  if (rawLinks) {
    mode = "links";
    const { validLinks, profileLinks, invalidLinks } = splitValidLinks(rawLinks);

    for (const url of profileLinks) {
      logResult(
        { url, title: url },
        { success: false, notFound: false, skipped: true, profile: true, stepLabel: "validate link", message: "profile link, not a post — never opened" }
      );
    }

    // Invalid lines never get opened at all -- log + skip them immediately,
    // same as the IG extension's up-front validation.
    for (const url of invalidLinks) {
      logResult(
        { url, title: url },
        { success: false, notFound: false, skipped: true, stepLabel: "validate link", message: "link shape not recognized as a post/listing — never opened" }
      );
    }

    if (!validLinks.length) {
      progress.textContent = `No valid Facebook post/listing links found (${invalidLinks.length} skipped as invalid, ${profileLinks.length} profile links).`;
      finishRun();
      return;
    }

    queue = validLinks.map((url) => ({ url }));
  } else {
    mode = "tabs";
    const tabs = await chrome.tabs.query({ url: TAB_URL_PATTERNS });
    if (!tabs.length) {
      progress.textContent = "No links pasted, and no open Facebook post/listing tabs found.";
      return;
    }
    queue = tabs.map((t) => ({ url: t.url, tabId: t.id, title: t.title, windowId: t.windowId }));
  }

  startBtn.style.display = "none";
  stopBtn.style.display = "block";
  tabInfo.style.display = "block";
  linksInput.disabled = true;

  await runLoop();
}

// Opens a new tab.
function openTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        reject(new Error((chrome.runtime.lastError && chrome.runtime.lastError.message) || "tab creation failed"));
        return;
      }
      resolve(tab);
    });
  });
}

// v1.2: event-driven replacement for the old flat 5-second "just wait and
// hope it loaded" sleep. Resolves as soon as Chrome reports the tab's load
// as "complete" (or after TAB_LOAD_TIMEOUT_MS, whichever comes first), so a
// fast-loading page doesn't sit around waiting out a fixed timer, and a slow
// one still gets a real chance to finish instead of being cut off at 5s.
// Ported from the IG extension's waitForTabComplete. The injected report-flow
// script still does its own short settle-sleep afterward before it starts
// hunting for elements, so this only removes DEAD time, not real margin.
function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    // In case it already finished loading before we attached the listener.
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t && t.status === "complete") finish();
      })
      .catch(finish);
  });
}

async function runLoop() {
  while (currentIndex < queue.length && !stopRequested) {
    const item = queue[currentIndex];
    tabInfo.textContent = `Tab ${currentIndex + 1} of ${queue.length}: ${item.title || item.url}`;

    let tab;
    if (mode === "links") {
      progress.textContent = "Opening tab…";
      try {
        const created = await openTab(item.url);
        await waitForTabComplete(created.id);
        tab = await chrome.tabs.get(created.id);
      } catch (e) {
        const res = { success: false, notFound: false, stepLabel: "open tab", message: "Could not open tab: " + e.message };
        logResult({ url: item.url, title: item.url }, res);
        currentIndex += 1;
        continue;
      }
    } else {
      tab = { id: item.tabId, url: item.url, title: item.title, windowId: item.windowId };
      await chrome.tabs.update(tab.id, { active: true });
      const win = await chrome.windows.get(tab.windowId);
      if (!win.focused) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    }

    progress.textContent = "Running report flow…";
    const res = await runOnTab(tab);
    logResult({ url: tab.url || item.url, title: tab.title || item.url }, res);

    // Every tab closes after processing EXCEPT enforced pages ("Content
    // isn't available"), which are left open for manual review.
    if (!res.enforced) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (e) {
        // tab may have already been closed manually -- safe to ignore
      }
    }

    currentIndex += 1;

    if (currentIndex < queue.length && !stopRequested) {
      progress.textContent = "Waiting before next tab…";
      await sleep(GAP_BETWEEN_TABS_MS);
    }
  }

  finishRun();
}

async function runOnTab(tab) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runReportFlowInPage,
      args: [REPORT_FLOW_STEPS, CONFIRM_WAIT_MS],
    });
    return result;
  } catch (e) {
    return { success: false, notFound: false, stepLabel: "injection", message: e.message };
  }
}

function logResult(tab, res) {
  const url = tab.url || "";
  const title = tab.title || url;
  results.push({
    url,
    success: res.success,
    confirmed: res.confirmed,
    notFound: !!res.notFound,
    enforced: !!res.enforced,
    skipped: !!res.skipped,
    profile: !!res.profile,
    message: res.message,
  });

  const line = document.createElement("div");
  let cls, icon, detail;
  if (res.skipped) {
    cls = "log-warn";
    icon = "⤫";
    detail = res.message;
  } else if (res.enforced) {
    cls = "log-enforced";
    icon = "■";
    detail = `enforced / no longer exists — left open — ${res.message}`;
  } else if (res.notFound) {
    cls = "log-warn";
    icon = "○";
    detail = `not found / already actioned — ${res.message}`;
  } else if (!res.success) {
    cls = "log-fail";
    icon = "✗";
    detail = `failed at "${res.stepLabel || "?"}" — ${res.message}`;
  } else if (res.confirmed === false) {
    cls = "log-warn";
    icon = "△";
    detail = `unconfirmed — ${res.message}`;
  } else {
    cls = "log-ok";
    icon = "✓";
    detail = res.message;
  }
  line.className = "log-line " + cls;
  line.textContent = `${icon} ${title}: ${detail}`;
  logBox.prepend(line);
}

function finishRun() {
  stopBtn.style.display = "none";
  startBtn.style.display = "block";
  startBtn.textContent = "Run again";
  tabInfo.style.display = "none";
  linksInput.disabled = false;

  const confirmed = results.filter((r) => r.success && r.confirmed === true).length;
  // Buckets (no link is counted twice):
  //  profile  -- profile.php?id=... links, never opened.
  //  skipped  -- other invalid links, never opened.
  //  enforced -- "Content isn't available" page (tab left open).
  //  notFound -- gone/private/already actioned.
  //  failed   -- a required step (or the "..." menu) wasn't found, or
  //              nothing confirmed after submitting.
  const profile = results.filter((r) => r.profile);
  const skipped = results.filter((r) => r.skipped && !r.profile);
  const enforced = results.filter((r) => !r.skipped && r.enforced);
  const notFound = results.filter((r) => !r.skipped && !r.enforced && r.notFound);
  const failed = results.filter((r) => !r.skipped && !r.enforced && !r.notFound && (!r.success || r.confirmed === false));

  // One URL per line, duplicates removed. Per-link reasons stay in the log.
  const uniqueUrls = (list) => [...new Set(list.map((r) => r.url))];

  const enforcedUrls = uniqueUrls(enforced);
  if (enforcedUrls.length > 0) {
    enforcedText.value = enforcedUrls.join("\n");
    enforcedTitle.textContent = `Enforced / no longer exists (${enforcedUrls.length})`;
    enforcedBox.style.display = "block";
  }

  const profileUrls = uniqueUrls(profile);
  if (profileUrls.length > 0) {
    profileText.value = profileUrls.join("\n");
    profileTitle.textContent = `Profile links, not posts (${profileUrls.length})`;
    profileBox.style.display = "block";
  }

  const attentionUrls = uniqueUrls([...skipped, ...notFound, ...failed]);
  if (attentionUrls.length > 0) {
    attentionText.value = attentionUrls.join("\n");
    attentionTitle.textContent =
      `Links not confirmed (${attentionUrls.length}) — ${skipped.length} skipped, ${notFound.length} not found, ${failed.length} failed`;
    attentionBox.style.display = "block";
  }

  const summary = `${confirmed} confirmed & closed, ${enforced.length} enforced (left open), ${profile.length} profile links, ${skipped.length} skipped, ${notFound.length} not found, ${failed.length} failed`;
  if (stopRequested) {
    progress.textContent = `Stopped. ${summary} -- before stopping.`;
  } else if (results.length === confirmed && confirmed > 0) {
    progress.textContent = `Done. All ${confirmed} report(s) confirmed & closed.`;
  } else {
    progress.textContent = `Done. ${summary}.`;
  }
}

// ---------------------------------------------------------------------------
// Injected into each Facebook tab. Must be fully self-contained (no
// references to outer scope) since chrome.scripting serializes it.
// ---------------------------------------------------------------------------
function runReportFlowInPage(steps, confirmWaitMs) {
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function textMatches(el, expected) {
    if (!el || !expected) return false;
    const t = (el.textContent || "").trim().toLowerCase();
    const exp = expected.trim().toLowerCase();
    if (!t) return false;
    return t.includes(exp) || exp.includes(t);
  }

  async function realClick(matchedEl, expectedText) {
    // Facebook often layers an invisible full-row "hit target" element on
    // TOP of the visible text (rather than the text living inside that
    // element), so dispatching events on the text's own ancestor chain can
    // completely miss the real click handler. So: scroll the match into
    // view, find whatever element is actually stacked on top at that
    // screen position (exactly what a real click would hit), and click
    // that instead.
    //
    // BUT that coordinate lookup is exactly what can click the row ABOVE
    // or BELOW the intended one -- if the list shifts even slightly
    // between when we found matchedEl and when we click (a hover style, a
    // re-render, a sub-pixel layout change), elementFromPoint silently
    // lands on a neighboring row. So we only trust that coordinate-based
    // guess if its own text actually matches what we meant to click;
    // otherwise we fall back to the text-verified element we already
    // found via findClickableByText.
    try {
      matchedEl.scrollIntoView({ block: "center", inline: "center" });
    } catch (e) {}
    await sleep(200);

    const rect = matchedEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    let target = matchedEl;
    if (typeof document.elementFromPoint === "function") {
      const topHit = document.elementFromPoint(cx, cy);
      if (topHit) {
        const candidate = rowSizedClickTarget(topHit);
        if (!expectedText || textMatches(candidate, expectedText)) {
          target = candidate;
        }
        // else: candidate's text doesn't match what we're trying to click
        // (wrong row) -- keep target = matchedEl instead.
      }
    }

    // Only ever dispatch ONE click, on whichever single element we've
    // settled on above. Firing on both the coordinate-derived target AND
    // the original matchedEl (a previous version of this script did) is
    // risky whenever one is a descendant of the other: the second dispatch
    // bubbles back up through the very handler that already fired once,
    // so a single intended click can double-activate a row -- for a
    // toggle/expand-style row that can mean "select, then immediately
    // re-collapse," which is exactly what was landing this back on the
    // category screen instead of advancing.
    fireClick(target);
  }

  function fireClick(el) {
    // A plain el.click() only fires the "click" event. Some of Facebook's
    // report-flow rows are wired to pointerdown/mousedown instead (or in
    // addition), so a synthetic click alone can silently do nothing -- the
    // row highlights but never navigates. Dispatch the full real-interaction
    // sequence at the element's actual on-screen position instead.
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0 };

    try { el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse" })); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", base));
    try { el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse" })); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
    try { el.click(); } catch (e) {}
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;

    // v1.9: the checks above pass plenty of elements a real click could
    // never land on -- Facebook's screen-reader-only accessibility labels
    // (visually-hidden spans duplicating a menu item's text) and
    // off-screen/pre-rendered menu clones both keep non-zero
    // getBoundingClientRect() dimensions and normal visibility/display
    // values. findClickableByText() sorts by shortest matching text first,
    // so a bare "Report post" a11y span was regularly outranking the real
    // menu row, getting "clicked" (a no-op, since nothing real is there),
    // and letting the step report success -- which is what read as the
    // flow "skipping" Report post: it never actually opened, so every step
    // after it then failed to find its target.
    //
    // v1.9.1: checkOpacity and the viewport-bounds check below were too
    // strict and started rejecting REAL targets -- the report-reason list
    // ("Selling or promoting restricted items" etc.) is a scrollable
    // panel, so a real row further down legitimately has
    // rect.top > window.innerHeight until something scrolls it into view,
    // and Facebook fades that panel in, so checkOpacity could catch it
    // mid-transition. Dropped both; offsetParent + the 1x1px clip check
    // still catch the original sr-only/clone problem without this
    // collateral damage.
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkVisibilityCSS: true })) return false;
    }
    if (el.offsetParent === null && style.position !== "fixed") return false;
    if (rect.width <= 1 && rect.height <= 1) return false; // classic visually-hidden 1x1px pattern
    return true;
  }

  function getSearchRoot() {
    // If a modal (like the post lightbox in your screenshot) is open, search
    // only inside it -- otherwise a hidden/background copy of the same post
    // sitting behind the modal can get matched first and short-circuit us.
    const dialogs = document.querySelectorAll('[role="dialog"]');
    if (dialogs.length) return dialogs[dialogs.length - 1];
    return document.body;
  }

  // v1.2: tiered "..." detection ported from the IG extension (which was
  // missing far fewer menu buttons than this used to). Keeps FB's original
  // two label-based tiers, then adds IG's glyph-based and last-resort
  // fallbacks underneath, so a missing/renamed aria-label no longer means
  // an automatic failure.
  const MORE_LABEL_RE = /more options|actions for this post|more actions|post options/i;

  function svgLooksLikeDots(svg) {
    if (!svg) return false;
    if (svg.querySelectorAll("circle").length === 3) return true;
    const title = svg.querySelector("title");
    if (title && MORE_LABEL_RE.test(title.textContent || "")) return true;
    return false;
  }

  function findMoreOptionsButton() {
    const scope = getSearchRoot();
    const scopes = scope === document.body ? [document] : [scope, document];

    // Tier 1: svg[aria-label] matching one of FB's known menu-button labels.
    for (const s of scopes) {
      const svgs = s.querySelectorAll("svg[aria-label]");
      for (const svg of svgs) {
        if (MORE_LABEL_RE.test(svg.getAttribute("aria-label") || "")) {
          const btn = svg.closest('button, [role="button"]');
          if (btn && isVisible(btn)) return btn;
        }
      }
    }

    // Tier 2: aria-label on the clickable element itself (covers bare
    // "More" labels as well as the fuller phrases).
    for (const s of scopes) {
      const labeled = s.querySelectorAll("[aria-label]");
      for (const el of labeled) {
        const label = el.getAttribute("aria-label") || "";
        if (/^more$/i.test(label) || MORE_LABEL_RE.test(label)) {
          const btn = el.closest('button, [role="button"]') || el;
          if (isVisible(btn)) return btn;
        }
      }
    }

    // Tier 3: <svg><title>More options</title></svg> pattern.
    for (const s of scopes) {
      const svgs = s.querySelectorAll("svg");
      for (const svg of svgs) {
        const title = svg.querySelector("title");
        if (title && MORE_LABEL_RE.test(title.textContent || "")) {
          const btn = svg.closest('button, [role="button"]');
          if (btn && isVisible(btn)) return btn;
        }
      }
    }

    // Tier 4: glyph-based -- a small, roughly-square icon-only button whose
    // svg is built from three dots/circles. Catches locale changes or
    // markup where the aria-label is missing/renamed entirely. Selector is
    // widened beyond button/[role="button"] to div[tabindex] too -- group
    // post pages have been seen using a plain focusable div as the trigger
    // instead of a real button/role="button" element.
    {
      const candidates = scope.querySelectorAll('button, [role="button"], div[tabindex]');
      for (const btn of candidates) {
        if (!isVisible(btn)) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width < 12 || rect.width > 56 || rect.height < 12 || rect.height > 56) continue;
        if (Math.abs(rect.width - rect.height) > 12) continue; // roughly square
        const text = (btn.textContent || "").trim();
        if (text.length > 2) continue; // icon-only, no visible label text
        const innerSvg = btn.querySelector("svg");
        if (svgLooksLikeDots(innerSvg)) return btn;
      }
    }

    // Tier 5: aria-haspopup="menu" -- Facebook's React menu triggers are
    // very often marked this way even when the aria-label is missing,
    // renamed, or the icon has no inline svg at all (a background-image
    // sprite instead of a <svg>, which defeats tiers 1/3/4 entirely).
    // Prefer the smallest/icon-sized match closest to the post's own
    // controls over a larger one.
    {
      const candidates = Array.from(scope.querySelectorAll('[aria-haspopup="menu"], [aria-haspopup="true"]')).filter(
        (el) => isVisible(el)
      );
      if (candidates.length) {
        candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height; // smallest (most icon-like) first
        });
        return candidates[0];
      }
    }

    // Tier 6: last resort -- the rightmost empty-text icon button in the
    // post's header/toolbar row (the "..." button conventionally sits at
    // the end of that row). Restricted to a header/banner actually inside
    // `scope` (the dialog, if one is open) so this can't accidentally
    // grab a control from Facebook's site-wide top nav on a full-page
    // permalink where scope has fallen back to document.body.
    if (scope !== document.body) {
      const header = scope.querySelector('[role="banner"], header') || scope;
      const headerButtons = Array.from(header.querySelectorAll('button, [role="button"], div[tabindex]')).filter((b) => {
        if (!isVisible(b)) return false;
        return (b.textContent || "").trim().length === 0;
      });
      if (headerButtons.length) {
        headerButtons.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return headerButtons[0];
      }
    }

    return null;
  }

  function rowSizedClickTarget(node) {
    // Climb from the matched text node looking for the row's own clickable
    // wrapper, but NEVER climb past something row-sized (a generous 90px
    // cap). Without this cap, .closest() can skip right past a row that
    // has no role/tabindex of its own and land on a much bigger ancestor
    // -- in the worst case the whole dialog's outer focus-trap container,
    // whose center point then sits near the MIDDLE row of the list rather
    // than the intended one.
    const ROW_HEIGHT_CAP = 90;
    let el = node;
    let bestFit = node;
    let steps = 0;
    while (el && steps < 8) {
      const rect = el.getBoundingClientRect();
      if (rect.height > ROW_HEIGHT_CAP) break;
      if (rect.width > 0 && rect.height > 0) bestFit = el;
      if (el.matches && el.matches('button, [role="button"], a, [role="menuitem"], div[tabindex]')) {
        return el; // explicitly interactive AND still row-sized -- best case
      }
      el = el.parentElement;
      steps++;
    }
    return bestFit; // largest still-row-sized ancestor we saw
  }

  // v1.12: category-screen rows (e.g. "Selling or promoting restricted
  // items") were being skipped on some posts. Root cause is the same class
  // of bug fixed in v1.9 for "Report post", showing up here differently:
  // this function ranked candidates by "shortest matching text wins" with a
  // flat +25-char slack for everyone. Two ways that backfires on this
  // specific row:
  //   1. Some post/listing types render a subtitle under the category label
  //      inside the SAME clickable row (e.g. "...restricted items" plus a
  //      line like "This includes weapons, drugs, and other regulated
  //      goods"). That pushes the real row's text past target.length+25, so
  //      it gets rejected outright -- while a short static duplicate
  //      elsewhere (an a11y label, a breadcrumb, a stale off-screen clone)
  //      still fits under the flat threshold and "wins" by being shorter,
  //      even though it isn't the real target.
  //   2. Even when the real row DOES fit, ranking by length first (then
  //      interactive-ness only as a tiebreak on exact-length ties) lets any
  //      shorter non-interactive text match outrank a real, slightly-longer
  //      interactive row outright.
  // Fix: rank by interactive-ness FIRST (an actual button/menuitem/option
  // beats a static span regardless of length), and only apply the tight
  // 25-char slack to non-interactive candidates -- interactive rows get a
  // much larger allowance so a label+subtitle row still matches.
  function findClickableByText(text, avoidPhrases) {
    // Deliberately search the whole document here, not just inside a dialog
    // root -- dropdown/context menus (like the one after clicking "...")
    // are often rendered in their own floating layer outside the post's
    // dialog element, so scoping this too narrowly hides them entirely.
    const target = text.trim().toLowerCase();
    const avoid = (avoidPhrases || []).map((p) => p.toLowerCase());
    const INTERACTIVE_SELECTOR = 'button, [role="button"], a, [role="menuitem"], [role="radio"], [role="option"]';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const candidates = [];
    let node;
    while ((node = walker.nextNode())) {
      if (!isVisible(node)) continue; // skip hidden duplicate menus/screens stacked behind the current one
      const content = (node.textContent || "").trim().toLowerCase();
      if (!content) continue;
      if (avoid.some((a) => content.includes(a))) continue; // e.g. skip "Report post to group admins" when looking for "Report post"
      const isInteractive = !!(node.matches && node.matches(INTERACTIVE_SELECTOR));
      const slack = isInteractive ? 120 : 25;
      if (content === target || (content.includes(target) && content.length <= target.length + slack)) {
        candidates.push({ node, isInteractive, len: node.textContent.trim().length });
      }
    }
    // Interactive-ness wins outright over length -- a real (if slightly
    // longer, subtitle-bearing) menu row must beat a shorter static-text
    // duplicate. Only among candidates of the same interactive-ness do we
    // fall back to preferring the tightest wrapper around the text.
    candidates.sort((a, b) => {
      if (a.isInteractive !== b.isInteractive) return a.isInteractive ? -1 : 1;
      return a.len - b.len;
    });
    for (const { node: el } of candidates) {
      const clickable = rowSizedClickTarget(el);
      if (isVisible(clickable)) return clickable;
    }
    return null;
  }

  function findConfirmationSignal() {
    // Facebook's post-submission screen usually shows a "Done" button and/or
    // thank-you copy. Exact wording varies by flow/locale, so check a few
    // common signals rather than relying on just one.
    const doneBtn = findClickableByText("Done");
    if (doneBtn) return true;

    const phrases = [
      "thanks for your report",
      "thank you for your report",
      "we've received your report",
      "we have received your report",
      "your report has been submitted",
      "thanks for letting us know",
      "thank you for letting us know",
      "submitted to facebook for review",
    ];
    const bodyText = (document.body.innerText || "").toLowerCase();
    return phrases.some((p) => bodyText.includes(p));
  }

  function pageLooksEnforced() {
    // Facebook's specific "This content isn't available at the moment"
    // screen (owner restricted the audience, or it's been deleted/actioned)
    // is a distinct, more useful signal than the generic "unavailable"
    // catch-all below -- it usually means the item is either already gone
    // or was never a real listing, so it gets tracked and reported
    // separately as "enforced / no longer exists" rather than lumped in
    // with plain not-found/broken-link cases.
    const bodyText = (document.body.innerText || "").toLowerCase();
    const signals = [
      "isn't available at the moment",
      "isnt available at the moment",
    ];
    return signals.some((s) => bodyText.includes(s));
  }

  function pageLooksUnavailable() {
    // Catches other posts/listings that are gone, private, or already
    // actioned -- no point hunting for a "..." menu that will never
    // appear. Checked AFTER pageLooksEnforced() so the more specific
    // "isn't available at the moment" wording isn't double-counted here
    // (it's a substring of the generic "isn't available" signal below).
    const bodyText = (document.body.innerText || "").toLowerCase();
    const signals = [
      "isn't available",
      "isnt available",
      "the link you followed may be broken",
      "page not found",
      "sorry, something went wrong",
      "we're working on getting this fixed",
    ];
    return signals.some((s) => bodyText.includes(s));
  }

  async function waitForConfirmation(maxWaitMs) {
    // v1.4: exit the instant "Done" (or the thank-you text) actually shows,
    // instead of always sitting out the full fixed wait first and only then
    // checking. That old order meant the tab sat there for the whole
    // duration even when Done had appeared almost immediately, which read
    // as "it saw Done but didn't close the tab" -- it was just still
    // waiting on its timer with a confirmation already on screen. Still
    // clicks through any intervening "Next" button while it polls.
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (findConfirmationSignal()) return true;
      const nextBtn = findClickableByText("Next");
      if (nextBtn) {
        await realClick(nextBtn, "Next");
        await sleep(400);
        continue;
      }
      await sleep(200);
    }
    return findConfirmationSignal(); // one last check right at the deadline
  }

  async function waitFor(findFn, timeoutMs = 4000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = findFn();
      if (el) return el;
      await sleep(intervalMs);
    }
    return null;
  }

  // v1.3: like waitFor(findClickableByText(step.text)), but if a "Next"
  // button appears WHILE we're waiting for the real target, click through
  // it immediately and keep waiting for the target inside the same
  // timeout window. This is what replaces the old fixed-position "Next"
  // step -- it no longer matters which screen(s) FB decides to put a Next
  // button on, and there's no wasted timeout spent on a Next check at a
  // position where FB never puts one.
  async function waitForStepClickingThroughNext(text, avoidPhrases, timeoutMs, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = findClickableByText(text, avoidPhrases);
      if (el) return el;
      const nextBtn = findClickableByText("Next");
      if (nextBtn) {
        await realClick(nextBtn, "Next");
        await sleep(400);
        continue;
      }
      await sleep(intervalMs);
    }
    return null;
  }

  return (async () => {
    await sleep(500); // let the SPA finish its own initial render pass

    if (pageLooksEnforced()) {
      return {
        success: false,
        notFound: false,
        enforced: true,
        stepLabel: "page check",
        message: "Content isn't available -- owner restricted who can see it, or it's been deleted. Likely already enforced or never existed.",
      };
    }
    if (pageLooksUnavailable()) {
      return {
        success: false,
        notFound: true,
        stepLabel: "page check",
        message: "Post looks unavailable (deleted, private, or already actioned).",
      };
    }

    // Standalone photo permalinks (facebook.com/photo?fbid=...) open in a
    // lightbox/photo-viewer rather than the full post, and the "..." report
    // menu isn't available there -- there's a "View Post" link/button that
    // routes to the actual post page instead. Try it first, short timeout
    // and optional: on a link that's already a full post, it simply isn't
    // there and this is a no-op.
    const viewPostBtn = await waitFor(() => findClickableByText("View Post"), 1500);
    if (viewPostBtn) {
      await realClick(viewPostBtn, "View Post");
      await sleep(900); // let the routed-to post page render before hunting for "..."
      if (pageLooksEnforced()) {
        return {
          success: false,
          notFound: false,
          enforced: true,
          stepLabel: "page check",
          message: "Content isn't available after following 'View Post' -- owner restricted who can see it, or it's been deleted. Likely already enforced or never existed.",
        };
      }
      if (pageLooksUnavailable()) {
        return {
          success: false,
          notFound: true,
          stepLabel: "page check",
          message: "Post looks unavailable after following 'View Post' (deleted, private, or already actioned).",
        };
      }
    }

    const moreBtn = await waitFor(findMoreOptionsButton, 7000);
    if (!moreBtn) {
      const nowEnforced = pageLooksEnforced();
      const nowUnavailable = !nowEnforced && pageLooksUnavailable();
      return {
        success: false,
        notFound: nowUnavailable,
        enforced: nowEnforced,
        stepLabel: "Open menu (...)",
        message: nowEnforced
          ? "Content isn't available -- owner restricted who can see it, or it's been deleted. Likely already enforced or never existed."
          : nowUnavailable
          ? "Post looks unavailable (deleted, private, or already actioned)."
          : "Could not find the post's '...' menu button on this page.",
      };
    }
    await realClick(moreBtn);
    await sleep(700);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // The search window also absorbs any intervening "Next" screens
      // (see waitForStepClickingThroughNext).
      const timeout = 5000;
      const el = await waitForStepClickingThroughNext(step.text, step.avoid, timeout);

      if (!el) {
        return {
          success: false,
          notFound: false,
          stepLabel: step.text,
          message: `Could not find "${step.text}" on screen after ${timeout / 1000} seconds.`,
        };
      }

      await realClick(el, step.text);
      await sleep(i === 0 ? 700 : 500);
    }

    // As soon as the "Done" confirmation shows up, this returns true right
    // away so the tab can close without hanging around for the rest of
    // confirmWaitMs.
    const confirmed = await waitForConfirmation(confirmWaitMs);

    if (confirmed) {
      // Best-effort: click "Done" ourselves to close out the "More actions"
      // dialog cleanly before the tab gets removed. Kept quick since the
      // tab is about to close regardless.
      try {
        const doneBtn = findClickableByText("Done");
        if (doneBtn) {
          await realClick(doneBtn, "Done");
        }
      } catch (e) {}
    }

    return {
      success: true,
      notFound: false,
      confirmed,
      message: confirmed
        ? `Report submitted -- "Done" confirmation detected.`
        : `Report flow completed; no "Done" confirmation detected after 5s wait.`,
    };
  })();
}
