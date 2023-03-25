import lib.ehook
from lib.log import log

import os
import discord
import openai
import logging
import time
import asyncio
import threading
from dotenv import load_dotenv

load_dotenv()

class InterceptHandler(logging.Handler):
	def emit(self, record):
		log(record.levelname, record.msg % tuple(record.args), module=record.name)

class ChatBot:
	def __init__(self, context):
		self.context = context
		self.reset()

	def chat(self, message):
		global logger
		start = time.time()
		self.messages.append({ "role": "user", "content": message })
		log("INFO", f"▼ New message: {message}")
		response = openai.ChatCompletion.create(model="gpt-3.5-turbo", messages=self.messages)
		reply = response.choices[0].message.content.strip()
		log("OKAY", f"▲ ChatGPT response: {reply}")
		self.messages.append({ "role": "assistant", "content": reply })

		self.lastsend = time.time()
		self.runtime = self.lastsend - start
		self.tokens = [response.usage.prompt_tokens, response.usage.completion_tokens, response.usage.total_tokens]

		return reply
	
	def reset(self):
		global logger
		self.messages = [ { "role": "system", "content": self.context } ]
		self.lastsend = time.time()
		log("INFO", f"Context resetted!")

intercept_handler = InterceptHandler()
intercept_handler.setLevel(logging.NOTSET)
intents = discord.Intents.default()
intents.message_content = True

chat = ChatBot(os.environ.get("SYSTEM_ROLE"))
client = discord.Client(intents=intents)
openai.api_key = os.environ.get("OPENAI_API_KEY")
reset_idle_time = int(os.environ.get("RESET_AFTER_IDLE"))

def check_idle():
	global chat
	reset_idle_time = int(os.environ.get("RESET_AFTER_IDLE"))

	while True:
		if (len(chat.messages) > 1 and time.time() - chat.lastsend > reset_idle_time):
			chat.reset()

		time.sleep(2)

@client.event
async def on_ready():
	global logger
	log("INFO", f"{client.user} has connected to Discord!")
	check_idle_thread = threading.Thread(target=check_idle)
	check_idle_thread.start()

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
		reply = await asyncio.to_thread(chat.chat, message.clean_content.strip())
		reply += f"\n\n> `🕒 {chat.runtime:.2f}s // 💸 {'/'.join(map(str, chat.tokens))} (p/c/U) // 🔮 {len(chat.messages)} contexts`"

	await message.channel.send(reply, mention_author=False, reference=message)

client.run(os.getenv("DISCORD_TOKEN"), log_handler=intercept_handler)
