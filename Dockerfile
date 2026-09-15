# ---- build stage -------------------------------------------------------------
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run scripts/build.ts

# ---- runtime stage -----------------------------------------------------------
FROM oven/bun:1.4.2
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
USER bun
EXPOSE 7777
CMD ["bun", "run", "dist/server.js"]
