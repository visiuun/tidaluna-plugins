import { LunaUnload, Tracer } from "@luna/core";
import { settings } from "./Settings";

export { Settings } from "./Settings";

export const { trace } = Tracer("[TidalGenres]");
trace.msg.log("Tidal Genres initialized!");

export const unloads = new Set<LunaUnload>();

let lastGenres: string[] = [];

// 1. Dynamic Layout Overrides (Expands Footer & Scales Album Art)
const dynamicStyle = document.createElement("style");
dynamicStyle.id = "tidal-genres-layout-override";
document.head.appendChild(dynamicStyle);

unloads.add(() => {
  dynamicStyle.remove();
});

function updateLayoutOverrides() {
  if (settings.position === "under" || settings.position === "over") {
    dynamicStyle.textContent = `
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
      #footerPlayer div[class*="_trackContent_"],
      #footerPlayer div[class*="_titleArtistStack_"] {
        overflow: visible !important;
      }
    `;
  } else {
    dynamicStyle.textContent = `
      #footerPlayer {
        transition: min-height 0.25s ease, padding 0.25s ease !important;
      }
      #footerPlayer button[data-test="player-details-toggle-now-playing"],
      #footerPlayer img[class*="_cellImage_"] {
        transition: width 0.25s ease, height 0.25s ease !important;
      }
    `;
  }
}

// 2. Create Badge Container
const genreContainer = document.createElement("div");
genreContainer.id = "tidal-genres-badge";

Object.assign(genreContainer.style, {
  display: "inline-flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "5px",
  margin: "0 8px",
  fontSize: "11px",
  fontWeight: "500",
  lineHeight: "1",
  userSelect: "none",
  zIndex: "100",
  pointerEvents: "none",
  verticalAlign: "middle",
});

unloads.add(() => {
  genreContainer.remove();
});

// 3. Fetch Genres from Last.fm + iTunes
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
        .slice(0, 4);
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
    // Studio Gold for Hi-Res / 24-bit
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
    // TIDAL Cyan for Lossless / 16-bit
    return {
      bg: "rgba(51, 255, 238, 0.18)",
      border: "1px solid rgba(51, 255, 238, 0.35)",
      text: "#33ffee",
    };
  }

  // Neutral Deep Dark Glass
  return {
    bg: "rgba(0, 0, 0, 0.25)",
    border: "1px solid rgba(255, 255, 255, 0.12)",
    text: "#e1e1e6",
  };
}

// 5. Render Badges with Dark Black Glassmorphic Styling
function renderBadges() {
  genreContainer.innerHTML = "";
  if (!lastGenres || lastGenres.length === 0) return;

  const displayList = settings.showMultiple ? lastGenres : lastGenres.slice(0, 1);
  const qualityColors = getQualityStyleColors();
  const isInline = settings.position !== "right";

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
        // Pure Dark / Black Glassmorphism
        textColor = "#e1e1e6";
        bg = "rgba(0, 0, 0, 0.5)";
        border = showBorder ? "1px solid rgba(255, 255, 255, 0.12)" : "none";
      }
      backdrop = "blur(12px)";
    } else {
      textColor = matchQuality ? qualityColors.text : "#e1e1e6";
    }

    Object.assign(tag.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      height: "22px",
      boxSizing: "border-box",
      color: textColor,
      backgroundColor: bg,
      border: border,
      padding: isInline ? "0 6px" : (hasBg ? "0 8px" : "0 3px"),
      borderRadius: "4px",
      fontFamily: "monospace, system-ui, sans-serif",
      fontSize: isInline ? "10px" : "10.5px",
      letterSpacing: "0.2px",
      backdropFilter: backdrop,
      boxShadow: "none",
      whiteSpace: "nowrap",
      lineHeight: "1",
      transition: "all 0.2s ease",
    });

    genreContainer.appendChild(tag);
  });
}

// 6. Mount Position
function mountBadge() {
  updateLayoutOverrides();

  const titleStack = document.querySelector('div[class*="_titleArtistStack_"]');
  const actions = document.querySelector('div[class*="_actions_"]');

  if (settings.position === "over" && titleStack) {
    if (genreContainer.parentElement !== titleStack || genreContainer !== titleStack.firstElementChild) {
      genreContainer.style.margin = "0 0 4px 0";
      titleStack.prepend(genreContainer);
    }
  } else if (settings.position === "under" && titleStack) {
    if (genreContainer.parentElement !== titleStack || genreContainer !== titleStack.lastElementChild) {
      genreContainer.style.margin = "4px 0 0 0";
      titleStack.appendChild(genreContainer);
    }
  } else if (actions) {
    // Default: Right
    if (genreContainer.parentElement !== actions) {
      genreContainer.style.margin = "0 8px";
      actions.appendChild(genreContainer);
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