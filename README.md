# ChatGPT Discord Bot

![image](https://github.com/user-attachments/assets/3d2dab83-708e-49fa-900f-f5f1a7909569)

A very simple discord bot that reply to user's message, with long response support and image generation!. **⚠ Currently it will listen on all channels it can access so be aware!**

## 🛠 Setting up

1. Clone this repository
2. Copy `env.example.json` file to `env.json`
3. Fill in your OpenAI API key and Discord token
4. Install [Bun](https://bun.sh) if you don't have it yet
5. Install requirements by running `bun install`
6. Start the app by running `bun start`
7. Profit!

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
