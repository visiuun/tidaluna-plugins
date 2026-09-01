import { LunaUnload, Tracer } from "@luna/core";
import { MediaItem } from "@luna/lib";

export const { trace } = Tracer("[TrackOverlay]");
trace.msg.log("TrackOverlay plugin initialized!");

// Functions added here will be called when the plugin is disabled or reloaded
export const unloads = new Set<LunaUnload>();

// 1. Create the floating HUD Overlay Box
const overlay = document.createElement("div");
overlay.id = "tidal-track-overlay";

Object.assign(overlay.style, {
  position: "fixed",
  top: "70px",
  right: "24px",
  zIndex: "999999999",
  backgroundColor: "rgba(18, 18, 22, 0.95)",
  backdropFilter: "blur(12px)",
  border: "2px solid #00e6cc",
  borderRadius: "12px",
  padding: "14px 20px",
  color: "#FFFFFF",
  boxShadow: "0 10px 30px rgba(0, 0, 0, 0.85)",
  fontFamily: "system-ui, -apple-system, sans-serif",
  pointerEvents: "none",
  minWidth: "220px",
  maxWidth: "340px",
  transition: "all 0.2s ease",
});

overlay.innerHTML = `
  <div style="font-size: 11px; font-weight: 700; color: #00e6cc; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">⚡ Now Playing</div>
  <div id="hud-title" style="font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Waiting for music...</div>
  <div id="hud-artist" style="font-size: 13px; color: #b0b0b8; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></div>
`;

// Append overlay to TIDAL
document.body.appendChild(overlay);

// Register cleanup: remove the element when plugin is disabled/reloaded
unloads.add(() => {
  overlay.remove();
});

// Helper to update the text in our overlay
const updateOverlay = (title: string, artist?: string) => {
  const titleEl = document.getElementById("hud-title");
  const artistEl = document.getElementById("hud-artist");

  if (titleEl) titleEl.textContent = `🎵 ${title}`;
  if (artistEl) artistEl.textContent = artist ? `👤 ${artist}` : "";
};

// 2. Listen to track changes using Luna's MediaItem
MediaItem.onMediaTransition(unloads, async (mediaItem) => {
  try {
    if (!mediaItem) return;

    const title = (await mediaItem.title?.()) ?? mediaItem.tidalItem?.title ?? "Unknown Title";
    const artist = mediaItem.tidalItem?.artist?.name ?? "";

    updateOverlay(title, artist);
  } catch (err) {
    trace.err.log("Error reading media transition:", err);
  }
});

// 3. Fast fallback: keep UI synced with the player bar
const interval = setInterval(() => {
  const titleLink = document.querySelector('footer a[href*="/track/"]') || 
                    document.querySelector('a[data-test="current-media-item"]');
  const artistLink = document.querySelector('footer a[href*="/artist/"]');

  if (titleLink?.textContent) {
    const hudTitle = document.getElementById("hud-title");
    if (hudTitle && hudTitle.textContent === "Waiting for music...") {
      updateOverlay(titleLink.textContent, artistLink?.textContent ?? "");
    }
  }
}, 500);

unloads.add(() => {
  clearInterval(interval);
});