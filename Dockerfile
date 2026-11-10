FROM node:22-bookworm-slim

ENV npm_config_update_notifier=false
WORKDIR /app
RUN chown node:node /app
USER node

# Install dependencies first for better layer caching
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node . .

CMD ["npm", "test"]
