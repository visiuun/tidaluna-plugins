import { LunaUnload, Tracer } from "@luna/core";
import { settings } from "./Settings";
import { cachedGenres, flushCaches, getGenres, type GenreRequest } from "./genres";

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

// 3. Genre lookups (TIDAL's own genres + the artists' Last.fm genre tags, see genres.ts)
unloads.add(flushCaches);

function isElementVisible(el: HTMLElement | null): boolean {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  const windowHeight = window.innerHeight || document.documentElement.clientHeight;
  return rect.top < windowHeight + 150 && rect.bottom > -150;
}

const splitArtists = (artist: string) =>
  artist
    .split(/,|&|feat\.|ft\./gi)
    .map((s) => s.trim())
    .filter(Boolean);

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

// 7. Tracklist Badges Implementation
function getArtistNameFromRow(row: HTMLElement): string {
  const artistLinks = row.querySelectorAll(
    'div[data-test="track-row-artist"] a, div[class*="_artistColumn_"] a, div[class*="_artistsInTrackCell_"] a'
  );
  if (artistLinks.length > 0) {
    return Array.from(artistLinks)
      .map((a) => a.textContent?.trim() || "")
      .filter(Boolean)
      .join(", ");
  }
  const artistCol = row.querySelector(
    'div[data-test="track-row-artist"], div[class*="_artistColumn_"], div[class*="_artistsInTrackCell_"]'
  );
  return artistCol?.textContent?.trim() || "";
}

function getTrackTitleFromRow(row: HTMLElement): string {
  const titleEl = row.querySelector('span[data-test="table-cell-title"], span[class*="_titleText_"]');
  return titleEl?.getAttribute("title") || titleEl?.textContent?.trim() || "";
}

function renderTracklistBadge(container: HTMLElement, genres: string[]) {
  container.innerHTML = "";
  if (!genres || genres.length === 0) {
    container.style.display = "none";
    return;
  }
  container.style.setProperty("display", "inline-flex", "important");

  const displayList = settings.showMultiple ? genres.slice(0, 2) : genres.slice(0, 1);

  displayList.forEach((genre) => {
    const tag = document.createElement("span");
    tag.textContent = genre;

    const hasBg = settings.showBackground;
    const showBorder = settings.showBorder;

    tag.style.setProperty("display", "inline-flex", "important");
    tag.style.setProperty("align-items", "center", "important");
    tag.style.setProperty("justify-content", "center", "important");
    tag.style.setProperty("height", "18px", "important");
    tag.style.setProperty("box-sizing", "border-box", "important");
    tag.style.setProperty("color", "#c3c3c8", "important");
    tag.style.setProperty("background-color", hasBg ? "rgba(255, 255, 255, 0.08)" : "transparent", "important");
    tag.style.setProperty("border", showBorder ? "1px solid rgba(255, 255, 255, 0.14)" : "none", "important");
    tag.style.setProperty("padding", hasBg ? "0 5px" : "0 2px", "important");
    tag.style.setProperty("border-radius", "3px", "important");
    tag.style.setProperty("font-family", "monospace, system-ui, sans-serif", "important");
    tag.style.setProperty("font-size", "9.5px", "important");
    tag.style.setProperty("letter-spacing", "0.2px", "important");
    tag.style.setProperty("white-space", "nowrap", "important");
    tag.style.setProperty("line-height", "1", "important");
    tag.style.setProperty("max-width", "max-content", "important");
    tag.style.setProperty("flex-shrink", "0", "important");
    tag.style.setProperty("pointer-events", "none", "important");
    tag.style.setProperty("user-select", "none", "important");

    container.appendChild(tag);
  });
}

