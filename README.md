# dsh-voice 🎤

A voice input plugin for DeepSeek Harness: click 🎤 in the web UI (or press a hotkey), speak, and the recognized text is submitted as a normal chat message. **Input only** — it never touches the agent preset/persona, so it behaves like "another input method" in every mode.

[![npm](https://img.shields.io/npm/v/@nn12138/dsh-voice)](https://www.npmjs.com/package/@nn12138/dsh-voice)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Features

- 🎤 **Voice input**: microphone button (platform design-system UI) + configurable global hotkey (Ctrl+Space by default)
- ⚡ **Live recognition**: streaming partial transcripts are echoed while you speak; VAD finalization commits on stop (0.6s tail padding keeps sentence endings)
- 🧠 **Adaptive dual engine**: host-native ASR (sherpa-onnx-node zipformer2 + silero VAD, offline/private) with automatic fallback to browser Web Speech (zero extra dependencies)
- 🔌 **Preset-agnostic**: does not touch the persona/system prompt; works with code/standard/minimal/custom presets
- 📦 **Optional models**: zero-config out of the box; run `dsh-voice-models` when you want native offline recognition

## Installation

```sh
# Plugin
dsh plugin --profile web add @nn12138/dsh-voice

# Optional: offline native recognition (the plugin does not auto-install this runtime)
dsh plugin --profile web add sherpa-onnx-node
dsh-voice-models            # one-shot model download (~100MB) → ./dsh-voice-models

# Optional: configuration (edit ~/.dsh/profiles/web/cordis.patch.yml)
```

```yaml
- id: voice
  config:
    modelDir: './dsh-voice-models'   # native ASR model directory
    hotkey: 'ctrl+space'             # global hotkey
    vadThreshold: 0.3                # lower = less clipping at sentence boundaries
    tailPadSeconds: 0.6              # tail-padding duration
    engine: auto                     # auto (default) | native | browser
```

The row-level `config` is received by the host half. `engine` and `hotkey` are synced to the browser half over the `/voice.config` loopback RPC, so there is no separate client config to write. `auto` probes host native capability: with a model it uses native; without one it falls back to Web Speech, so zero-config users keep working.

```sh
dsh web   # 🎤 button appears on the left of the composer, or press Ctrl+Space
```

See [USAGE.md](USAGE.md) and [INSTALL.md](INSTALL.md) (Chinese) for details.

## How it works

```
Browser captures mic audio (auto-resampled to 16 kHz)
  → PCM base64 chunks (256 ms) → /voice RPC channel (loopback)
  → host: silero VAD + zipformer2 streaming decode
  → partials returned per chunk (live echo) / finals committed
    (VAD segmentation + 0.6s tail padding)
  → conversation service submits the text (same path as typing)
```

Engine selection: the client pings `/voice` to probe host-native capability; if unavailable it degrades to browser Web Speech. `/voice.config` carries the row-level `engine`/`hotkey` from host to client.

## Development

```sh
pnpm install --ignore-workspace   # standalone deps (no DSH monorepo needed); prepare auto-builds
pnpm test                         # unit tests (including real-model smoke tests)
pnpm typecheck && pnpm build      # explicit check & build (tsc host half + tsdown client half)
```

Real-model smoke tests look for the local `voxelf` assets and skip when absent; override with:
`DSH_VOICE_MODEL_DIR` (model directory) / `DSH_VOICE_TEST_WAV` (test wav) / `DSH_VOICE_DOWNLOADED_MODELS` (downloaded model directory).

Layout: `src/index.ts` (host half) / `src/client/` (browser half) / `src/core/` (recognition core) / `tools/` (wire-protocol smoke tools + model downloader).

## License

MIT
