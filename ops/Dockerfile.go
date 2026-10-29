# Multi-stage build of apps/settlement. The build cache is removed in the
# same RUN that creates it: on the 2 GB-disk demo box the go build cache
# alone filled the disk on the first build (ops/README.md).
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
# Static binary; zoneinfo for Asia/Bahrain is embedded via `import _ "time/tzdata"` in main.go.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement \
 && go clean -cache -modcache

FROM alpine:3.20
RUN adduser -D -H -u 10001 settlement
WORKDIR /app
COPY --from=build /out/settlement ./settlement
USER settlement
EXPOSE 8091
CMD ["./settlement", "daemon"]
