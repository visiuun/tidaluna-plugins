// TIDAL's page made light while the full screen is over it.
//
// Rules with :has() in them are checked again by the browser whenever anything changes that they might care about.
// For most that is cheap, but TIDAL has ~90 like `._marketCheckbox:has(:checked)` (its checkboxes and switches)
// that give the browser nothing to narrow the check down by: with them on the page, ANY element put in or taken out
// anywhere (a lyric line, the full screen's clock ticking over) cost a style pass over all of TIDAL's page, ~100 ms
// measured. Radiant Lyrics' `… > div:has(.rl-wbw-active)` made every word it lit up cost ~70 ms on top, and TIDAL's
// `p a:link:not(:has([class*="marketLink"]))` made any change of any class cost as much. The full screen ran at 25-30
// frames a second, with stalls of up to a third of a second several times a second.
//
// While the full screen is open, nothing of TIDAL's own can be seen but its backdrop and its lyrics (see THROUGH in
// stage.ts): every :has() rule is lifted out of the page then, and put back exactly as it was when the full screen
// closes. The rules for what does show through (the lyrics' panel, the backdrop) stay, with the :has() part taken off
// them: for Radiant Lyrics' rule that comes to the same thing (its lyrics always hold one of the lines it asks about).
// Sheets that come into the page while it is open (a part of TIDAL loaded later, a plugin writing its sheet afresh)
// are seen to as they come: going over the page again finds nothing more to lift where it was done already.

/** Rules for what the full screen shows through to: these keep applying, without their :has() */
const SHOWN = /now-playing-lyrics|now-playing-background|global-background/;

type Lifted = { list: CSSStyleSheet | CSSGroupingRule; index: number; text: string; replaced: boolean };
let lifted: Lifted[] = [];
let observer: MutationObserver | undefined;
let again: ReturnType<typeof setTimeout>[] = [];

/**
 * `sel` with its :has(…) conditions taken off, or undefined where a :has() is a whole part of it on its own (as in
 * `a > :has(b)`: without it, the rule would be about something else)
 */
const withoutHas = (sel: string): string | undefined => {
  let out = "";
  for (let i = 0; i < sel.length; ) {
    if (!sel.startsWith(":has(", i)) {
      out += sel[i++];
      continue;
    }
    if (!out || /[\s>+~,(]$/.test(out)) return undefined;
    let depth = 0;
    let j = i + 4;
    for (; j < sel.length; j++) {
      if (sel[j] === "(") depth++;
      else if (sel[j] === ")" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
};

const lighten = (list: CSSStyleSheet | CSSGroupingRule) => {
  let rules: CSSRuleList;
  try {
    rules = list.cssRules;
  } catch {
    return; // (another site's sheet: it can't be read, and it is none of TIDAL's)
  }
  // (from the end: taking a rule out moves the ones after it)
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    if (rule instanceof CSSStyleRule) {
      const sel = rule.selectorText;
      if (!sel.includes(":has(")) continue;
      const text = rule.cssText;
      try {
        list.deleteRule(i);
        const kept = SHOWN.test(sel) ? withoutHas(sel) : undefined;
        let replaced = false;
        if (kept) {
          list.insertRule(`${kept} ${text.slice(text.indexOf("{"))}`, i);
          replaced = true;
        }
        lifted.push({ list, index: i, text, replaced });
      } catch {}
    } else if (rule instanceof CSSGroupingRule) lighten(rule);
  }
};

const lightenAll = () => {
  for (const sheet of document.styleSheets) lighten(sheet);
};

/** Lifts the page's :has() rules (see above) until `restore` */
export const lightenPage = () => {
  if (observer) return;
  lightenAll();
  // (a sheet that arrives is a <style> or <link> put in the page, or a <style> written afresh; a <link>'s rules are
  // there once it has loaded, a moment later)
  observer = new MutationObserver(() => {
    for (const t of again) clearTimeout(t);
    again = [setTimeout(lightenAll, 30), setTimeout(lightenAll, 1500)];
  });
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
};

/** Puts every rule lightenPage lifted back where it was */
export const restorePage = () => {
  observer?.disconnect();
  observer = undefined;
  for (const t of again) clearTimeout(t);
  again = [];
  // (in the opposite order to the lifting: each goes back to the place it had, with what was after it already back)
  for (const l of lifted.reverse()) {
    try {
      if (l.replaced) l.list.deleteRule(l.index);
      l.list.insertRule(l.text, Math.min(l.index, l.list.cssRules.length));
    } catch {}
  }
  lifted = [];
};