function loadGenreForRow(row: HTMLElement) {
  if (!settings.showInTracklist) return;

  const titleCell =
    row.querySelector<HTMLElement>('div[class*="_titleCell_"]') ||
    row.querySelector<HTMLElement>('div[data-test="table-row-title"] > div');
  const titleSpan = row.querySelector<HTMLElement>('span[data-test="table-cell-title"], span[class*="_titleText_"]');
  if (!titleCell || !titleSpan) return;

  const track = getTrackTitleFromRow(row);
  const artist = getArtistNameFromRow(row);
  if (!track || !artist) return;

  const trackId = row.getAttribute("data-track-id") || titleSpan.getAttribute("data-id") || "";
  const trackKey = `${artist} - ${track}`.toLowerCase();

  let badge = titleCell.querySelector<HTMLElement>(".tidal-genres-tracklist-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "tidal-genres-tracklist-badge";
    badge.style.setProperty("display", "inline-flex", "important");
    badge.style.setProperty("align-items", "center", "important");
    badge.style.setProperty("gap", "4px", "important");
    badge.style.setProperty("margin-left", "6px", "important");
    badge.style.setProperty("flex-shrink", "0", "important");
    badge.style.setProperty("vertical-align", "middle", "important");
    titleSpan.after(badge);
  }

  if (badge.dataset.trackId === trackId && badge.dataset.trackKey === trackKey && badge.dataset.loaded === "true") {
    return;
  }

  badge.dataset.trackId = trackId;
  badge.dataset.trackKey = trackKey;

  const req: GenreRequest = {
    id: /^\d+$/.test(trackId) ? trackId : undefined,
    artists: splitArtists(artist),
    stillWanted: () => !!badge && isElementVisible(badge) && badge.dataset.trackKey === trackKey,
  };
  const cached = cachedGenres(req);
  if (cached) {
    badge.dataset.loaded = "true";
    renderTracklistBadge(badge, cached);
    return;
  }

  getGenres(req).then((genres) => {
    if (!badge || !badge.isConnected) return;
    if (badge.dataset.trackKey !== trackKey) return;
    // Cut short because the row scrolled away: try again when it's back on screen
    if (!genres.length && !isElementVisible(badge)) return;
    badge.dataset.loaded = "true";
    renderTracklistBadge(badge, genres);
  });
}

// Lazy Loading with IntersectionObserver
let rowIntersectionObserver: IntersectionObserver | null = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const row = entry.target as HTMLElement;
        loadGenreForRow(row);
      }
    });
  },
  {
    root: null,
    rootMargin: "60px 0px 60px 0px",
    threshold: 0.01,
  }
);

unloads.add(() => {
  rowIntersectionObserver?.disconnect();
  rowIntersectionObserver = null;
});

function processTracklistRows() {
  if (!settings.showInTracklist) {
    document.querySelectorAll(".tidal-genres-tracklist-badge").forEach((el) => el.remove());
    return;
  }

  const rows = document.querySelectorAll<HTMLElement>('div[data-test="tracklist-row"]');
  rows.forEach((row) => {
    if (rowIntersectionObserver) {
      rowIntersectionObserver.observe(row);
    }
  });
}

let tracklistThrottle: any = null;
function scheduleTracklistUpdate() {
  if (tracklistThrottle) return;
  tracklistThrottle = setTimeout(() => {
    tracklistThrottle = null;
    processTracklistRows();
  }, 120);
}

unloads.add(() => {
  if (tracklistThrottle) clearTimeout(tracklistThrottle);
  document.querySelectorAll(".tidal-genres-tracklist-badge").forEach((el) => el.remove());
});

// 8. Observers & Listeners
const mountObserver = new MutationObserver(() => {
  mountBadge();
  scheduleTracklistUpdate();
});
mountObserver.observe(document.body, { childList: true, subtree: true });
mountBadge();
scheduleTracklistUpdate();

unloads.add(() => {
  mountObserver.disconnect();
});

// 9. Live Settings Listener
const onSettingsChanged = () => {
  mountBadge();
  renderBadges();
  processTracklistRows();
};
window.addEventListener("luna:genres:updated", onSettingsChanged);

unloads.add(() => {
  window.removeEventListener("luna:genres:updated", onSettingsChanged);
});

// 10. Track Watcher (Player Bar)
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

  // The track link in the player bar carries TIDAL's id; the playing product is the fallback
  const product = window.luna.lib?.redux.store.getState().playbackControls?.mediaProduct;
  const id =
    /\/track\/(\d+)/.exec(titleEl?.getAttribute("href") ?? "")?.[1] ??
    (product?.productType === "track" && product.productId ? String(product.productId) : undefined);

  const currentKey = `${id ?? ""}|${artist} - ${title}`;
  if (currentKey === lastSong) return;
  lastSong = currentKey;

  mountBadge();
  const genres = await getGenres({ id, artists: splitArtists(artist) });
  if (lastSong !== currentKey) return; // the song changed while this one was looked up
  lastGenres = genres;
  renderBadges();
}

const interval = setInterval(updateForCurrentSong, 500);
updateForCurrentSong();

unloads.add(() => {
  clearInterval(interval);
});