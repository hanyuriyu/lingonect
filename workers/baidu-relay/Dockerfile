# Minimal image for the Baidu relay — one file, no dependencies, no build step.
FROM node:22-alpine

WORKDIR /app
COPY server.js ./

USER node
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
