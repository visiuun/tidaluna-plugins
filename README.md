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
4. Press Enter to load **Vis's Luna Plugins**, then click **Install** on `@visiuun/tidal-genres`.

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
