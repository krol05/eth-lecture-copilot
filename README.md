# ETH Lecture Copilot

**Chrome extension:** AI study guides and Q&amp;A for ETH Zürich lectures on [video.ethz.ch](https://video.ethz.ch). The sidebar sits next to the video: transcript sync, structured guides with KaTeX math, optional vision (current frame), optional course PDF scripts with local search, history, and PDF export.

---

## Table of contents

1. [Overview](#overview)
2. [At a glance](#at-a-glance)
3. [Features](#features)
4. [Usage guide](#usage-guide)
5. [Course scripts (PDFs)](#course-scripts-pdfs)
6. [Supported providers and models](#supported-providers-and-models)
7. [Installation](#installation)
8. [Project structure](#project-structure)
9. [Development and tests](#development-and-tests)
10. [License](#license)
11. [Privacy and notes](#privacy-and-notes)
12. [UI showcase](#ui-showcase)

---

## Overview

ETH Lecture Copilot injects a sidebar into lecture pages on **video.ethz.ch**. It reads the page transcript (or accepts a manual paste), calls **your** AI provider from the browser, and builds a **time-stamped study guide** split into blocks. While you watch, the guide can follow playback or you can browse sections manually. The **Q&amp;A** tab answers questions using the transcript, the guide, optional **uploaded course scripts**, and optionally a **snapshot of the current video frame** for vision models.

---

## At a glance

| **Guide** · Time-synced blocks, KaTeX, copy per section | **Q&amp;A** · Script-backed answers, temp, optional frame |
|:---:|:---:|
| <img src="docs/images/01-guide-tab.png" alt="Guide tab" width="400" /> | <img src="docs/images/02-qa-tab-scripts.png" alt="Q&A tab" width="400" /> |

---

## Features

### Guide generation

- **Transcript:** Extracted automatically from the lecture page when possible, or paste manually.
- **Structured guide:** JSON-shaped content with per-block time ranges, key concepts, definitions, formulas (KaTeX), and notes.
- **Block detail** and **Block count:** Independent controls from low to very high. Together they shape how dense each block is and how many blocks the model targets. A token hint reflects the combined cost.
- **Language:** Presets (including Swiss national languages), **Same as transcript**, or **Other** with a custom name. Guide prose follows your choice; structure and LaTeX stay valid.
- **Temperature** and **Thinking:** Sent to the provider when supported. The **Thinking** tooltip updates from your saved provider and model (Anthropic extended thinking, Gemini thinking budget, OpenAI **o**-series reasoning effort, or explains when thinking levels are not sent for OpenAI-compatible APIs).
- **Safe defaults:** Optional checkbox to ignore the sliders and use conservative built-in values.
- **Info banner:** Reminds you that quality depends on the model, context window, and your settings.

### Playback and layout

- **Time sync:** The guide can follow the video. If you move with **Previous** / **Next**, auto-follow pauses until you align with the live block again (by navigation or as the video catches up) or tap **Current time**.
- **Focus mode:** Header control to emphasize the video and sidebar.
- **Keyboard:** On the video page (when focus is not in a text field), **Arrow Up** / **Arrow Down** changes playback speed in **0.25×** steps; a short overlay shows the current speed.
- **UI settings:** Sidebar text sizes, dark or light theme, and detailed color tokens, with live preview and restore defaults.

### Q&amp;A

- Uses **transcript**, **guide**, and your **question**. Optional **Course scripts** add retrieved PDF excerpts. Context is **time-aware:** a window around the current playback time plus your question drives retrieval so prompts stay efficient.
- **Temperature** for answer style.
- **Attach current frame:** Sends a JPEG snapshot for **multimodal** models. Text-only models may ignore or error on images.

### Course scripts (PDFs)

- Upload PDFs **per course** (derived from the lecture URL). Text is extracted in the browser with **pdf.js**, chunked, and stored in **IndexedDB**.
- **Search method:**
  - **Fuzzy (fast):** Character or word similarity, no ML, instant.
  - **Semantic AI:** Local **Transformers.js** embeddings (**all-MiniLM-L6-v2**). The extension bundles ONNX **WebAssembly** (CSP allows `wasm-unsafe-eval` for instantiation). The embedding model may download once from Hugging Face and is cached. Indexing a PDF can take on the order of tens of seconds depending on length and device.
- **Script reliance:** From light reference to **strict**, controlling how many chunks are injected and how strongly answers should follow the script.

### History and export

- **History** of guides per lecture: load, open the source page, export **PDF**, delete.
- **Export guide as PDF:** Opens a print-ready page with KaTeX already rendered; use the browser **Save as PDF** action.

### Providers

- **Cloud:** Google Gemini, OpenAI, Anthropic, xAI, DeepSeek, Mistral, OpenRouter, Groq, Together AI, Cerebras, and other OpenAI-compatible HTTPS APIs.
- **Local:** Ollama, LM Studio, Jan, **LiteLLM**, or any server that speaks OpenAI **Chat Completions** (base URL in settings).

API keys and local base URLs stay in the extension. Requests go from your browser to the provider or localhost, not through a project-hosted backend.

---

## Usage guide

### First-time setup

1. **Install** the extension (see [Installation](#installation)).
2. Click the extension **icon** and open **Options** or use the popup to choose **provider**, **model**, and **API key** (or local base URL).
3. Open **UI settings** from the cog if you want to tune fonts and colors.

### Every lecture

1. Open a recording on **video.ethz.ch**. Wait until the sidebar reports transcript readiness (or use manual paste from the generate panel).
2. Set **Language**, **Block detail**, **Block count**, **Temperature**, and **Thinking** as needed, then **Generate Guide**. Large lectures can take minutes; the status line shows progress.
3. On the **Guide** tab, use **Previous** / **Next** or let **Switch to timeline automatically** follow the video. **Current time** jumps to the block for the playhead.
4. Use **Copy block**, **Copy full blocks**, or **Export** (print to PDF) to take notes offline.
5. On **Q&amp;A**, ask questions. Expand **Course Scripts** to upload PDFs and pick **Fuzzy** or **Semantic** search and **Script reliance**.
6. Optionally enable **Attach current frame** if your model supports vision.
7. Use **History** to return to older guides or export them.

### If something fails

- **No transcript:** Use **paste transcript manually** from the generate area.
- **Images in Q&amp;A:** Confirm the model is **multimodal** and that **Attach current frame** is appropriate.
- **Semantic indexing errors:** Reload the extension after updates; confirm the manifest loads (bundled WASM and CSP). **Fuzzy** search works without embeddings.

---

## Course scripts (PDFs)

- Scripts are **local only** until you send a question: only **retrieved chunks** go into the AI prompt, not the whole PDF each time.
- Prefer **Semantic** when wording in questions differs from the PDF; prefer **Fuzzy** for speed and minimal resource use.
- Seek to a relevant part of the video before asking so the timestamp window matches your intent.

---

## Supported providers and models

Works with most major providers. Configure the popup or options page:

- **Google Gemini** (free tier via [AI Studio](https://aistudio.google.com/app/apikey))
- **OpenAI**, **Anthropic**, **xAI**, **DeepSeek**, **Mistral**
- **OpenRouter**, **Groq**, **Together AI**, **Cerebras**
- **Local** stacks: Ollama, LM Studio, Jan, LiteLLM, or custom OpenAI-compatible URLs

**Suggestions**

- Google AI Studio is an easy way to try the extension on the free tier.
- In testing, **Gemini 2.5 Flash** has worked well for guides, math-heavy courses, and follow-up Q&amp;A.
- **OpenRouter** offers a wide catalog, including some free models; copy the model id from their site into the extension.

**Vision:** For **Attach current frame**, pick a **vision-capable** model. Plain text models may not handle images.

---

## Installation

1. Clone or download: `git clone https://github.com/krol05/eth-lecture-copilot.git`
2. Open `chrome://extensions` in Chrome or another Chromium browser
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `eth-lecture-copilot` folder inside the repo
5. Open a lecture on [video.ethz.ch](https://video.ethz.ch); the sidebar should appear
6. Click the extension icon and set provider, model, and API key (or local URL)

---

## Project structure

```
├── background/           Service worker: AI calls, guide JSON parsing (loads lib/guide-parse.js)
├── content/              Injects sidebar, video layout, transcript hooks
├── sidebar/              Guide UI, Q&A, scripts (PDF, fuzzy + semantic), print export
├── popup/                Quick provider or model entry
├── ui/                   Options and UI settings pages
├── lib/                  Providers config, KaTeX, pdf.js, fuzzy retrieval, guide-parse, Transformers + ONNX
├── tests/                Jest unit tests (pure logic; not __tests__ — Chrome blocks _ prefixes)
├── icons/
├── docs/images/          README screenshots
├── .github/workflows/    CI: run tests on push
├── package.json          Dev-only: npm test (Jest)
└── manifest.json
```

---

## Development and tests

The extension has **no build step** for Chrome. **Jest** is optional and only used for automated checks.

1. `npm install` (once, in the repo root)
2. `npm test`

Tests cover **pure functions** shared or mirrored from runtime code: **guide JSON** repair and parse (`lib/guide-parse.js`), **WebVTT** parsing and **captions URL** discovery (`lib/transcript.js`), **fuzzy chunk retrieval** (`lib/fuzzy-retrieval.js`), and **guide block index** for a timestamp (`lib/block-index.js`). They do **not** call Chrome APIs or the network.

`lib/guide-parse.js` is loaded by the service worker with `importScripts`. `lib/fuzzy-retrieval.js` is loaded in the sidebar before `scripts.js` so script chunking uses the same implementation as the tests.

---

## License

[MIT](LICENSE). You may use, modify, and distribute the extension with attribution; there is no warranty.

---

## Privacy and notes

- **Not affiliated** with ETH Zürich. Personal project.
- **API calls** originate in your browser to the provider or your machine. This project does not operate a server that sees your keys or lecture text.
- **Course scripts** are processed locally; only selected chunks are included in prompts you send to the AI.
- Works in Chrome, Edge, Brave, Arc, and other Chromium browsers that support Manifest V3 extensions.

---

## UI showcase

Deeper look at the rest of the UI: scripts, history, settings, guide options, copy and export, print layout, and navigation.

| **3** · Course scripts | **4** · History |
|:---:|:---:|
| Semantic search, reliance, help | Past lectures, load, PDF, delete |
| <img src="docs/images/03-course-scripts-semantic.png" alt="Course scripts" width="380" /> | <img src="docs/images/04-history-tab.png" alt="History" width="380" /> |

| **5** · UI settings | **6** · Generate guide |
|:---:|:---:|
| Themes, text sizes, colors | Language, blocks, temp, thinking |
| <img src="docs/images/05-ui-settings.png" alt="UI settings" width="380" /> | <img src="docs/images/06-generate-guide.png" alt="Generate guide" width="380" /> |

| **7** · Copy full blocks | **8** · Export PDF |
|:---:|:---:|
| Select sections, copy to clipboard | Toolbar, print dialog, Save as PDF |
| <img src="docs/images/07-copy-full-blocks.png" alt="Copy blocks" width="380" /> | <img src="docs/images/08-export-pdf-tooltip.png" alt="Export PDF" width="380" /> |

| **9** · Print view | **10** · Navigation |
|:---:|:---:|
| Full guide for print or PDF | Block index, current time, auto-follow |
| <img src="docs/images/09-print-guide-page.png" alt="Print view" width="380" /> | <img src="docs/images/10-guide-navigation.png" alt="Navigation" width="380" /> |
