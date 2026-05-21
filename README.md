# ETH Lecture Copilot

<p>
  <img src="icons/icon128.png" alt="ETH Lecture Copilot icon" width="72" align="left" />
  <strong>A Chrome extension for turning ETH Zurich lecture recordings into study guides, Q&A, flashcards, quizzes, and exam prep.</strong>
</p>

ETH Lecture Copilot adds a sidebar to [video.ethz.ch](https://video.ethz.ch). It reads the lecture transcript, keeps generated material tied to the timeline, and sends requests from your browser to the AI provider or local model you choose.

<br clear="left" />

> [!NOTE]
> This is a personal project and is not affiliated with ETH Zurich.

## Showcase

Start with the animated walkthrough if you want the quick version. For sharper playback, open the MP4 below it.

<p align="center">
  <a href="docs/showcase/eth-lecture-copilot-showcase.mp4">
    <img src="docs/showcase/eth-lecture-copilot-showcase.gif" alt="ETH Lecture Copilot animated showcase" width="760" />
  </a>
</p>

<p align="center">
  <a href="docs/showcase/eth-lecture-copilot-showcase.mp4"><strong>Open the full-quality MP4 walkthrough</strong></a>
</p>

## What It Does

ETH Lecture Copilot is for long recorded lectures where the transcript exists, but the usable study material still has to be made. Open a recording, configure your model, generate a guide, then use that guide as the base for questions, PDFs, flashcards, quizzes, summaries, and exam practice.

The extension has no hosted project backend. API keys, local endpoints, saved guides, UI settings, and PDF indexes live in browser storage. When you ask the model something, the browser calls the provider or localhost directly.

## Main Features

### Time-Synced Study Guides

- Extracts ETH lecture captions automatically when available.
- Has manual transcript paste when automatic extraction is not enough.
- Generates a structured guide with time ranges, key concepts, formulas, definitions, and notes.
- Renders math with KaTeX.
- Auto-follows playback or jumps to the block for the current video time.
- Includes previous and next block navigation, direct block jumping, and copy controls.
- Exports guides to print-ready PDF pages.
- Saves completed guides in history for later.

### Guide Generation Controls

- Language choice: same as transcript, presets, or a custom language name.
- Block detail and block count controls for short overviews or dense notes.
- Temperature control.
- Thinking or reasoning controls where the selected provider supports them.
- Safe defaults for a conservative first run.
- Status updates while the transcript and guide are being prepared.

### Lecture Q&A

- Answers questions using the transcript and generated guide.
- Keeps user and assistant messages visually separate.
- Handles multiple chat threads.
- Can include the current guide block and nearby transcript context.
- Can attach the current video frame for vision-capable models.
- Shows the attached frame before sending, so you know what the model will see.
- Streams answers when the provider path allows it.
- Uses temperature, thinking, response depth, and prompt settings to adjust answer style.

### Course Scripts and PDF Retrieval

- Uploads course PDFs from the sidebar.
- Extracts text in the browser with pdf.js.
- Stores scripts per course in IndexedDB.
- Splits PDFs into searchable chunks.
- Fuzzy search gives fast text matching.
- Semantic search uses local Transformers.js embeddings.
- Script reliance can be light, medium, high, or strict.
- Sends only selected excerpts to the AI prompt, not entire PDFs.

### Study Tools

- Generates Anki-style flashcards from the active guide.
- Supports recall, definition, and mixed card styles.
- Can include formula cards.
- Lets you remove generated cards before export.
- Exports flashcards as TSV.
- Sends cards directly to Anki.
- Generates practice quizzes with multiple-choice, short-answer, or mixed formats.
- Generates exam-style questions from the whole guide or selected blocks.
- Creates lecture summaries for revision.
- Predicts cross-lecture exam topics from saved guides in history.
- Adds "ask about this" actions to generated study items.

### History, Export, and Course Memory

- Groups saved guides by recent lectures and course collections.
- Loads previous guides back into the sidebar.
- Exports saved guides as PDFs.
- Deletes entries with undo support.
- Uses history as source material for cross-lecture exam prediction.
- Keeps guide data tied to the lecture URL and course grouping.

### Provider and Model Support

Use the popup to configure providers, models, keys, and local endpoints.

Cloud providers include:

- Anthropic
- OpenAI
- Google Gemini
- xAI
- DeepSeek
- Mistral
- OpenRouter
- Groq
- Together AI
- Cerebras
- NVIDIA NIM
- Fireworks AI
- Perplexity
- Cohere
- HuggingFace
- Hyperbolic
- SambaNova
- Moonshot / Kimi
- Zhipu AI / Z.ai
- Qwen / Alibaba DashScope

Local and OpenAI-compatible setups include:

- Ollama
- LM Studio
- vLLM
- Jan
- LiteLLM
- KoboldCpp
- GPT4All
- Text Generation WebUI
- Hugging Face TGI
- Custom OpenAI-compatible base URLs

Local providers can detect installed models through the local server's model endpoint when available.

### UI and Prompt Customization

- Dark, light, navy, and clean white themes.
- Adjustable sidebar text sizes.
- Editable color tokens with live preview.
- Restore-defaults controls.
- Custom prompt add-ons for guide generation, Q&A, flashcards, quizzes, and exam questions.
- Sidebar collapse, resizing, focus mode, and fullscreen handling.
- Keyboard playback speed shortcuts in 0.25x steps.

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/krol05/eth-lecture-copilot.git
   ```

2. Open `chrome://extensions` in Chrome or another Chromium browser.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the repository folder.
6. Open a lecture on [video.ethz.ch](https://video.ethz.ch).
7. Click the extension icon and configure your provider, model, and API key or local endpoint.

The extension has no build step for normal use.

## Typical Workflow

1. Open a lecture recording on `video.ethz.ch`.
2. Wait for the sidebar status to show that the transcript is ready.
3. Choose guide settings and click **Generate Guide**.
4. Use the guide while watching, with auto-follow on or off.
5. Ask follow-up questions in Q&A.
6. Add course scripts if the answer should use PDFs.
7. Generate flashcards, quizzes, summaries, or exam questions from the finished guide.
8. Reopen old guides from History when revising later.

## Privacy Model

- API keys are stored in browser extension storage.
- Requests go from your browser to the selected provider or local endpoint.
- The project does not run a hosted backend for your lecture text or keys.
- Uploaded PDFs are parsed and indexed locally.
- Q&A sends only the transcript, guide context, selected script chunks, and optional frame images needed for that request.
- Semantic script search runs with local Transformers.js and ONNX WebAssembly. The embedding model may be downloaded once and cached by the browser.

> [!WARNING]
> Any text, PDF excerpt, or frame image included in a prompt is sent to the AI provider you configured. Use a local model if the material should not leave your machine.

## Development

Install dev dependencies only if you want to run tests:

```bash
npm install
npm test
```

The Chrome extension itself is plain Manifest V3 JavaScript, HTML, and CSS. Jest covers pure logic such as transcript parsing, guide parsing, fuzzy retrieval, and block lookup. Tests do not call Chrome APIs or external providers.

## Project Structure

```text
background/        Service worker and AI provider calls
content/           Sidebar injection, transcript extraction, video integration
sidebar/           Guide, Q&A, tools, history, scripts, print pages
popup/             Provider, model, key, and local endpoint setup
ui/                Theme, typography, color, and prompt settings
lib/               Shared provider config, prompts, parsers, KaTeX, pdf.js, retrieval
tests/             Jest tests for pure logic
icons/             Extension icons
docs/showcase/     Remotion video and README showcase frames
manifest.json      Chrome Manifest V3 configuration
```

## Notes and Limitations

- The extension targets ETH Zurich's `video.ethz.ch`.
- Captions must be available, or you need to paste a transcript manually.
- Vision features require a model that can accept images.
- Semantic PDF indexing can take a while on the first run for a large script.
- Very strict script reliance can use many tokens on smaller-context models.
- Provider model availability depends on your own account and API access.
