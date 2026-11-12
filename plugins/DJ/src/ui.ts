// The DJ in TIDAL's interface: the DJ button in the player bar (start, then "switch it up"), a panel for
// requests and quick settings, captions for what the DJ says, and a card on the Home page.
import type { LunaUnload } from "@luna/core";
import { suggestions } from "./brain";
import { persona, settings, VOICES, type Commentary } from "./config";
import { ask, getStatus, isActive, onStatus, setTransitionOnly, skip, startSession, stopSession, switchUp, voiceLevel, type Status } from "./session";

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
  .${ROOT}-more { width: 16px; height: 28px; border: 0; padding: 0; margin-left: -3px; background: none; color: inherit; opacity: .55; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .${ROOT}-more:hover { opacity: 1; }
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

  .${ROOT}-panel { position: fixed; z-index: 9999; width: 340px; padding: 16px; border-radius: 16px; background: rgba(20,20,26,.96); backdrop-filter: blur(18px); color: #fff; box-shadow: 0 14px 50px rgba(0,0,0,.55); border: 1px solid rgba(255,255,255,.09); font-size: 13px; line-height: 1.45; display: none; }
  .${ROOT}-panel.open { display: block; }
  .${ROOT}-panel h3 { margin: 0; font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
  .${ROOT}-panel h3 small { font-size: 12px; font-weight: 500; opacity: .6; margin-left: auto; }
  .${ROOT}-status { margin: 8px 0 12px; min-height: 18px; opacity: .78; }
  .${ROOT}-status em { font-style: normal; color: #33ffee; }
  .${ROOT}-said { margin: 0 0 12px; padding: 9px 11px; border-radius: 10px; background: rgba(255,255,255,.06); font-size: 12.5px; }
  .${ROOT}-ask { display: flex; gap: 6px; }
  .${ROOT}-ask input { flex: 1; min-width: 0; height: 34px; padding: 0 11px; border-radius: 9px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #fff; font: inherit; outline: none; }
  .${ROOT}-ask input:focus { border-color: #33ffee; }
  .${ROOT}-ask input::placeholder { color: rgba(255,255,255,.45); }
  .${ROOT}-panel button.pill { height: 30px; padding: 0 12px; border-radius: 15px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #fff; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .${ROOT}-panel button.pill:hover { background: rgba(255,255,255,.13); }
  .${ROOT}-panel button.pill.main { background: #fff; color: #000; border-color: #fff; font-weight: 600; }
  .${ROOT}-panel button.pill.main:hover { background: #e9e9e9; }
  .${ROOT}-panel button.pill[disabled] { opacity: .4; cursor: default; }
  .${ROOT}-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 14px; }
  .${ROOT}-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .${ROOT}-row label { opacity: .6; font-size: 12px; width: 78px; flex: none; }
  .${ROOT}-row select { flex: 1; height: 30px; border-radius: 8px; border: 1px solid rgba(255,255,255,.14); background: #1d1d24; color: #fff; font: inherit; font-size: 12px; padding: 0 8px; }
  .${ROOT}-mode { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,.08); }
  .${ROOT}-mode div { flex: 1; min-width: 0; }
  .${ROOT}-mode strong { display: block; font-size: 12.5px; font-weight: 600; }
  .${ROOT}-mode span { display: block; font-size: 11.5px; opacity: .6; }
  .${ROOT}-actions { display: flex; gap: 6px; margin-top: 14px; }
  .${ROOT}-actions .spacer { flex: 1; }

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
  o.appendChild(el("span", undefined, "DJ"));
  return o;
};
/** TIDAL's keyboard shortcuts (space, arrows…) must not fire while typing a request */
const shield = (input: HTMLElement) => {
  for (const type of ["keydown", "keyup", "keypress"]) input.addEventListener(type, (e) => e.stopPropagation());
};

export const mountUi = (unloads: Set<LunaUnload>) => {
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
  wrap.append(button, more);

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
  const voiceRow = el("div", `${ROOT}-row`);
  const voiceSelect = el("select");
  for (const v of VOICES) {
    const o = el("option", undefined, `${v.name}: ${v.desc}`);
    o.value = v.id;
    voiceSelect.appendChild(o);
  }
  voiceRow.append(el("label", undefined, "Voice"), voiceSelect);
  const talkRow = el("div", `${ROOT}-row`);
  const talkSelect = el("select");
  for (const [value, label] of [
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
  const modeBtn = el("button", "pill");
  modeBtn.type = "button";
  modeRow.append(modeText, modeBtn);
  const actions = el("div", `${ROOT}-actions`);
  const primary = el("button", "pill main");
  const skipBtn = el("button", "pill", "Skip");
  const stopBtn = el("button", "pill", "Stop DJ");
  for (const b of [primary, skipBtn, stopBtn]) b.type = "button";
  const spacer = el("div", "spacer");
  actions.append(primary, skipBtn, spacer, stopBtn);
  panel.append(title, statusLine, said, askRow, chips, voiceRow, talkRow, modeRow, actions);
  document.body.appendChild(panel);

  let open = false;
  const position = () => {
    const r = wrap.getBoundingClientRect();
    if (!r.width) return;
    const place = (box: HTMLElement, width: number) => {
      box.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2))}px`;
      box.style.bottom = `${Math.max(12, window.innerHeight - r.top + 12)}px`;
    };
    place(panel, 372);
    place(caption, Math.min(340, caption.offsetWidth || 340));
  };
  const setOpen = (v: boolean) => {
    open = v;
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

  const render = (s: Status) => {
    const follow = s.phase !== "off" && s.mode === "follow";
    const state = s.phase === "off" ? "off" : follow ? "follow" : s.phase === "starting" ? "starting" : s.talking ? "talking" : s.busy ? "busy" : "playing";
    for (const label of document.querySelectorAll<HTMLElement>(`.${ROOT}-orb span`)) label.textContent = follow ? "MIX" : "DJ";
    document.body.classList.toggle(`${ROOT}-locked`, s.phase !== "off" && s.phase !== "stopping" && !follow);
    wrap.dataset.dj = state;
    panel.dataset.dj = state;
    for (const c of document.querySelectorAll<HTMLElement>(`.${ROOT}-card[data-instance="${instance}"]`)) renderCard(c, s);
    button.title = s.phase === "off" ? "Start the DJ" : follow ? "Transitions only is on: what you play is mixed together. Click to start the DJ" : s.phase === "starting" ? "The DJ is getting ready" : "DJ: switch it up";
    more.style.display = "";
    const p = persona();
    titleVoice.textContent = p.name;
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
    askRow.style.display = on ? "" : "none";
    chips.style.display = on ? "" : "none";
    primary.textContent = s.phase === "off" || follow ? "Start DJ" : "Switch it up";
    primary.disabled = s.phase === "starting" || s.phase === "stopping";
    skipBtn.style.display = on ? "" : "none";
    stopBtn.style.display = s.phase === "off" || follow ? "none" : "";
    modeBtn.textContent = settings.transitionOnly ? "On" : "Off";
    modeBtn.classList.toggle("main", !!settings.transitionOnly);
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
  stopBtn.addEventListener("click", () => {
    stopSession("stopped from the panel");
    setOpen(false);
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
    if (open && !panel.contains(e.target as Node) && !wrap.contains(e.target as Node)) setOpen(false);
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
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("resize", onResize);
    document.body.classList.remove(`${ROOT}-locked`);
    wrap.remove();
    panel.remove();
    caption.remove();
    for (const c of document.querySelectorAll(`.${ROOT}-card`)) c.remove();
    style.remove();
    if (window.__visiuunDjUiDispose === dispose) delete window.__visiuunDjUiDispose;
  };
  window.__visiuunDjUiDispose = dispose;
  unloads.add(dispose);
  return { refresh: place };
};

export { isActive };
