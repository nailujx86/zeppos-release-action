# Zepp OS Release

Build a Zepp OS project, split its `.zab` into per-device `.zpk` files, patch them for direct
install, and emit `zpkd1://` QR codes that install on the watch with no developer account.

- One package and one QR code per device platform in the build.
- Packages are patched to `packageInfo.mode = "preview"` with a 68-year expiry — what
  direct-link installs expect (zeus stamps 48 hours). Bytecode and assets are untouched.
- Every QR is decoded back and compared with its payload before the step can pass.
- **Opt-in publishing:** `publish-pages: true` pushes the packages to a Pages branch and points
  the QR codes at it; `publish-release: true` creates a release page with the QR codes rendered
  in its body. With neither, the action only writes files.
- A chooser table (watch → QR → package link) is written to `release-notes.md` and to the
  job summary.

## Quick start — Pages (recommended)

```yaml
name: Release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write   # required by publish-pages and publish-release

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Resolve version
        id: v
        run: echo "version=${GITHUB_REF_NAME#v}" >> "$GITHUB_OUTPUT"

      - name: Build and publish
        id: pack
        uses: nailujx86/zeppos-release-action@v1
        with:
          expect-version: ${{ steps.v.outputs.version }}
          publish-pages: true
          publish-release: true
          check-urls: true
          require-strings: |
            utils/config/constants.js::export const DEMO_MODE = false
```

Enable Pages once: repo → Settings → Pages → *Deploy from a branch* → branch `gh-pages`,
folder `/ (root)`. Each version lands in its own directory (`gh-pages:/v1.0.0/`), so a printed
QR code keeps working after the next release.

## Release-only (no Pages)

Drop `publish-pages` and keep `publish-release: true`. The QR codes then point at
`github.com/<owner>/<repo>/releases/download/<tag>/<file>.zpk`, the release page shows every QR
code inline, and the packages are attached as release assets. Everything else is identical.

> If a watch refuses a package in this mode, its downloader did not follow the redirect — use
> `publish-pages: true` instead. The packages and QR images are byte-identical either way.

## Bring your own host

```yaml
- uses: nailujx86/zeppos-release-action@v1
  with:
    base-url: cdn.example.com/zepp-app/v1.0.0   # no scheme
```

Upload `${{ steps.pack.outputs.out-dir }}` to that path yourself. Anything that returns the file
directly works (S3, Netlify, nginx); signed or redirecting URLs do not.

Installing: Zepp App → Profile → your watch → Developer Mode → ＋ → Scan. If the phone cannot
scan its own screen, the Scan screen's gallery button accepts a screenshot.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `zab` | no | `dist/*.zab` | Glob for the built `.zab`. Must match exactly one file. |
| `base-url` | no | `""` | Public host and path serving the `.zpk` files, no scheme. Needed when neither publishing mode is on. |
| `out-dir` | no | `zepp-site` | Where the packages, QR images, `packages.json` and `release-notes.md` go. |
| `scheme` | no | `zpkd1` | QR URL scheme: `zpkd1` for mini programs/apps, `watchface` for watch faces. |
| `expiry` | no | `2147483647` | Package validity in seconds, written to `packageInfo.expiredTime`. Default is `INT32_MAX` — about 68 years. |
| `expect-version` | no | `""` | Fail unless the packaged app version matches. Guards tag/`app.json` drift. |
| `build` | no | `true` | Run `npm install --include=dev` and `run` before packing. |
| `run` | no | `npm run build` | Build command, executed in `working-directory`. |
| `working-directory` | no | `.` | Directory containing the Zepp OS project. |
| `require-strings` | no | `""` | Newline separated `file::text` pairs that must exist before packing, e.g. `utils/config/constants.js::export const DEMO_MODE = false`. |
| `verify-qr` | no | `true` | Decode every QR and fail if it does not match its payload. |
| `check-urls` | no | `false` | Poll the public URL of every package once publishing is done. |
| `retries` | no | `12` | Attempts per URL when `check-urls` is on. |
| `delay` | no | `10` | Seconds between attempts. |
| `publish-pages` | no | `false` | Push the packages to a Pages branch and point the QR codes at it. |
| `pages-branch` | no | `gh-pages` | Branch published to when `publish-pages` is on. |
| `pages-dir` | no | `""` | Directory inside `pages-branch` for this version. Defaults to `v<version>`. |
| `publish-release` | no | `false` | Create or update a GitHub release carrying the QR codes and, unless Pages is on, the packages. |
| `tag` | no | `""` | Release tag. Defaults to `v<version>`. |
| `github-token` | no | `${{ github.token }}` | Token used for publishing. Needs `contents: write`. |

## Outputs

| Output | Description |
|---|---|
| `version` | App version read from the packaged `app.json`. |
| `count` | Number of device packages written. |
| `out-dir` | Absolute path of the directory holding the packages and QR codes. |
| `packages` | Path to `packages.json` (slug, label, file, size, models). |
| `notes` | Path to `release-notes.md` (the chooser table). |
| `files` | Newline separated list of the patched `.zpk` paths. |
| `base-url` | The public base URL the QR codes point at. |
| `release-url` | HTML URL of the created or updated release, when `publish-release` is on. |

## What ends up in `out-dir`

```
<stem>-<slug>.zpk        patched, mode=preview, expiry 68 years out
<stem>-<slug>-raw.zpk    exactly as zeus built it, for comparison
qr-<slug>.png            the zpkd1:// QR for that package
packages.json            index of all of the above
release-notes.md         the chooser table
```

`<slug>` is `<shape>-<width>x<height>-<cpu>` (`square-390x450-nxp`), or `<shape>-<width>-<cpu>`
for round screens (`round-466-zps`). Model names come from `~/.zepp/.zeus_devices`, which any
`zeus` command writes; without it packages are labelled by screen and CPU only.

## Notes and limits

- `publish-pages` and `publish-release` both need `permissions: contents: write`. The token is
  passed in through `github-token` and is never echoed in the log.
- A package only installs on the devices it was built for — chipset splits (NXP / ZPS / APOLLO)
  are real, not cosmetic. That is why there is one QR per platform.
- The action needs Node 20 on the runner (`node20` runtime) and network access, because
  `zeus build` refreshes its device list from `upload-cdn.zepp.com`.
- `expiry` defaults to `2147483647` seconds — `INT32_MAX`, about 68 years — so a package
  effectively never expires once published. That ceiling is deliberate: a consumer that holds
  `expiredTime` in a signed 32-bit int would wrap anything larger into a negative, already
  expired value. Re-running a release for the same version rewrites the same URLs with the same
  expiry, so printed QR codes keep working indefinitely.

## Licence

MIT
