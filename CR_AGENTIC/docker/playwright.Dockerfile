FROM mcr.microsoft.com/playwright:v1.61.0-noble AS builder

# Bump to force rebuild when BuildKit cache ignores app source edits
ARG CACHEBUST=20260913-view-drill
RUN echo "cachebust=$CACHEBUST"
WORKDIR /app
COPY package.json yarn.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps/browser-worker ./apps/browser-worker
RUN corepack enable && yarn install || true
RUN yarn workspace @cr-agentic/database prisma:generate \
  && yarn build:packages \
  && yarn workspace @cr-agentic/browser-worker build

FROM mcr.microsoft.com/playwright:v1.61.0-noble
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
CMD ["node", "apps/browser-worker/dist/worker.js"]
