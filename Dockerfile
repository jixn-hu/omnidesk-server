FROM golang:1.26-alpine AS monitor
WORKDIR /src
COPY monitor/go.mod monitor/go.sum ./
ARG GOPROXY=https://proxy.golang.org,direct
RUN GOPROXY=$GOPROXY go mod download
COPY monitor/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /omnidesk-monitor-server ./cmd/server
RUN CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /omnidesk-monitor-agent-windows-amd64.exe ./cmd/agent
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node *.mjs ./
COPY --chown=node:node shared ./shared
COPY --chown=node:node public ./public
COPY --chown=node:node tools ./tools
COPY --from=monitor /omnidesk-monitor-server ./omnidesk-monitor-server
COPY --from=monitor --chmod=0444 /omnidesk-monitor-agent-windows-amd64.exe ./monitor-agent/
COPY --chmod=0444 assets/monitor-agent/install-windows.ps1 ./monitor-agent/
ENV OMNIDESK_WINDOWS_AGENT_DIR=/app/monitor-agent
RUN mkdir -p /data/account /data/monitor && chown -R node:node /data
USER node
ENV OFFICIAL_HOST=0.0.0.0 OFFICIAL_PORT=47830 OMNIDESK_CLOUD_DATA=/data OFFICIAL_DATA_DIR=/data/account
EXPOSE 47830
CMD ["node","cloud.mjs"]
