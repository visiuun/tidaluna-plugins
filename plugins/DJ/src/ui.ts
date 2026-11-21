// The DJ in TIDAL's interface: the DJ button in the player bar (start, then "switch it up"), a panel for
// requests and quick settings, captions for what the DJ says, and a card on the Home page.
import type { LunaUnload } from "@luna/core";
import { poweredByTrueTaste, suggestions } from "./brain";
import { openTrueTastePage } from "./native";
import { persona, settings, VOICES, type Commentary } from "./config";
import { readingNow } from "./talk/voice";
import { ask, flipMashup, getStatus, isActive, mashup, mixerClock, onStatus, setTransitionOnly, shareCode, skip, startSession, stopSession, switchUp, voiceLevel, type Status } from "./session";
import { copyText } from "./clipboard";

const ROOT = "visiuun-dj";
const STYLE_ID = `${ROOT}-style`;
const ANCHOR = '[data-test="play-queue-button"]';
const HOME_FEED = '[data-test="home-page-feed"]';

const css = `
  .${ROOT} { display: inline-flex; align-items: center; position: relative; margin-right: 2px; }
  .${ROOT}-btn { position: relative; width: 32px; height: 32px; border: 0; padding: 0; background: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: inherit; }
  .${ROOT}-orb { --spin: 0deg; --lvl: 0; position: relative; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; transform: scale(calc(1 + var(--lvl) * .22)); transition: transform .08s linear, opacity .2s ease, filter .2s ease; }
  .${ROOT}-orb::before { content: ""; position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from var(--spin), #33ffee, #5b8cff, #b45cff, #ff5ea8, #33ffee); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3.2px), #000 calc(100% - 2.6px)); mask: radial-gradient(farthest-side, transparent calc(100% - 3.2px), #000 calc(100% - 2.6px)); }
  .${ROOT}-orb::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: conic-gradient(from var(--spin), #33ffee, #5b8cff, #b45cff, #ff5ea8, #33ffee); filter: blur(7px); opacity: 0; transition: opacity .3s ease; z-index: -1; }
  .${ROOT}-orb span { font: 800 9px/1 system-ui, sans-serif; letter-spacing: .4px; color: currentColor; opacity: .92; }
  @property --spin { syntax: "<angle>"; inherits: true; initial-value: 0deg; }
  @keyframes ${ROOT}-spin { to { --spin: 360deg; } }
  [data-dj="off"] .${ROOT}-orb { opacity: .72; filter: saturate(.75); }
  [data-dj="off"] .${ROOT}-btn:hover .${ROOT}-orb { opacity: 1; filter: none; }
  [data-dj="starting"] .${ROOT}-orb, [data-dj="busy"] .${ROOT}-orb { animation: ${ROOT}-spin 1.1s linear infinite; }
  [data-dj="playing"] .${ROOT}-orb { animation: ${ROOT}-spin 9s linear infinite; }
  [data-dj="follow"] .${ROOT}-orb { animation: ${ROOT}-spin 16s linear infinite; }
  [data-dj="follow"] .${ROOT}-orb span { font-size: 7.5px; letter-spacing: .2px; }
  [data-dj="follow"].${ROOT}-card .${ROOT}-orb span { font-size: 12px; }
  [data-dj="talking"] .${ROOT}-orb { animation: ${ROOT}-spin 3s linear infinite; }
  [data-dj="playing"] .${ROOT}-orb::after, [data-dj="talking"] .${ROOT}-orb::after, [data-dj="busy"] .${ROOT}-orb::after { opacity: .5; }
  [data-dj="talking"] .${ROOT}-orb::after { opacity: calc(.45 + var(--lvl) * .5); }
  .${ROOT}-btn:active .${ROOT}-orb { transform: scale(.9); }
  /* While one track is being mixed into the next: a second ring comes out around the orb, turning with
     it, faster. It starts as two separate arcs, one for each track, each with a tail; over the length of
     the mix the gap between them closes, and when the new track is on its own they have become one ring,
     which folds back into the orb. (Nothing here follows the beat: it turns and closes steadily.) */
  @property --${ROOT}-turn { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
  @property --${ROOT}-gap { syntax: "<angle>"; inherits: false; initial-value: 115deg; }
  @keyframes ${ROOT}-turn { from { --${ROOT}-turn: 0deg; } to { --${ROOT}-turn: 360deg; } }
  @keyframes ${ROOT}-close { from { --${ROOT}-gap: 115deg; } to { --${ROOT}-gap: 0deg; } }
  .${ROOT}-orb i { position: absolute; inset: -21%; border-radius: 50%; pointer-events: none; opacity: 0; transform: scale(.72); transition: opacity .5s ease, transform .5s cubic-bezier(.3, 1.4, .5, 1);
    background: conic-gradient(from var(--${ROOT}-turn), #33ffee, #b45cff, #ff5ea8, #5b8cff, #33ffee);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2.4px), #000 calc(100% - 1.8px)), conic-gradient(from var(--${ROOT}-turn), transparent 0deg, #000 calc(180deg - var(--${ROOT}-gap)), transparent calc(180deg - var(--${ROOT}-gap)), transparent 180deg, #000 calc(360deg - var(--${ROOT}-gap)), transparent calc(360deg - var(--${ROOT}-gap)));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2.4px), #000 calc(100% - 1.8px)), conic-gradient(from var(--${ROOT}-turn), transparent 0deg, #000 calc(180deg - var(--${ROOT}-gap)), transparent calc(180deg - var(--${ROOT}-gap)), transparent 180deg, #000 calc(360deg - var(--${ROOT}-gap)), transparent calc(360deg - var(--${ROOT}-gap)));
    -webkit-mask-composite: source-in; mask-composite: intersect; }
  [data-mix] .${ROOT}-orb i { opacity: 1; transform: none; animation: ${ROOT}-turn 1.9s linear infinite, ${ROOT}-close var(--${ROOT}-mix, 20s) linear var(--${ROOT}-mixed, 0s) both; }
  [data-mix] .${ROOT}-orb { animation: ${ROOT}-spin 2.6s linear infinite; }
  [data-mix] .${ROOT}-orb::after { opacity: .85; }
  /* A mashup shows both songs where the title is: the playing one and the one sung over it, with what
     makes it a mashup between them */
  .${ROOT}-duo { display: none; min-width: 0; max-width: 100%; line-height: 1.25; }
  body.${ROOT}-mashing .${ROOT}-duo { display: block; }
  body.${ROOT}-mashing [data-test="footer-track-title"] { display: none !important; }
  .${ROOT}-duo .tag { font: 800 9px/1 system-ui, sans-serif; letter-spacing: 1.8px; margin-bottom: 3px; background: linear-gradient(90deg, #33ffee, #5b8cff, #b45cff, #ff5ea8, #33ffee); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent !important; animation: ${ROOT}-slide 6s linear infinite; }
  .${ROOT}-duo .names { display: flex; align-items: baseline; gap: 6px; font-size: 14px; font-weight: 700; white-space: nowrap; }
  .${ROOT}-duo .names span { min-width: 0; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  /* (themes that colour every span from the cover do it with !important: these must outrank them) */
  .${ROOT}-duo .names .a { color: #7ffcf0 !important; }
  .${ROOT}-duo .names .b { color: #ff9cc7 !important; }
  .${ROOT}-duo .names i { flex: none; font-style: normal; font-weight: 800; background: linear-gradient(135deg, #33ffee, #b45cff, #ff5ea8); -webkit-background-clip: text; background-clip: text; color: transparent !important; display: inline-block; animation: ${ROOT}-cross 5s ease-in-out infinite; }
  .${ROOT}-duo .by { font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @keyframes ${ROOT}-slide { to { background-position: -200% 0; } }
  @keyframes ${ROOT}-cross { 0%, 100% { transform: rotate(0deg) scale(1); } 50% { transform: rotate(180deg) scale(1.25); } }
  .${ROOT}-more { width: 16px; height: 28px; border: 0; padding: 0; margin-left: -3px; background: none; color: inherit; opacity: .55; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .${ROOT}-more:hover { opacity: 1; }
  .${ROOT}-full { width: 24px !important; min-width: 0 !important; height: 28px !important; padding: 0 !important; border: 0; background: none; color: inherit; opacity: .55; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .${ROOT}-full:hover { opacity: 1; }
  .${ROOT}-full svg { width: 14px !important; height: 14px !important; fill: none !important; flex: none; }
  .${ROOT}-full svg path { fill: none !important; stroke: currentColor !important; stroke-width: 1.7px !important; }
  /* TIDAL's own rules for buttons in the player bar size every icon to 16px and fill its paths, which
     turned the chevron into a solid blob: these hold it to an outline at its own size */
  .${ROOT}-more { width: 16px !important; min-width: 0 !important; height: 28px !important; padding: 0 !important; }
  .${ROOT}-more svg { width: 10px !important; height: 6px !important; fill: none !important; overflow: visible; flex: none; }
  .${ROOT}-more svg path { fill: none !important; stroke: currentColor !important; stroke-width: 1.6px !important; }

  /* While the full DJ runs TIDAL's queue, shuffle and repeat would break it: they're switched off and greyed out */
  body.${ROOT}-locked [data-test="shuffle"], body.${ROOT}-locked [data-test="repeat"] { opacity: .25 !important; pointer-events: none !important; cursor: default !important; }

  .${ROOT}-caption { position: fixed; z-index: 9998; max-width: 340px; padding: 10px 14px; border-radius: 14px; background: rgba(18,18,24,.92); backdrop-filter: blur(14px); color: #fff; font-size: 13px; line-height: 1.45; box-shadow: 0 8px 30px rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.08); pointer-events: none; opacity: 0; transform: translateY(6px); transition: opacity .25s ease, transform .25s ease; }
  .${ROOT}-caption.show { opacity: 1; transform: none; }
  .${ROOT}-caption b { display: block; font-size: 10px; letter-spacing: .8px; text-transform: uppercase; opacity: .6; margin-bottom: 3px; font-weight: 700; }

  /* The panel, in TIDAL's own look: its fonts and colours (its design tokens, with their values as fallbacks), a solid
     card like its menus, no outlines, white for what matters most and grey for the rest */
  .${ROOT}-panel { --dj-text: "Square Sans Text VF", "Square Sans Text", Helvetica, Arial, sans-serif; --dj-display: "Square Sans Display VF", "Square Sans Display", Helvetica, Arial, sans-serif; --dj-fill: var(--wave-color-opacity-contrast-fill-ultra-thin, #ffffff1a); --dj-fill-hover: var(--wave-color-opacity-contrast-fill-thin, #ffffff33); --dj-grey: var(--wave-color-solid-contrast-darker, #afafb6); --dj-grey2: var(--wave-color-solid-contrast-darkest, #787887); --dj-accent: var(--wave-color-solid-accent-fill, #33ffee);
    position: fixed; z-index: 9999; width: 360px; padding: 20px; border-radius: 12px; background: var(--wave-color-solid-base-brighter, #1f1f23); color: #fff; box-shadow: 0 16px 48px rgba(0,0,0,.6); font-family: var(--dj-text); font-size: 14px; line-height: 20px; font-weight: 500; -webkit-font-smoothing: antialiased; display: none; }
  .${ROOT}-panel.open { display: block; }
  .${ROOT}-panel.over { z-index: 2147483600; }
  .${ROOT}-panel h3 { margin: 0; font-family: var(--dj-display); font-size: 20px; line-height: 28px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
  .${ROOT}-panel h3 small { font-family: var(--dj-text); font-size: 13px; font-weight: 500; color: var(--dj-grey); margin-left: auto; }
  .${ROOT}-status { margin: 6px 0 16px; min-height: 20px; color: var(--dj-grey); font-size: 13px; line-height: 18px; }
  .${ROOT}-status em { font-style: normal; color: #fff; font-weight: 600; }
  .${ROOT}-said { margin: -4px 0 16px; padding: 10px 12px; border-radius: 8px; background: var(--dj-fill); font-size: 13px; line-height: 18px; }
  .${ROOT}-panel h4 { margin: 18px 0 8px; font-family: var(--dj-display); font-size: 15px; line-height: 20px; font-weight: 700; }
  .${ROOT}-panel h4:first-of-type { margin-top: 0; }
  .${ROOT}-ask { display: flex; gap: 8px; }
  .${ROOT}-ask input { flex: 1; min-width: 0; height: 40px; padding: 0 14px; border-radius: 8px; border: 0; background: var(--dj-fill); color: #fff; font: inherit; font-size: 14px; outline: none; box-shadow: inset 0 0 0 1px transparent; transition: box-shadow .15s ease, background-color .15s ease; }
  .${ROOT}-ask input:hover { background: var(--dj-fill-hover); }
  .${ROOT}-ask input:focus { background: var(--dj-fill); box-shadow: inset 0 0 0 1px rgba(255,255,255,.6); }
  .${ROOT}-ask input::placeholder { color: var(--dj-grey2); }
  .${ROOT}-panel button.pill { height: 40px; padding: 0 18px; border-radius: 1000px; border: 0; background: var(--dj-fill); color: #fff; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; white-space: nowrap; flex: none; transition: background-color .15s ease; }
  .${ROOT}-panel button.pill:hover { background: var(--dj-fill-hover); }
  .${ROOT}-panel button.pill.main { background: #fff; color: #000; }
  .${ROOT}-panel button.pill.main:hover { background: var(--wave-color-solid-contrast-dark, #e4e4e7); }
  .${ROOT}-panel button.pill[disabled] { opacity: .4; cursor: default; }
  .${ROOT}-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; }
  .${ROOT}-chips:empty { display: none; }
  .${ROOT}-panel .${ROOT}-chips button.pill { height: 32px; padding: 0 14px; font-size: 13px; }
  .${ROOT}-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; }
  .${ROOT}-row + .${ROOT}-row, .${ROOT}-reader + .${ROOT}-row { margin-top: 8px; }
  .${ROOT}-row label { color: #fff; font-size: 14px; flex: none; }
  .${ROOT}-reader { margin: 2px 0 0; text-align: right; font-size: 12px; line-height: 16px; color: var(--dj-grey2); }
  .${ROOT}-row select { flex: 0 1 220px; min-width: 0; height: 36px; border-radius: 8px; border: 0; background: var(--dj-fill) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23afafb6' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 10px center / 16px; color: #fff; font: inherit; font-size: 13px; padding: 0 32px 0 12px; appearance: none; -webkit-appearance: none; cursor: pointer; text-overflow: ellipsis; outline: none; }
  .${ROOT}-row select:hover { background-color: var(--dj-fill-hover); }
  .${ROOT}-row select option { background: #1f1f23; color: #fff; }
  .${ROOT}-mode { display: flex; align-items: center; gap: 14px; margin-top: 18px; padding: 14px 0 0; border-top: 1px solid var(--dj-fill); }
  .${ROOT}-mode div { flex: 1; min-width: 0; }
  .${ROOT}-mode strong { display: block; font-size: 14px; font-weight: 600; }
  .${ROOT}-mode span { display: block; font-size: 12px; line-height: 16px; color: var(--dj-grey); margin-top: 2px; }
  /* a switch, as TIDAL's own settings have them */
  .${ROOT}-switch { position: relative; flex: none; width: 40px; height: 24px; border-radius: 1000px; border: 0; padding: 0; background: var(--dj-fill-hover); cursor: pointer; transition: background-color .2s ease; }
  .${ROOT}-switch::after { content: ""; position: absolute; left: 3px; top: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .2s ease, background-color .2s ease; }
  .${ROOT}-switch.on { background: #fff; }
  .${ROOT}-switch.on::after { transform: translateX(16px); background: #000; }
  .${ROOT}-actions { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
  .${ROOT}-actions .spacer { flex: 1; }
  .${ROOT}-panel button.icon { width: 40px; height: 40px; padding: 0; border-radius: 1000px; border: 0; background: transparent; color: #fff; cursor: pointer; display: grid; place-items: center; flex: none; transition: background-color .15s ease; }
  .${ROOT}-panel button.icon:hover { background: var(--dj-fill); }
  .${ROOT}-panel button.icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .${ROOT}-powered { display: none; margin-top: 16px; text-align: center; font-size: 11px; line-height: 14px; color: var(--dj-grey2); }
  .${ROOT}-powered.on { display: block; }
  .${ROOT}-powered a { font-weight: 700; color: var(--dj-grey); text-decoration: none; cursor: pointer; }
  .${ROOT}-powered a:hover { color: #fff; }

  .${ROOT}-card { position: relative; display: flex; align-items: center; gap: 18px; margin: 0 0 24px; padding: 18px 22px; border-radius: 14px; overflow: hidden; cursor: pointer; color: #fff; background: linear-gradient(110deg, #10131c 0%, #171a2e 55%, #251a3a 100%); border: 1px solid rgba(255,255,255,.07); }
  .${ROOT}-card::before { content: ""; position: absolute; right: -60px; top: -90px; width: 320px; height: 320px; border-radius: 50%; background: conic-gradient(from 40deg, #33ffee, #5b8cff, #b45cff, #ff5ea8, #33ffee); filter: blur(70px); opacity: .32; transition: opacity .3s ease; }
  .${ROOT}-card:hover::before { opacity: .5; }
  .${ROOT}-card .${ROOT}-orb { width: 46px; height: 46px; flex: none; }
  .${ROOT}-card .${ROOT}-orb::before { -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4.4px)); mask: radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4.4px)); }
  .${ROOT}-card .${ROOT}-orb span { font-size: 14px; }
  .${ROOT}-card .text { position: relative; flex: 1; min-width: 0; }
  .${ROOT}-card .text strong { display: block; font-size: 18px; font-weight: 700; }
  .${ROOT}-card .text span { display: block; opacity: .7; font-size: 13px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .${ROOT}-card .play { position: relative; height: 36px; padding: 0 20px; border-radius: 18px; border: 0; background: #fff; color: #000; font: inherit; font-weight: 600; font-size: 13px; cursor: pointer; }
`;

