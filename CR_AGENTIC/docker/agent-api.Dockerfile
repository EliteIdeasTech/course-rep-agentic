FROM node:20-bookworm-slim AS builder

ARG CACHEBUST=20260913-cred-autostart
RUN echo "cachebust=$CACHEBUST"
WORKDIR /app
COPY package.json yarn.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps/agent-api ./apps/agent-api
RUN corepack enable && yarn install --frozen-lockfile || yarn install
RUN yarn workspace @cr-agentic/database prisma:generate \
  && yarn build:packages \
  && yarn workspace @cr-agentic/agent-api build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
EXPOSE 3100
CMD ["node", "apps/agent-api/dist/main.js"]
