FROM node:22-bookworm-slim AS plugin-build
WORKDIR /plugin
COPY grafana-plugin/pedro-limofleetcontrol-panel/package*.json ./
RUN npm ci --ignore-scripts=false --no-audit --no-fund
COPY grafana-plugin/pedro-limofleetcontrol-panel/ ./
RUN npm run build

FROM grafana/grafana:13.3.0
USER root
COPY --from=plugin-build /plugin/dist/ /var/lib/grafana/plugins/pedro-limofleetcontrol-panel/
ENV GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=pedro-limofleetcontrol-panel
USER grafana