declare global {
  interface Window {
    __visiuunDjUiDispose?: () => void;
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const orb = () => {
  const o = el("div", `${ROOT}-orb`);
  // (The <i> is the second ring shown while a mix is under way)
  o.append(el("span", undefined, "DJ"), el("i"));
  return o;
};
/** TIDAL's keyboard shortcuts (space, arrows…) must not fire while typing a request */
const shield = (input: HTMLElement) => {
  for (const type of ["keydown", "keyup", "keypress"]) input.addEventListener(type, (e) => e.stopPropagation());
};

/** `openStage`: the DJ full screen (see stage.ts) */
export const mountUi = (unloads: Set<LunaUnload>, openStage: () => void) => {
  // Only one plugin instance may own the interface: a live reload whose cleanup didn't run must not leave a second one
  window.__visiuunDjUiDispose?.();
  document.getElementById(STYLE_ID)?.remove();
  const instance = Math.random().toString(36).slice(2);
  const style = el("style");
  style.id = STYLE_ID;
  style.textContent = `${css}\n.${ROOT}:not([data-instance="${instance}"]), .${ROOT}-card:not([data-instance="${instance}"]) { display: none !important; }`;
  document.head.appendChild(style);

  // ------------------ PLAYER BAR BUTTON ------------------
  const wrap = el("div", ROOT);
  wrap.dataset.instance = instance;
  const button = el("button", `${ROOT}-btn`);
  button.type = "button";
  const buttonOrb = orb();
  button.appendChild(buttonOrb);
  const more = el("button", `${ROOT}-more`);
  more.type = "button";
  more.title = "DJ: requests and options";
  more.innerHTML = `<svg viewBox="0 0 10 6" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5l4-4 4 4"/></svg>`;
  // The DJ full screen
  const full = el("button", `${ROOT}-full`);
  full.type = "button";
  full.title = "DJ full screen";
  full.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>`;
  full.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(false);
    openStage();
  });
  wrap.append(button, more, full);

  // ------------------ CAPTION ------------------
  const caption = el("div", `${ROOT}-caption`);
  const captionWho = el("b");
  const captionText = el("span");
  caption.append(captionWho, captionText);
  document.body.appendChild(caption);

  // ------------------ PANEL ------------------
  const panel = el("div", `${ROOT}-panel`);
  const title = el("h3");
  const titleOrb = orb();
  const titleVoice = el("small");
  title.append(titleOrb, el("span", undefined, "DJ"), titleVoice);
  const statusLine = el("div", `${ROOT}-status`);
  const said = el("div", `${ROOT}-said`);
  const askRow = el("div", `${ROOT}-ask`);
  const input = el("input");
  input.type = "text";
  input.placeholder = "Ask for an artist, a genre, a mood…";
  input.maxLength = 120;
  shield(input);
  const send = el("button", "pill main", "Ask");
  send.type = "button";
  askRow.append(input, send);
  const chips = el("div", `${ROOT}-chips`);
  // Mashup: with a song you name, or (left empty) one the DJ finds
  const mashRow = el("div", `${ROOT}-ask`);
  const mashInput = el("input");
  mashInput.type = "text";
  mashInput.placeholder = "Song name or shared code";
  mashInput.maxLength = 120;
  shield(mashInput);
  const mashBtn = el("button", "pill", "Mashup");
  mashBtn.type = "button";
  mashBtn.title = "Plays another song together with this one: one you name, or one the DJ finds that fits";
  // ...and while one with two singers plays, its other version
  const flipBtn = el("button", "pill", "Other version");
  flipBtn.type = "button";
  flipBtn.title = "Turns the mashup round: the other song's band, with the other singer over it";
  flipBtn.style.display = "none";
  // ...and a code for it, to hand to someone else with the DJ (see playShared)
  const shareBtn = el("button", "pill", "Share");
  shareBtn.type = "button";
  shareBtn.title = "Copies a code for this mashup: pasted into this box, someone else's DJ plays the same mashup";
  shareBtn.style.display = "none";
  mashRow.append(mashInput, mashBtn);
  // (while one plays: its other version, and its code)
  const mashChips = el("div", `${ROOT}-chips`);
  mashChips.append(flipBtn, shareBtn);
  // Section headings, as TIDAL's menus have them
  const askHead = el("h4", undefined, "Ask the DJ");
  const mashHead = el("h4", undefined, "Mashup");
  mashHead.title = "Another song played together with this one: one you name, one the DJ finds (leave it empty), or a mashup someone shared with you (paste its code)";
  const voiceHead = el("h4", undefined, "Voice");
  const voiceRow = el("div", `${ROOT}-row`);
  const voiceSelect = el("select");
  for (const v of VOICES) {
    const o = el("option", undefined, `${v.name}: ${v.desc}`);
    o.value = v.id;
    voiceSelect.appendChild(o);
  }
  voiceRow.append(el("label", undefined, "Character"), voiceSelect);
  // (the names in the list are the DJ's characters: who actually reads them depends on the voice engine)
  const reader = el("div", `${ROOT}-reader`);
  reader.title = "Change it under Voice engine in the DJ's settings";
  const talkRow = el("div", `${ROOT}-row`);
  const talkSelect = el("select");
  for (const [value, label] of [
    ["every", "Introduces every song, radio style"],
    ["full", "Introduces every set"],
    ["less", "Less chatter: hello and goodbye only"],
    ["off", "No talking, just the mix"],
  ] as [Commentary, string][]) {
    const o = el("option", undefined, label);
    o.value = value;
    talkSelect.appendChild(o);
  }
  talkRow.append(el("label", undefined, "Commentary"), talkSelect);
  // Transitions only: a mode of its own, kept across restarts
  const modeRow = el("div", `${ROOT}-mode`);
  const modeText = el("div");
  modeText.append(el("strong", undefined, "Transitions only"), el("span", undefined, "Mixes whatever you play. No picks, no talking"));
  const modeBtn = el("button", `${ROOT}-switch`);
  modeBtn.type = "button";
  modeBtn.setAttribute("role", "switch");
  modeRow.append(modeText, modeBtn);
  const actions = el("div", `${ROOT}-actions`);
  const primary = el("button", "pill main");
  const skipBtn = el("button", "pill", "Skip");
  const stopBtn = el("button", "pill", "Stop DJ");
  const fullBtn = el("button", "icon");
  fullBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>`;
  fullBtn.title = "Full screen";
  for (const b of [primary, skipBtn, stopBtn, fullBtn]) b.type = "button";
  const spacer = el("div", "spacer");
  actions.append(primary, skipBtn, spacer, fullBtn, stopBtn);
  // (shown while the DJ picks by what the TrueTaste plugin has measured of your listening)
  const powered = el("div", `${ROOT}-powered`);
  const poweredLink = el("a", undefined, "TrueTaste");
  poweredLink.title = "Open TrueTaste on GitHub";
  poweredLink.addEventListener("click", (e) => {
    e.preventDefault();
    openTrueTastePage().catch(() => {});
  });
  powered.append("Powered by ", poweredLink);
  powered.title = "The DJ picks by what the TrueTaste plugin has measured of your listening: what you play to the end, what you skip, what you gave a thumbs up";
  panel.append(title, statusLine, said, askHead, askRow, chips, mashHead, mashRow, mashChips, voiceHead, voiceRow, reader, talkRow, modeRow, actions, powered);
  document.body.appendChild(panel);

  let open = false;
  /** What the panel is opened under, when that isn't the DJ button: the full screen's own button for it (see stage.ts) */
  let anchor: HTMLElement | undefined;
  const position = () => {
    const r = wrap.getBoundingClientRect();
    const place = (box: HTMLElement, width: number) => {
      box.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2))}px`;
      box.style.bottom = `${Math.max(12, window.innerHeight - r.top + 12)}px`;
    };
    if (anchor) {
      // (under the button, its right edge on the button's)
      const a = anchor.getBoundingClientRect();
      panel.style.left = `${Math.max(12, Math.min(window.innerWidth - 372 - 12, a.right - 372))}px`;
      panel.style.top = `${a.bottom + 10}px`;
      panel.style.bottom = "auto";
    } else if (r.width) {
      panel.style.top = "";
      place(panel, 372);
    }
    if (r.width) place(caption, Math.min(340, caption.offsetWidth || 340));
  };
  const setOpen = (v: boolean, under?: HTMLElement) => {
    open = v;
    anchor = v ? under : undefined;
    panel.classList.toggle("over", !!anchor);
    panel.classList.toggle("open", v);
    if (v) {
      renderChips();
      render(getStatus());
      position();
      if (getStatus().phase === "playing" && getStatus().mode !== "follow") setTimeout(() => input.focus(), 30);
    }
  };

  const submit = (text: string) => {
    text = text.trim();
    if (!text) return;
    input.value = "";
    if (getStatus().phase === "off") return;
    ask(text);
  };
  const renderChips = () => {
    chips.replaceChildren();
    let list: string[] = [];
    try {
      list = suggestions();
    } catch {}
    for (const s of list) {
      const c = el("button", "pill", s);
      c.type = "button";
      c.addEventListener("click", () => submit(s));
      chips.appendChild(c);
    }
  };

  // ------------------ MASHUP: BOTH SONGS WHERE THE TITLE IS ------------------
  const duo = el("div", `${ROOT}-duo`);
  const duoNames = el("div", "names");
  const duoA = el("span", "a");
  const duoB = el("span", "b");
  duoNames.append(duoA, el("i", undefined, "×"), duoB);
  const duoBy = el("div", "by");
  duo.append(el("div", "tag", "MASHUP"), duoNames, duoBy);
  const showDuo = () => {
    const songs = mixing?.songs;
    document.body.classList.toggle(`${ROOT}-mashing`, !!songs);
    if (!songs) return void duo.remove();
    duoA.textContent = songs.a;
    duoB.textContent = songs.b;
    duoBy.textContent = [songs.artistA, songs.artistB].filter(Boolean).join(" × ");
    // (TIDAL redraws the player bar now and then: it goes back in front of the title each time)
    const title = document.querySelector<HTMLElement>('[data-test="footer-track-title"]');
    if (title?.parentElement && duo.nextElementSibling !== title) title.parentElement.insertBefore(duo, title);
  };

  // ------------------ MIXING ------------------
  // The orbs show a mix for as long as it lasts (the times are the mixer's, see session.ts)
  let mixSeq = -1;
  let mixTimers: ReturnType<typeof setTimeout>[] = [];
  let mixing: { length: number; since: number; songs?: NonNullable<Status["transition"]>["songs"] } | undefined;
  const showMix = (target: HTMLElement) => {
    if (mixing) {
      target.dataset.mix = "1";
      target.style.setProperty(`--${ROOT}-mix`, `${mixing.length.toFixed(2)}s`);
      // (Something drawn part-way through a mix picks the closing ring up where it is)
      target.style.setProperty(`--${ROOT}-mixed`, `${(-(performance.now() - mixing.since) / 1000).toFixed(2)}s`);
    } else delete target.dataset.mix;
  };
  const mixTargets = () => [wrap, panel, ...document.querySelectorAll<HTMLElement>(`.${ROOT}-card[data-instance="${instance}"]`)];
  const setMix = (state: typeof mixing) => {
    mixing = state;
    for (const t of mixTargets()) showMix(t);
    showDuo();
  };
  const followMix = (s: Status) => {
    const tr = s.phase === "off" || s.phase === "stopping" ? undefined : s.transition;
    if ((tr?.seq ?? -1) === mixSeq) return;
    mixSeq = tr?.seq ?? -1;
    for (const t of mixTimers) clearTimeout(t);
    mixTimers = [];
    setMix(undefined);
    if (!tr) return;
    const now = mixerClock();
    if (now >= tr.end) return;
    const length = Math.max(1, tr.end - tr.start);
    // (Both ends are checked against the mixer's clock when their time comes: it stands still while
    // paused, and one reading of it can be a little out)
    const begin = () => {
      const wait = tr.start - mixerClock();
      if (wait > 0.05) mixTimers.push(setTimeout(begin, wait * 1000));
      else setMix({ length, since: performance.now() + wait * 1000, songs: tr.kind === "mashup" ? tr.songs : undefined });
    };
    const finish = () => {
      const left = tr.end - mixerClock();
      if (left > 0.1) mixTimers.push(setTimeout(finish, left * 1000 + 60));
      else setMix(undefined);
    };
    begin();
    mixTimers.push(setTimeout(finish, Math.max(0, tr.end - now) * 1000 + 60));
  };

  const render = (s: Status) => {
    followMix(s);
    const follow = s.phase !== "off" && s.mode === "follow";
    const state = s.phase === "off" ? "off" : follow ? "follow" : s.phase === "starting" ? "starting" : s.talking ? "talking" : s.busy ? "busy" : "playing";
    for (const label of document.querySelectorAll<HTMLElement>(`.${ROOT}-orb span`)) label.textContent = follow ? "MIX" : "DJ";
    document.body.classList.toggle(`${ROOT}-locked`, s.phase !== "off" && s.phase !== "stopping" && !follow);
    wrap.dataset.dj = state;
    panel.dataset.dj = state;
    for (const c of document.querySelectorAll<HTMLElement>(`.${ROOT}-card[data-instance="${instance}"]`)) renderCard(c, s);
    button.title = s.phase === "off" ? "Start the DJ" : follow ? "Transitions only is on: what you play is mixed together. Click to start the DJ" : s.phase === "starting" ? "The DJ is getting ready" : "DJ: switch it up";
    more.style.display = "";
    powered.classList.toggle("on", poweredByTrueTaste() && !follow);
    const p = persona();
    titleVoice.textContent = p.name;
    const by = readingNow();
    reader.textContent =
      by === "online"
        ? `Read online, by Edge's ${p.edge.replace(/^[a-z]+-[A-Z]+-|(Multilingual)?Neural$/g, "")} voice`
        : by === "standin"
          ? "Edge's online voice isn't answering: the local voice is reading"
          : by === "local"
            ? "Read by the local voice, on this PC"
            : "Read by a cloud voice (your OpenAI key)";
    captionWho.textContent = `DJ ${p.name}`;
    // Caption bubble (when the panel isn't showing the same thing)
    // What the DJ is saying, or (when it's working on something) how that's going
    const working = s.phase === "playing" && !!s.busy && !s.caption;
    const showCaption = (!!s.caption || working) && settings.captions && !open;
    if (s.caption) captionText.textContent = s.caption;
    else if (working) captionText.textContent = `${s.busy}…`;
    caption.classList.toggle("show", showCaption);
    if (showCaption) position();

    statusLine.replaceChildren();
    if (s.phase === "off") statusLine.textContent = "Music picked for you in sets, mixed together, with the DJ telling you what's next.";
    else if (follow) statusLine.textContent = "Transitions only: whatever you play is mixed together, track into track. Start the DJ for picks and a voice.";
    else if (s.note) statusLine.textContent = s.note;
    else if (s.busy) statusLine.textContent = `${s.busy}…`;
    else if (s.segment) {
      statusLine.append("Playing: ");
      statusLine.appendChild(el("em", undefined, s.segment));
    }
    said.style.display = s.caption ? "" : "none";
    said.textContent = s.caption ?? "";
    const on = s.phase === "playing" && !follow;
    askHead.style.display = askRow.style.display = on ? "" : "none";
    chips.style.display = on ? "" : "none";
    const mashing = s.transition?.kind === "mashup";
    mashHead.style.display = mashRow.style.display = s.phase === "starting" || s.phase === "stopping" ? "none" : "";
    // (no second mashup asked for while one is coming or playing)
    mashBtn.style.display = mashing ? "none" : "";
    mashInput.disabled = mashing;
    flipBtn.style.display = mashing && s.transition?.detail?.way === "voice" ? "" : "none";
    shareBtn.style.display = mashing && shareCode() ? "" : "none";
    mashChips.style.display = flipBtn.style.display === "none" && shareBtn.style.display === "none" ? "none" : "";
    primary.textContent = s.phase === "off" || follow ? "Start DJ" : "Switch it up";
    primary.disabled = s.phase === "starting" || s.phase === "stopping";
    skipBtn.style.display = on ? "" : "none";
    stopBtn.style.display = s.phase === "off" || follow ? "none" : "";
    modeBtn.classList.toggle("on", !!settings.transitionOnly);
    modeBtn.setAttribute("aria-checked", String(!!settings.transitionOnly));
    voiceSelect.value = settings.voice;
    talkSelect.value = settings.commentary;
  };

  const act = () => {
    const { phase, mode } = getStatus();
    // (With transitions only running, the button starts the full DJ on top of it)
    if (phase === "off" || mode === "follow") startSession();
    else if (phase === "playing") switchUp();
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    act();
  });
  button.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!open);
  });
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    setOpen(!open);
  });
  primary.addEventListener("click", act);
  modeBtn.addEventListener("click", () => {
    setTransitionOnly(!settings.transitionOnly);
    render(getStatus());
  });
  skipBtn.addEventListener("click", () => skip());
  fullBtn.addEventListener("click", () => {
    setOpen(false);
    openStage();
  });
  stopBtn.addEventListener("click", () => {
    stopSession("stopped from the panel");
    setOpen(false);
  });
  const mash = () => {
    const text = mashInput.value;
    mashInput.value = "";
    void mashup(text);
  };
  mashBtn.addEventListener("click", mash);
  flipBtn.addEventListener("click", () => void flipMashup());
  shareBtn.addEventListener("click", async () => {
    const code = shareCode();
    if (!code) return;
    const ok = await copyText(code);
    shareBtn.textContent = ok ? "Code copied" : "Couldn't copy";
    setTimeout(() => (shareBtn.textContent = "Share"), 2200);
  });
  mashInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") mash();
    if (e.key === "Escape") setOpen(false);
  });
  send.addEventListener("click", () => submit(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit(input.value);
    if (e.key === "Escape") setOpen(false);
  });
  voiceSelect.addEventListener("change", () => {
    settings.voice = voiceSelect.value;
    render(getStatus());
  });
  talkSelect.addEventListener("change", () => {
    settings.commentary = talkSelect.value as Commentary;
  });
  const outside = (e: MouseEvent) => {
    if (open && !panel.contains(e.target as Node) && !wrap.contains(e.target as Node) && !anchor?.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener("mousedown", outside, true);
  const onResize = () => (open || caption.classList.contains("show")) && position();
  window.addEventListener("resize", onResize);

  // The orb moves with the DJ's voice
  let raf = 0;
  const pulse = () => {
    raf = 0;
    if (disposed) return;
    const lvl = getStatus().talking ? voiceLevel() : 0;
    for (const o of document.querySelectorAll<HTMLElement>(`.${ROOT}-orb`)) o.style.setProperty("--lvl", lvl.toFixed(3));
    if (getStatus().talking) raf = requestAnimationFrame(pulse);
  };

  // ------------------ HOME CARD ------------------
  const renderCard = (card: HTMLElement, s: Status) => {
    const sub = card.querySelector<HTMLElement>(".text span")!;
    const play = card.querySelector<HTMLButtonElement>(".play")!;
    card.dataset.dj = wrap.dataset.dj;
    showMix(card);
    if (s.phase === "off") {
      sub.textContent = "Your own DJ: music picked for you, mixed together, with a word about what's next";
      play.textContent = "Play";
    } else if (s.mode === "follow") {
      sub.textContent = "Transitions only: whatever you play is mixed together. Start the DJ for picks and a voice";
      play.textContent = "Start DJ";
    } else {
      sub.textContent = s.busy ? `${s.busy}…` : s.segment ? `Playing: ${s.segment}` : "On air";
      play.textContent = s.phase === "playing" ? "Switch it up" : "Starting…";
    }
  };
  const makeCard = () => {
    const card = el("div", `${ROOT}-card`);
    card.dataset.instance = instance;
    const text = el("div", "text");
    text.append(el("strong", undefined, "DJ"), el("span"));
    const play = el("button", "play");
    play.type = "button";
    card.append(orb(), text, play);
    card.addEventListener("click", act);
    renderCard(card, getStatus());
    return card;
  };

  // ------------------ PLACEMENT ------------------
  // TIDAL re-renders the player bar and pages now and then: keep everything in place
  let disposed = false;
  const place = () => {
    if (disposed) return;
    const anchor = document.querySelector<HTMLElement>(ANCHOR);
    if (anchor && !(wrap.isConnected && wrap.parentElement === anchor.parentElement)) {
      // Before TrueTaste's thumbs when they're there, so the order doesn't depend on which plugin loaded first
      const before = anchor.parentElement!.querySelector<HTMLElement>(".true-taste-feedback") ?? anchor;
      anchor.parentElement!.insertBefore(wrap, before.parentElement === anchor.parentElement ? before : anchor);
    }
    if (mixing?.songs) showDuo();
    const feed = document.querySelector<HTMLElement>(HOME_FEED);
    const existing = document.querySelector<HTMLElement>(`.${ROOT}-card[data-instance="${instance}"]`);
    if (!settings.homeCard) existing?.remove();
    else if (feed && !(existing && feed.contains(existing))) {
      existing?.remove();
      feed.insertBefore(makeCard(), feed.firstChild);
    }
  };
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const offStatus = onStatus((s) => {
    render(s);
    if (s.talking && !raf) raf = requestAnimationFrame(pulse);
    if (!s.talking) for (const o of document.querySelectorAll<HTMLElement>(`.${ROOT}-orb`)) o.style.setProperty("--lvl", "0");
  });
  render(getStatus());
  place();

  const dispose = () => {
    disposed = true;
    observer.disconnect();
    offStatus();
    cancelAnimationFrame(raf);
    for (const t of mixTimers) clearTimeout(t);
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("resize", onResize);
    document.body.classList.remove(`${ROOT}-locked`, `${ROOT}-mashing`);
    duo.remove();
    wrap.remove();
    panel.remove();
    caption.remove();
    for (const c of document.querySelectorAll(`.${ROOT}-card`)) c.remove();
    style.remove();
    if (window.__visiuunDjUiDispose === dispose) delete window.__visiuunDjUiDispose;
  };
  window.__visiuunDjUiDispose = dispose;
  unloads.add(dispose);
  return {
    refresh: place,
    /** The panel, for the full screen: opened under `under` (or closed, if it is open there) */
    panel: {
      toggle: (under: HTMLElement) => setOpen(!(open && anchor === under), under),
      isOpen: () => open,
      close: () => setOpen(false),
    },
  };
};

export { isActive };
