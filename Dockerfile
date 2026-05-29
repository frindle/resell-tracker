FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Native deps (better-sqlite3) need build tools
RUN apk add --no-cache python3 make g++

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/app/generated ./app/generated

RUN npm ci --omit=dev

EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
