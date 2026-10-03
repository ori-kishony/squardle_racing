FROM node:24-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Persistent volume mount point (Render disk / Fly volume -> /data)
RUN mkdir -p /data
ENV NODE_ENV=production
ENV DB_PATH=/data/squardle_racing.sqlite3
ENV OFFICIAL_TODAY_PATH=/data/official-today.json

EXPOSE 3000
CMD ["node", "src/server.js"]
