FROM node:22-alpine AS builder
WORKDIR /app

# Native deps (better-sqlite3) need build tools at install time
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy standalone server (bundles most JS deps into node_modules/)
COPY --from=builder /app/.next/standalone ./
# Overwrite with the full builder node_modules so native binaries
# (better-sqlite3, bcryptjs, etc.) are the correctly-compiled versions
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/app/generated ./app/generated

EXPOSE 3000
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node server.js"]
