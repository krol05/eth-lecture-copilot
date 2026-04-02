# ETH Lecture Copilot

A Chrome extension that turns ETH Zürich lecture recordings into structured study guides using AI. It sits as a sidebar next to the video on [video.ethz.ch](https://video.ethz.ch) and generates a topic-by-topic breakdown of the lecture — synced to the current timestamp as you watch.

## What it does

- **Auto-extracts the transcript** from ETH lecture pages (or lets you paste one manually)
- **Generates a study guide** with key concepts, definitions, formulas (rendered with KaTeX), and notes — organized by topic, not fixed time chunks
- **Syncs to playback** — the guide highlights the section matching where you are in the video
- **Q&A chat** — ask follow-up questions about the lecture with the full transcript + guide as context; optionally attach the current video frame
- **History** — keeps track of previously generated guides so you can revisit them
- **Keyboard shortcuts** — Arrow Up/Down to adjust playback speed

## Supported AI providers

Works with pretty much any major provider. Just pick one in the popup, paste your API key, and you're set:

- Google Gemini (free tier available via [AI Studio](https://aistudio.google.com/app/apikey))
- OpenAI, Anthropic, xAI, DeepSeek, Mistral
- OpenRouter, Groq, Together AI, Cerebras
- Local models (Ollama, LM Studio, Jan, or any OpenAI-compatible server)

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome (or any Chromium browser)
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder
5. Navigate to any lecture on [video.ethz.ch](https://video.ethz.ch) — the sidebar appears automatically
6. Click the extension icon in the toolbar to set your AI provider and API key

## Usage

1. Open a lecture on video.ethz.ch
2. The extension detects the transcript automatically
3. Click **Generate Guide** in the sidebar
4. Browse the guide while watching — it follows along with the video
5. Switch to the **Q&A** tab to ask questions about the material

If automatic transcript detection doesn't work for a particular lecture, you can always paste the transcript manually.

## Project structure

```
├── background/        Service worker — proxies AI API calls
├── content/           Content script + CSS injected into video.ethz.ch
├── sidebar/           Sidebar UI (HTML/CSS/JS, runs in an iframe)
├── popup/             Extension popup for settings
├── lib/               Shared config (providers, KaTeX)
├── icons/             Extension icons
└── manifest.json
```

## Notes

- This is a personal project built for my own use during ETH lectures. It's not affiliated with ETH Zürich.
- API calls go directly from the extension to the provider — nothing passes through any third-party server.
- Works on Chrome, Edge, Brave, Arc, and other Chromium-based browsers.
