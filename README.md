# ETH Lecture Copilot

<p align="center"><strong>Chrome extension</strong> — AI study guides &amp; Q&amp;A for ETH Zürich lectures on <a href="https://video.ethz.ch">video.ethz.ch</a> (transcript sync, KaTeX, optional frame context).</p>

A Chrome extension that turns ETH Zürich lecture recordings into structured study guides using AI. It sits as a sidebar next to the video on [video.ethz.ch](https://video.ethz.ch) and generates a topic-by-topic breakdown of the lecture — synced to the current timestamp as you watch.

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <strong>Guide + lecture</strong><br />
      <sub>Structured guide (concepts, definitions, formulas) stays aligned with playback.</sub><br /><br />
      <img src="docs/images/readme-01-guide.png" alt="Lecture video with Copilot sidebar showing the Guide tab" width="100%" />
    </td>
    <td align="center" width="50%">
      <strong>Q&amp;A with frame attached</strong><br />
      <sub>The <strong>second</strong> image is the Q&amp;A tab: the model answered using <strong>Attach current frame</strong> so the slide is included as context.</sub><br /><br />
      <img src="docs/images/readme-02-qa-frame.png" alt="Q&amp;A chat with Attach current frame enabled and frame attached" width="100%" />
    </td>
  </tr>
  <tr>
    <td colspan="2" align="center">
      <br /><strong>Settings</strong><br />
      <sub>Choose provider, model, and API key -everything stays in your browser.</sub><br /><br />
      <img src="docs/images/readme-03-settings.png" alt="ETH Lecture Copilot extension settings popup" width="85%" style="max-width: 520px;" />
    </td>
  </tr>
</table>

## What it does

- **Auto-extracts the transcript** from ETH lecture pages (or lets you paste one manually)
- **Generates a study guide** with key concepts, definitions, formulas (rendered with KaTeX), and notes -organized by topic, not fixed time chunks
- **Syncs to playback** -the guide highlights the section matching where you are in the video
- **Q&A chat** -ask follow-up questions about the lecture with the full transcript + guide as context; optionally attach the current video frame
- **History** -keeps track of previously generated guides so you can revisit them
- **Keyboard shortcuts** -Arrow Up/Down to adjust playback speed

## Supported AI providers

Works with pretty much any major provider. Just pick one in the popup, paste your API key, and you're set:

- Google Gemini (free tier available via [AI Studio](https://aistudio.google.com/app/apikey))
- OpenAI, Anthropic, xAI, DeepSeek, Mistral
- OpenRouter, Groq, Together AI, Cerebras
- Local models (Ollama, LM Studio, Jan, or any OpenAI-compatible server)

### Suggested providers and models

- **[Google AI Studio](https://aistudio.google.com/app/apikey)** is a practical default: the free tier includes a **generous daily allowance** of API requests for trying the extension without cost.
- In our own experiments with this project, **Gemini 2.5 Flash** has performed **best overall** for guide quality, math-heavy lectures, and follow-up Q&A.
- **[OpenRouter](https://openrouter.ai/)** is another strong option if you want a **broad catalog of models**, including several **free** endpoints -pick a model on their site and paste its ID into the extension.

**Multimodal models and “Attach current frame”:** **Not all models are multimodal.** The **Attach current frame** control in Q&A sends an **image** of the current video frame to the model. That only works reliably with **vision-capable** models (many Gemini and other multimodal APIs). If you choose a **text-only** model, frame attachment may be ignored, fail, or behave inconsistently -**frame capture is limited by whichever model you use.**

## Installation

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome (or any Chromium browser)
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the repo folder
5. Navigate to any lecture on [video.ethz.ch](https://video.ethz.ch) -the sidebar appears automatically
6. Click the extension icon in the toolbar to set your AI provider and API key

## Usage

1. Open a lecture on video.ethz.ch
2. The extension detects the transcript automatically
3. Click **Generate Guide** in the sidebar
4. Browse the guide while watching -it follows along with the video
5. Switch to the **Q&A** tab to ask questions about the material

If automatic transcript detection doesn't work for a particular lecture, you can always paste the transcript manually.

## Project structure

```
├── background/        Service worker -proxies AI API calls
├── content/           Content script + CSS injected into video.ethz.ch
├── sidebar/           Sidebar UI (HTML/CSS/JS, runs in an iframe)
├── popup/             Extension popup for settings
├── lib/               Shared config (providers, KaTeX)
├── icons/             Extension icons
├── docs/images/       README screenshots
├── .github/           REPO_DESCRIPTION.txt — one-line blurb for GitHub About
└── manifest.json
```

## Notes

- This is a personal project built for my own use during ETH lectures. It's not affiliated with ETH Zürich.
- API calls go directly from the extension to the provider -nothing passes through any third-party server.
- Works on Chrome, Edge, Brave, Arc, and other Chromium-based browsers.
