import { LunaUnload, Tracer } from "@luna/core";
import { settings } from "./Settings";

export { Settings } from "./Settings";

export const { trace } = Tracer("[TidalGenres]");
trace.msg.log("Tidal Genres initialized!");

export const unloads = new Set<LunaUnload>();

let lastGenres: string[] = [];

// 1. Dynamic Layout Overrides
const dynamicStyle = document.createElement("style");
dynamicStyle.id = "tidal-genres-layout-override";
document.head.appendChild(dynamicStyle);

unloads.add(() => {
  dynamicStyle.remove();
});

function updateLayoutOverrides() {
  const scrollKeyframes = `
    @keyframes tidal-genres-scroll {
      0%, 20% {
        transform: translateX(0);
      }
      80%, 100% {
        transform: translateX(calc(-1 * var(--genre-scroll-dist, 80px)));
      }
    }
  `;

  if (settings.position === "under") {
    dynamicStyle.textContent = `
      ${scrollKeyframes}
      #footerPlayer {
        height: auto !important;
        min-height: 104px !important;
        padding-top: 10px !important;
        padding-bottom: 10px !important;
        transition: min-height 0.25s ease, padding 0.25s ease !important;
      }
      #footerPlayer div[class*="_playerContent_"] {
        height: auto !important;
        min-height: 88px !important;
        align-items: center !important;
      }
      #footerPlayer div[data-test="track-info"],
      #footerPlayer div[class*="_trackInfo_"] {
        height: auto !important;
        max-height: none !important;
        align-items: center !important;
        overflow: visible !important;
        max-width: 50% !important;
        min-width: 280px !important;
        width: auto !important;
      }
      #footerPlayer button[data-test="player-details-toggle-now-playing"],
      #footerPlayer div[class*="_artworkContainer_"],
      #footerPlayer figure[data-test="current-media-imagery"],
      #footerPlayer figure[class*="_artwork_"] {
        width: 80px !important;
        height: 80px !important;
        min-width: 80px !important;
        min-height: 80px !important;
        transition: width 0.25s ease, height 0.25s ease !important;
      }
      #footerPlayer img[class*="_cellImage_"],
      #footerPlayer img[class*="_image_"] {
        width: 80px !important;
        height: 80px !important;
        border-radius: 6px !important;
        object-fit: cover !important;
        transition: width 0.25s ease, height 0.25s ease !important;
      }
      #footerPlayer div[class*="_trackContent_"] {
        overflow: visible !important;
        max-width: none !important;
        width: auto !important;
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        position: relative !important;
        gap: 12px !important;
      }
      #footerPlayer div[class*="_titleArtistStack_"] {
        overflow: visible !important;
        max-width: none !important;
        width: max-content !important;
        min-width: max-content !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
        flex-shrink: 0 !important;
      }
      #footerPlayer div[class*="_actions_"] {
        position: relative !important;
        left: auto !important;
        right: auto !important;
        top: auto !important;
        bottom: auto !important;
        transform: none !important;
        display: flex !important;
        align-items: center !important;
        flex-shrink: 0 !important;
        margin-left: 14px !important;
        z-index: 10 !important;
      }
      #tidal-genres-badge {
        display: inline-flex !important;
        align-items: center !important;
        overflow: visible !important;
      }
    `;
  } else if (settings.position === "over") {
    dynamicStyle.textContent = `
      ${scrollKeyframes}
      #footerPlayer {
        height: auto !important;
        min-height: 104px !important;
        padding-top: 10px !important;
        padding-bottom: 10px !important;
        transition: min-height 0.25s ease, padding 0.25s ease !important;
      }
      #footerPlayer div[class*="_playerContent_"] {
        height: auto !important;
        min-height: 88px !important;
        align-items: center !important;
      }
      #footerPlayer div[data-test="track-info"],
      #footerPlayer div[class*="_trackInfo_"] {
        height: auto !important;
        max-height: none !important;
        align-items: center !important;
        overflow: visible !important;
        max-width: 45% !important;
        min-width: 280px !important;
        width: auto !important;
      }
      #footerPlayer button[data-test="player-details-toggle-now-playing"],
      #footerPlayer div[class*="_artworkContainer_"],
      #footerPlayer figure[data-test="current-media-imagery"],
      #footerPlayer figure[class*="_artwork_"] {
        width: 80px !important;
        height: 80px !important;
        min-width: 80px !important;
        min-height: 80px !important;
        transition: width 0.25s ease, height 0.25s ease !important;
      }
      #footerPlayer img[class*="_cellImage_"],
      #footerPlayer img[class*="_image_"] {
        width: 80px !important;
        height: 80px !important;
        border-radius: 6px !important;
        object-fit: cover !important;
        transition: width 0.25s ease, height 0.25s ease !important;
      }
      #footerPlayer div[class*="_trackContent_"] {
        overflow: visible !important;
        max-width: none !important;
        width: auto !important;
        display: flex !important;
        flex-direction: row !important;
        align-items: center !important;
        position: relative !important;
        gap: 8px !important;
      }
      #footerPlayer div[class*="_titleArtistStack_"] {
        overflow: visible !important;
        max-width: none !important;
        width: max-content !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: center !important;
      }
      #tidal-genres-badge {
        display: inline-flex !important;
        align-items: center !important;
        overflow: visible !important;
      }
    `;
  } else {
    // Position: "right"
    dynamicStyle.textContent = `
      ${scrollKeyframes}
      #footerPlayer {
        transition: min-height 0.25s ease, padding 0.25s ease !important;
      }
      #footerPlayer button[data-test="player-details-toggle-now-playing"],
      #footerPlayer img[class*="_cellImage_"] {
        transition: width 0.25s ease, height 0.25s ease !important;
      }
      #footerPlayer div[data-test="track-info"],
      #footerPlayer div[class*="_trackInfo_"] {
        overflow: visible !important;
        max-width: none !important;
        display: flex !important;
        align-items: center !important;
      }
      #footerPlayer div[class*="_actions_"] {
        overflow: visible !important;
        display: flex !important;
        align-items: center !important;
      }
      #tidal-genres-badge {
        display: inline-flex !important;
        align-items: center !important;
      }
    `;
  }
}

