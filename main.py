import os
import discord
import openai
import logging
import time
import asyncio
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)
log.setLevel(logging.INFO)
intents = discord.Intents.default()
intents.message_content = True

class ChatBot:
	def __init__(self, message):
		self.messages = [ { "role": "system", "content": message } ]
		self.initial = self.messages

	def chat(self, message):
		start = time.time()
		self.messages.append({ "role": "user", "content": message })
		log.info(f"▼ New message: {message}")
		response = openai.ChatCompletion.create(model="gpt-3.5-turbo", messages=self.messages)
		reply = response.choices[0].message.content.strip()
		log.info(f"▲ ChatGPT response: {reply}")
		self.messages.append({ "role": "assistant", "content": reply })

		self.runtime = time.time() - start
		self.tokens = [response.usage.prompt_tokens, response.usage.completion_tokens, response.usage.total_tokens]

		return reply
	
	def reset(self):
		log.info(f"Cleared context!")
		self.messages = self.initial

chat = ChatBot(os.environ.get("SYSTEM_ROLE"))
client = discord.Client(intents=intents, logging=log)
openai.api_key = os.environ.get("OPENAI_API_KEY")

@client.event
async def on_ready():
	print(f"{client.user} has connected to Discord!")

@client.event
async def on_message(message: discord.Message):
	global chat
	
	if message.author == client.user or message.author.bot:
		return

	if (len(message.content) < 2):
		await message.channel.send("> :warning:  Tin nhắn quá ngắn!", mention_author=False, reference=message)
		return

	if (message.content.startswith("*clear context") or message.content.startswith("*clear history")):
		chat.reset()
		await message.channel.send("> :white_check_mark:  Đã loại bỏ lịch sử chat!", mention_author=False, reference=message)
		return
	
	if (len(message.content.split(" ")) < 3):
		chat.reset()

	async with message.channel.typing():
		reply = await asyncio.to_thread(chat.chat, message.content.strip())
		reply += f"\n\n> `🕒 {chat.runtime:.2f}s // 💸 {'/'.join(map(str, chat.tokens))} (p/c/U) // 🔮 {len(chat.messages)} contexts`"

	await message.channel.send(reply, mention_author=False, reference=message)

client.run(os.getenv("DISCORD_TOKEN"))