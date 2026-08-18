FROM oven/bun:1

ENV TZ="Asia/Ho_Chi_Minh"

# set our node environment, either development or production
# defaults to production, compose overrides this to development on build and run
ARG NODE_ENV=production

# the official bun image provides an unprivileged user as a security best practice
# but we have to manually enable it. We put it here so bun installs dependencies as the same
# user who runs the app.
USER bun

# install dependencies first, in a different location for easier app bind mounting for local development
# WORKDIR now sets correct permissions if you set USER first
WORKDIR /usr/src/app
COPY package.json bun.lock* ./
RUN bun install
COPY . .

CMD [ "bun", "start" ]
