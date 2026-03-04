FROM node:20-alpine
RUN corepack enable && npm install -g tsx
WORKDIR /app
COPY monitor.ts .
CMD ["tsx", "monitor.ts"]
