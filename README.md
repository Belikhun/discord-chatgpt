# ChatGPT Discord Bot

![image](https://github.com/user-attachments/assets/3d2dab83-708e-49fa-900f-f5f1a7909569)

A very simple discord bot that reply to user's message, with long response support and image generation!. **⚠ Currently it will listen on all channels it can access so be aware!**

## 🛠 Setting up

1. Clone this repository
2. Copy `env.example.json` file to `env.json`
3. Fill in your Discord token and your provider's API key (`PROVIDERS.openai.API_KEY`)
4. Install [Bun](https://bun.sh) if you don't have it yet
5. Install requirements by running `bun install`
6. Start the app by running `bun start`
7. Profit!

## 🧠 AI providers

**OpenAI** and **Google Gemini** are both supported. Providers are configured per entry under `PROVIDERS` in `env.json`, keyed by provider ID. Only the providers listed there are loaded, so the block doubles as the enable switch for each one:

```json
"PROVIDERS": {
    "openai": {
        "API_KEY": "sk-...",
        "BASE_URL": ""
    },
    "gemini": {
        "API_KEY": "AIza..."
    }
},
"PROVIDER_DEFAULT": "openai"
```

`API_KEY` is the only required field. `BASE_URL` (proxies, gateways, compatible endpoints), `ORGANIZATION` and `PROJECT` are optional and only sent when non-empty — leave them out to keep the SDK's defaults. Drop a provider's entry to disable it.

`PROVIDER_DEFAULT` picks who serves models that no provider claims; when omitted, the provider offering `MODEL_DEFAULT` wins, else the first one configured. Models are routed to their owning provider automatically just by picking one with `/model` or `/b`.

Because the combined catalogue is larger than the 25 choices Discord allows on an option, the `model` option is **autocompleted** — start typing (`gemini`, `gpt-5`, `flash`) and matching models are suggested.

### Model traits

Each model in a provider's catalogue declares what it can do, and features are gated by asking for a trait rather than matching model names:

| Trait | Meaning |
|---|---|
| `Thinking` | reasons internally and can report a thought summary |
| `FunctionCalling` | accepts the bot's tool declarations |
| `WebSearch` | has a provider-side search/grounding tool |
| `ViewImage` / `ViewVideo` / `AnalyzeAudio` / `ReadDocument` | accepted input modalities |
| `GenerateImage` / `GenerateAudio` / `GenerateVideo` | generated output modalities |

Traits drive real behaviour: reasoning effort is only sent to `Thinking` models, built-in search and image tools are only attached where supported, and Gemini's image models get the function declarations withheld (they reject them) so they still work while the bot offers its full tool set. The `/model` picker shows them as badges — 🧠 thinking, 🌐 search, 🎨 image gen, 👁 vision, 🎧 audio, 📹 video.

Models missing from a catalogue (a hand-written `MODEL_DEFAULT`, or one released after this list) get traits inferred from their name, so they keep working.

### Provider notes

| | OpenAI | Gemini |
|---|---|---|
| Thinking | `o*` and `gpt-5.*` | every listed model |
| Web search | built-in `web_search_preview` tool | Google Search grounding, only when no function tools are in play (Gemini forbids combining them) |
| Image generation | `image_generation` tool | the "Nano Banana" `*-image` models return pictures directly |
| Vision input | image URLs are passed through | images are downloaded and inlined, since Gemini cannot read arbitrary URLs |

Gemini 2.5 models are deliberately not listed: the API rejects them for keys created after their retirement. The Pro and image models require a billed Gemini key — a free key gets `RESOURCE_EXHAUSTED` for those.

## 👤 Personal app (user install)

The bot can also be installed as a **personal app** on your user account, making it usable in bot DMs, group DMs and servers where the bot itself isn't a member:

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open your app → **Installation** and enable the **User Install** installation context.
2. Install the app to your account using the provided install link.
3. Use the `/b` command anywhere:
   - `/b message:<your question>` — ask the assistant and get a streamed reply.
   - `model` (optional) — override the model for this conversation.
   - `thinking` (optional) — set the reasoning effort for reasoning-capable models.

`/clear` is also available in DM/private contexts to reset the conversation history. Conversation context is kept per channel, so follow-up `/b` calls continue the same conversation.

## 🚢 Using docker

Simply run `docker compose up` inside project folder to get thing running!

---

<sup><code>✨ discord-chatgpt by Belikhun</code></sup>
