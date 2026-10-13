# Frontend (Create React App) production image.
#
# CRA only reads REACT_APP_* env vars at BUILD time, not at container
# start time (see .env.example's own comment on this) -- so each of
# them is accepted as a build arg here and must be supplied via
# `docker build --build-arg` or docker-compose's `args:`, not as a
# runtime environment variable. The built static files are then served
# by a plain nginx image; no Node process needed at runtime.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY . .

ARG REACT_APP_API_URL
ARG REACT_APP_BACKEND_URL
ARG REACT_APP_FIREBASE_API_KEY
ARG REACT_APP_FIREBASE_AUTH_DOMAIN
ARG REACT_APP_FIREBASE_PROJECT_ID
ARG REACT_APP_FIREBASE_STORAGE_BUCKET
ARG REACT_APP_FIREBASE_MESSAGING_SENDER_ID
ARG REACT_APP_FIREBASE_APP_ID
ARG REACT_APP_FIREBASE_MEASUREMENT_ID
ENV REACT_APP_API_URL=$REACT_APP_API_URL \
    REACT_APP_BACKEND_URL=$REACT_APP_BACKEND_URL \
    REACT_APP_FIREBASE_API_KEY=$REACT_APP_FIREBASE_API_KEY \
    REACT_APP_FIREBASE_AUTH_DOMAIN=$REACT_APP_FIREBASE_AUTH_DOMAIN \
    REACT_APP_FIREBASE_PROJECT_ID=$REACT_APP_FIREBASE_PROJECT_ID \
    REACT_APP_FIREBASE_STORAGE_BUCKET=$REACT_APP_FIREBASE_STORAGE_BUCKET \
    REACT_APP_FIREBASE_MESSAGING_SENDER_ID=$REACT_APP_FIREBASE_MESSAGING_SENDER_ID \
    REACT_APP_FIREBASE_APP_ID=$REACT_APP_FIREBASE_APP_ID \
    REACT_APP_FIREBASE_MEASUREMENT_ID=$REACT_APP_FIREBASE_MEASUREMENT_ID

RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