// 2. Create Badge Container
const genreContainer = document.createElement("div");
genreContainer.id = "tidal-genres-badge";

genreContainer.style.setProperty("display", "inline-flex", "important");
genreContainer.style.setProperty("align-items", "center", "important");
genreContainer.style.setProperty("font-size", "11px");
genreContainer.style.setProperty("font-weight", "500");
genreContainer.style.setProperty("line-height", "1");
genreContainer.style.setProperty("user-select", "none");
genreContainer.style.setProperty("z-index", "100");
genreContainer.style.setProperty("pointer-events", "none");
genreContainer.style.setProperty("vertical-align", "middle");

unloads.add(() => {
  genreContainer.remove();
});

// 3. Fetch Genres from Last.fm + iTunes (Limited to 3 Genres)
const genreCache = new Map<string, string[]>();

async function fetchGenres(artist: string, track: string): Promise<string[]> {
  const cacheKey = `${artist} - ${track}`.toLowerCase();
  if (genreCache.has(cacheKey)) return genreCache.get(cacheKey)!;

  let genres: string[] = [];
  const artistParts = artist.toLowerCase().split(/,|&|feat\.|ft\./g).map((s) => s.trim());

  try {
    const lfmUrl = `https://ws.audioscrobbler.com/2.0/?method=track.gettoptags&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}&api_key=b25b959554ed76058ac220b7b2e0a026&format=json`;
    const res = await fetch(lfmUrl);
    const data = await res.json();
    if (data?.toptags?.tag && Array.isArray(data.toptags.tag)) {
      genres = data.toptags.tag
        .map((t: { name: string }) => t.name)
        .filter((name: string) => {
          const lower = name.toLowerCase();
          return (
            !/^\d{4}$/.test(lower) &&
            !/seen live|favorites|favourite|tracks i own|loved/i.test(lower) &&
            !artistParts.some((part) => part.length > 2 && lower.includes(part))
          );
        })
        .slice(0, 3);
    }
  } catch (e) {}

  if (genres.length === 0) {
    try {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(artist + " " + track)}&entity=song&limit=1`;
      const res = await fetch(itunesUrl);
      const data = await res.json();
      if (data?.results?.[0]?.primaryGenreName) {
        genres.push(data.results[0].primaryGenreName);
      }
    } catch (e) {}
  }

  genres = genres.map((g) => g.charAt(0).toUpperCase() + g.slice(1));
  genreCache.set(cacheKey, genres);
  return genres;
}

// 4. Dynamic Quality Color Extraction
function getQualityStyleColors(): { bg: string; border: string; text: string } {
  const badgeContainer = document.querySelector('div[class*="_qualityBadgeContainer_"]');
  const badgeLink = badgeContainer?.querySelector('a[data-test*="quality-badge"]');
  const qualityAttr = (
    badgeLink?.getAttribute("data-test-quality-badge-streaming-quality") ||
    badgeLink?.getAttribute("data-test") ||
    ""
  ).toUpperCase();
  const textContent = (badgeContainer?.textContent || "").toUpperCase();

  if (
    qualityAttr.includes("HI_RES") ||
    qualityAttr.includes("MAX") ||
    textContent.includes("24-BIT") ||
    textContent.includes("MQA")
  ) {
    return {
      bg: "rgba(245, 166, 35, 0.18)",
      border: "1px solid rgba(245, 166, 35, 0.35)",
      text: "#ffc83b",
    };
  }

  if (
    qualityAttr.includes("LOSSLESS") ||
    qualityAttr.includes("HIGH") ||
    textContent.includes("16-BIT") ||
    textContent.includes("FLAC")
  ) {
    return {
      bg: "rgba(51, 255, 238, 0.18)",
      border: "1px solid rgba(51, 255, 238, 0.35)",
      text: "#33ffee",
    };
  }

  return {
    bg: "rgba(0, 0, 0, 0.25)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    text: "#e1e1e6",
  };
}

// 5. Render Badges
function renderBadges() {
  genreContainer.innerHTML = "";
  if (!lastGenres || lastGenres.length === 0) {
    genreContainer.style.display = "none";
    return;
  }
  genreContainer.style.display = "inline-flex";

  const displayList = settings.showMultiple ? lastGenres.slice(0, 3) : lastGenres.slice(0, 1);
  const qualityColors = getQualityStyleColors();
  const isRight = settings.position === "right";

  const track = document.createElement("div");
  track.id = "tidal-genres-track";
  track.style.setProperty("display", "inline-flex", "important");
  track.style.setProperty("flex-direction", "row", "important");
  track.style.setProperty("align-items", "center", "important");
  track.style.setProperty("gap", "5px", "important");
  track.style.setProperty("width", "max-content", "important");
  track.style.setProperty("white-space", "nowrap", "important");

  displayList.forEach((genre) => {
    const tag = document.createElement("span");
    tag.textContent = genre;

    const hasBg = settings.showBackground;
    const matchQuality = settings.matchQualityColor;
    const showBorder = settings.showBorder;

    let textColor = "#e1e1e6";
    let bg = "transparent";
    let border = "none";
    let backdrop = "none";

    if (hasBg) {
      if (matchQuality) {
        textColor = qualityColors.text;
        bg = qualityColors.bg;
        border = showBorder ? qualityColors.border : "none";
      } else {
        textColor = "#e1e1e6";
        bg = "rgba(0, 0, 0, 0.5)";
        border = showBorder ? "1px solid rgba(255, 255, 255, 0.12)" : "none";
      }
      backdrop = "blur(12px)";
    } else {
      textColor = matchQuality ? qualityColors.text : "#e1e1e6";
    }

    tag.style.setProperty("display", "inline-flex", "important");
    tag.style.setProperty("flex-direction", "row", "important");
    tag.style.setProperty("align-items", "center", "important");
    tag.style.setProperty("justify-content", "center", "important");
    tag.style.setProperty("height", "22px", "important");
    tag.style.setProperty("box-sizing", "border-box", "important");
    tag.style.setProperty("color", textColor, "important");
    tag.style.setProperty("background-color", bg, "important");
    tag.style.setProperty("border", border, "important");
    tag.style.setProperty("padding", isRight ? (hasBg ? "0 8px" : "0 3px") : "0 6px", "important");
    tag.style.setProperty("border-radius", "4px", "important");
    tag.style.setProperty("font-family", "monospace, system-ui, sans-serif", "important");
    tag.style.setProperty("font-size", isRight ? "10.5px" : "10px", "important");
    tag.style.setProperty("letter-spacing", "0.2px", "important");
    tag.style.setProperty("backdrop-filter", backdrop, "important");
    tag.style.setProperty("box-shadow", "none", "important");
    tag.style.setProperty("white-space", "nowrap", "important");
    tag.style.setProperty("line-height", "1", "important");
    tag.style.setProperty("width", "auto", "important");
    tag.style.setProperty("max-width", "max-content", "important");
    tag.style.setProperty("flex-shrink", "0", "important");
    tag.style.setProperty("transition", "all 0.2s ease", "important");

    track.appendChild(tag);
  });

  genreContainer.appendChild(track);

  // Auto-scroll back and forth ONLY when position === "right" and more than 1 tag exists
  if (isRight) {
    if (displayList.length > 1) {
      genreContainer.style.setProperty("width", "115px", "important");
      genreContainer.style.setProperty("max-width", "115px", "important");
      genreContainer.style.setProperty("overflow", "hidden", "important");

      const maskGradient = "linear-gradient(to right, transparent 0px, black 12px, black calc(100% - 12px), transparent 100%)";
      genreContainer.style.setProperty("mask-image", maskGradient);
      genreContainer.style.setProperty("-webkit-mask-image", maskGradient);

      requestAnimationFrame(() => {
        const scrollDist = Math.max(0, track.scrollWidth - genreContainer.clientWidth);
        if (scrollDist > 0) {
          genreContainer.style.setProperty("--genre-scroll-dist", `${scrollDist}px`);
          track.style.setProperty("animation", "tidal-genres-scroll 7s ease-in-out infinite alternate", "important");
        } else {
          track.style.removeProperty("animation");
        }
      });
    } else {
      genreContainer.style.setProperty("width", "auto", "important");
      genreContainer.style.setProperty("max-width", "max-content", "important");
      genreContainer.style.setProperty("overflow", "visible", "important");
      genreContainer.style.removeProperty("mask-image");
      genreContainer.style.removeProperty("-webkit-mask-image");
      track.style.removeProperty("animation");
    }
  } else {
    genreContainer.style.setProperty("width", "max-content", "important");
    genreContainer.style.setProperty("max-width", "100%", "important");
    genreContainer.style.setProperty("overflow", "visible", "important");
    genreContainer.style.removeProperty("mask-image");
    genreContainer.style.removeProperty("-webkit-mask-image");
    track.style.removeProperty("animation");
  }
}

// 6. Mount Position
function mountBadge() {
  updateLayoutOverrides();

  const footer = document.querySelector("#footerPlayer") || document.querySelector("footer");
  if (!footer) return;

  const titleStack = footer.querySelector('div[class*="_titleArtistStack_"]');
  const titleContainer =
    footer.querySelector('div[data-test="footer-track-title"]') ||
    footer.querySelector('div[class*="_titleContainer_"]');
  const artistRow =
    footer.querySelector('div[class*="_artistRow_"]') ||
    footer.querySelector('span[data-test="footer-artist-name"]')?.parentElement ||
    footer.querySelector('span[data-test="footer-artist-name"]');

  const favoriteBtn = footer.querySelector(
    'button[data-test*="favorite"], button[aria-label*="favorite" i], button[aria-label*="Favorite" i], button[data-test*="heart"]'
  );
  const actions =
    (favoriteBtn ? (favoriteBtn.closest('div[class*="_actions_"]') || favoriteBtn.parentElement) : null) ||
    footer.querySelector('div[class*="_actions_"]');

  const trackContent = footer.querySelector('div[class*="_trackContent_"]');
  const trackInfo = footer.querySelector('div[data-test="track-info"], div[class*="_trackInfo_"]');

  if (settings.position === "over") {
    genreContainer.style.setProperty("margin", "0 0 4px 0", "important");
    genreContainer.style.setProperty("align-self", "flex-start", "important");

    if (titleContainer) {
      if (titleContainer.previousElementSibling !== genreContainer) {
        titleContainer.before(genreContainer);
      }
    } else if (titleStack) {
      if (genreContainer.parentElement !== titleStack || genreContainer !== titleStack.firstElementChild) {
        titleStack.prepend(genreContainer);
      }
    }
    if (actions) {
      actions.style.removeProperty("margin-left");
    }
  } else if (settings.position === "under") {
    genreContainer.style.setProperty("margin", "4px 0 2px 0", "important");
    genreContainer.style.setProperty("align-self", "flex-start", "important");

    if (artistRow) {
      if (artistRow.nextElementSibling !== genreContainer) {
        artistRow.after(genreContainer);
      }
    } else if (titleContainer) {
      if (titleContainer.nextElementSibling !== genreContainer) {
        titleContainer.after(genreContainer);
      }
    } else if (titleStack) {
      if (genreContainer.parentElement !== titleStack || genreContainer !== titleStack.lastElementChild) {
        titleStack.appendChild(genreContainer);
      }
    }

    if (titleStack) {
      titleStack.style.setProperty("width", "max-content", "important");
      titleStack.style.setProperty("min-width", "max-content", "important");
      titleStack.style.setProperty("flex-shrink", "0", "important");
    }
    if (actions) {
      actions.style.setProperty("margin-left", "16px", "important");
      actions.style.setProperty("position", "relative", "important");
      actions.style.setProperty("flex-shrink", "0", "important");
    }
    if (trackContent) {
      trackContent.style.setProperty("display", "flex", "important");
      trackContent.style.setProperty("flex-direction", "row", "important");
      trackContent.style.setProperty("align-items", "center", "important");
      trackContent.style.setProperty("width", "auto", "important");
      trackContent.style.setProperty("max-width", "none", "important");
    }
  } else {
    // Position: "right"
    genreContainer.style.setProperty("margin", "0 10px", "important");
    genreContainer.style.removeProperty("align-self");

    if (titleStack) {
      titleStack.style.removeProperty("width");
      titleStack.style.removeProperty("min-width");
      titleStack.style.removeProperty("flex-shrink");
    }
    if (actions) {
      actions.style.removeProperty("margin-left");
    }

    if (actions && actions.parentElement) {
      if (actions.nextElementSibling !== genreContainer) {
        actions.after(genreContainer);
      }
    } else if (titleStack && titleStack.parentElement) {
      if (titleStack.nextElementSibling !== genreContainer) {
        titleStack.after(genreContainer);
      }
    } else if (trackInfo) {
      if (genreContainer.parentElement !== trackInfo) {
        trackInfo.appendChild(genreContainer);
      }
    }
  }
}

const mountObserver = new MutationObserver(mountBadge);
mountObserver.observe(document.body, { childList: true, subtree: true });
mountBadge();

unloads.add(() => {
  mountObserver.disconnect();
});

// 7. Live Settings Listener
const onSettingsChanged = () => {
  mountBadge();
  renderBadges();
};
window.addEventListener("luna:genres:updated", onSettingsChanged);

unloads.add(() => {
  window.removeEventListener("luna:genres:updated", onSettingsChanged);
});

// 8. Track Watcher
let lastSong = "";
async function updateForCurrentSong() {
  const titleEl =
    document.querySelector('footer a[href*="/track/"]') ||
    document.querySelector('div[data-test="track-info"] a[href*="/track/"]');
  const artistEl =
    document.querySelector('footer a[href*="/artist/"]') ||
    document.querySelector('div[data-test="track-info"] a[href*="/artist/"]');

  const title = titleEl?.textContent?.trim();
  const artist = artistEl?.textContent?.trim();

  if (!title || !artist) return;

  const currentKey = `${artist} - ${title}`;
  if (currentKey === lastSong) return;
  lastSong = currentKey;

  mountBadge();
  lastGenres = await fetchGenres(artist, title);
  renderBadges();
}

const interval = setInterval(updateForCurrentSong, 500);
updateForCurrentSong();

unloads.add(() => {
  clearInterval(interval);
});