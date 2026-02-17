// ---------- tracing.js ----------
// Ce fichier configure OpenTelemetry. Il DOIT etre charge avant l'application
// (via -require dans la commande de demarrage).
// Il installe les "cameras de securite" dans notre batiment avant que
// les employes (le code metier) ne commencent a travailler.
"use strict";
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { Resource } = require("@opentelemetry/resources");
const {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} = require("@opentelemetry/semantic-conventions");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-grpc");
const { PrometheusExporter } = require("@opentelemetry/exporter-prometheus");
const {
  ExpressInstrumentation,
} = require("@opentelemetry/instrumentation-express");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
// ---------- Definir la "ressource" ----------
// La ressource identifie ce service. Chaque trace et chaque metrique
// sera etiquetee avec ces informations. Quand vous avez 50 microservices,
// c'est ca qui vous permet de savoir d'ou vient chaque donnee.
const resource = new Resource({
  [SEMRESATTRS_SERVICE_NAME]: "order-service",
  [SEMRESATTRS_SERVICE_VERSION]: "1.0.0",
  [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: "demo",
});
// ---------- Exporteur de traces ----------
// Envoie les traces au Collector OpenTelemetry via le protocole gRPC.
// Le Collector les renverra ensuite vers Jaeger pour la visualisation.
const traceExporter = new OTLPTraceExporter({
  url: "grpc://otel-collector:4317",
});
// ---------- Exporteur de metriques ----------
// Expose les metriques au format Prometheus sur un endpoint HTTP.
// Prometheus viendra les scraper (modele pull).
// Le port 9464 est le port par defaut du PrometheusExporter OTel.
const prometheusExporter = new PrometheusExporter({
  port: 9464,
});
// ---------- Initialiser le SDK ----------
// Le SDK combine tout : la ressource, les exporteurs, et les
// instrumentations automatiques (Express et HTTP).
const sdk = new NodeSDK({
  resource: resource,
  traceExporter: traceExporter,
  metricReader: prometheusExporter,
  instrumentations: [
    // Auto-instrumentation HTTP : trace automatiquement tous les
    // appels HTTP entrants et sortants. C'est comme installer des
    // cameras a toutes les portes d'entree et de sortie du batiment.
    new HttpInstrumentation(),
    // Auto-instrumentation Express : trace automatiquement les
    // routes et middlewares Express. C'est comme installer des
    // cameras dans chaque couloir du batiment.
    new ExpressInstrumentation(),
  ],
});
// Demarrer le SDK. A partir de ce moment, toutes les requetes HTTP
// et toutes les routes Express seront automatiquement tracees.
// Les traces seront envoyees au Collector OTel, puis a Jaeger.
sdk.start();
// Arreter proprement le SDK quand le processus se termine
// (pour s'assurer que toutes les donnees en attente sont envoyees)
process.on("SIGTERM", () => {
  sdk.shutdown().then(() => process.exit(0));
});
console.log("OpenTelemetry initialise avec succes");
console.log("Traces > OTel Collector > Jaeger (http: /localhost:16686)");
console.log("Metriques > Prometheus scrape sur le port 9464");
