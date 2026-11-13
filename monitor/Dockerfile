FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH=amd64
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /monitor-server ./cmd/server
RUN mkdir /data && chown 65532:65532 /data
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /monitor-server /monitor-server
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
EXPOSE 18088
VOLUME ["/data"]
ENTRYPOINT ["/monitor-server"]
CMD ["-listen", "0.0.0.0:18088", "-data", "/data/monitor.db"]
