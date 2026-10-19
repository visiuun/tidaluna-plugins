# Vis's Luna Plugins

A collection of plugins for **[TidaLuna](https://github.com/Inrixia/TidaLuna)**.

---

## Installing into TIDAL

1. Open **TIDAL** with **TidaLuna** installed.
2. Navigate to **Luna Settings** > **Plugin Store**.
3. In the **Install from URL** field, paste:
   ```text
   https://github.com/visiuun/tidaluna-plugins/releases/download/latest/store.json
   ```
4. Press Enter to load **Vis's Luna Plugins**, then click **Install** on the plugins you want (e.g. `@visiuun/3d-cover`, `@visiuun/tidal-genres`, `@visiuun/quick-queue`).

---

## Plugins

### 3D Cover (`@visiuun/3d-cover`)

Turns the now playing cover into a 2.5D parallax scene that moves with TIDAL's cover tilt when you hover it.

- Depth is generated **locally** with Depth-Anything-V2 (WebGPU when available, CPU otherwise). The model downloads once (~27MB for Small) and is kept on disk.
- Generation starts 1.5s after a track begins playing (skipped tracks are never processed), and the next track is prepared ahead of time. Hovering a cover that isn't ready yet generates it immediately.
- Every generated depth map is saved on disk (~7KB each), so a cover is only ever processed once.
- Rendering is a single WebGL shader that ray-marches the depth map, so foreground correctly covers background and the gaps behind edges are filled from the background.
- Settings: model (Small/Base), depth shift, focal plane, edge anti-smear, fallback mouse smoothing, invert direction, clear depth cache, clear downloaded model.

---

## Local Development

### Prerequisites

- Node.js (v20+ recommended)
- pnpm package manager

```sh
corepack enable
corepack prepare pnpm@latest --activate
```

### Setup and Build

1. Clone the repository:
   ```sh
   git clone https://github.com/visiuun/tidaluna-plugins.git
   cd tidaluna-plugins
   ```

2. Install dependencies:
   ```sh
   pnpm install
   ```

3. Start development mode with hot-reloading:
   ```sh
   pnpm run watch
   ```

4. Test changes live in TIDAL under **Luna Settings** > **Plugin Store** > **DEV**.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
