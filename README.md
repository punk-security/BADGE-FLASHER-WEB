# Punk Security Badge Flasher

A static GitHub Pages site for selecting and flashing Punk Security electronic badges through a SerialUPDI adapter using the browser's Web Serial API.

The flasher supports these targets:

| Target | Device signature | Flash | Page size |
|---|---|---:|---:|
| ATtiny402 | `1E 92 27` | 4 KB | 64 bytes |
| ATtiny412 | `1E 92 23` | 4 KB | 64 bytes |
| ATtiny814 | `1E 93 22` | 8 KB | 64 bytes |

The target controls Intel HEX bounds checking, signature verification, page handling and the labels shown during programming.

## Deploy to GitHub Pages

1. Upload the contents of this folder to the root of a GitHub repository.
2. Open **Settings → Pages**.
3. Select **Deploy from a branch**.
4. Select the `main` branch and `/ (root)` folder.
5. Save and wait for the HTTPS GitHub Pages URL.
6. Open the site in desktop Chrome or Edge.

No build process is required. `.nojekyll` is included.

## Custom HEX file

The first catalogue card is always **Custom HEX file**. Select the target chip first, then choose a local `.hex` file.

The target choices are:

- ATtiny402
- ATtiny412
- ATtiny814

Changing the target revalidates the currently loaded HEX file against that device's flash size. The firmware remains in the browser tab and is not uploaded.

The custom option uses the default programming values below unless you change them in the interface:

- SerialUPDI using 8 data bits, even parity and 2 stop bits
- 460800 baud, with automatic safe-speed fallback
- 1 ms page-write delay
- Verify after programming
- Fuses `0:0x00`, `2:0x01`, `6:0x04`, `7:0x00`, `8:0x00`

## Add a hosted badge

Each badge uses its own folder:

```text
badges/my-new-badge/
├── badge.json
├── badge.jpg
└── firmware.hex
```

Add the folder to the root `badges.json`:

```json
{
  "badges": [
    "badges/owasp-ring",
    "badges/punk-five-led",
    "badges/my-new-badge"
  ]
}
```

### Badge configuration

The `target` field selects the programming profile. It must be exactly `attiny402`, `attiny412` or `attiny814`.

```json
{
  "id": "my-new-badge",
  "name": "My New Badge",
  "family": "Electronic badge",
  "description": "Description displayed under the badge name.",
  "image": "badge.jpg",
  "firmware": "firmware.hex",
  "version": "v1.0.0",
  "released": "2026-08-03",
  "target": "attiny412",
  "tags": ["Addressable LEDs", "PTC touch"],
  "enabled": true,
  "baudRate": 460800,
  "writeDelayMs": 1,
  "verify": true,
  "assertSignals": true,
  "fuses": {
    "0": "0x00",
    "2": "0x01",
    "6": "0x04",
    "7": "0x00",
    "8": "0x00"
  }
}
```

The application derives the display name, signature, flash size and page size from `target`; a `targetLabel` field is not required. An unsupported target causes that badge definition to be skipped and reported in the programming log.

Use `"enabled": false` to display a catalogue template without loading or flashing its firmware.

## Flash a badge

1. Select a hosted badge, or select **Custom HEX file** and choose its target.
2. Wait for the Intel HEX image to validate.
3. Choose the SerialUPDI adapter from the browser's serial picker.
4. Optionally click **Check device** to verify the selected device signature.
5. Click **Flash selected badge** and confirm the erase.
6. Leave the adapter connected until programming and verification complete.

The selected target is checked before chip erase. A mismatched ATtiny signature stops the operation.

## Local testing

Double-click `serve.bat`, then open:

```text
http://localhost:8000/
```

Do not open `index.html` directly. Web Serial and catalogue `fetch()` calls require HTTPS or localhost.

## Important limitations

- Web Serial is primarily supported by desktop Chromium browsers such as Chrome and Edge.
- Physical programming should be tested on spare examples of each badge before event use.
- A failed programming operation can leave the badge erased; retain a working megaTinyCore `prog.py` recovery command.
- Hosted firmware is downloaded from GitHub Pages. Serial traffic and custom HEX files remain local to the browser.

## Main files

```text
index.html                 User interface
styles.css                 Punk Security visual theme
app.js                     Catalogue, target selection and flashing workflow
updi.js                    Intel HEX and multi-target Web Serial UPDI implementation
badges.json                List of hosted badge folders
badges/                    Badge images, firmware and metadata
assets/logo_large.png      Local Punk Security website logo
```
