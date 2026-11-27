# Collaboration server image. Build from the repository root:
#   docker build -f deploy/Dockerfile -t ds04-server .
FROM oven/bun:1.3.6-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN mkdir -p /data && chown bun:bun /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/ds04.sqlite
VOLUME /data
EXPOSE 3000
USER bun
CMD ["bun", "src/server/main.ts"]
