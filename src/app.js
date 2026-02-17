// ---------- app.js ----------
// Application Express instrumentee avec OpenTelemetry.
// Simule un service de gestion de commandes.
// Les traces sont envoyees a Jaeger via le Collector OTel.
"use strict";
const express = require("express");
const pino = require("pino");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");
// ---------- Logger structure ----------
// On utilise Pino, un logger JSON performant pour Node.js.
// En production, les logs doivent TOUJOURS etre structures (JSON),
// jamais du texte libre. C'est la difference entre :
// Mauvais : console.log("Erreur paiement user " + userId)
// Bon : logger.error({ userId, orderId, error }, "Payment failed")
const logger = pino({
  level: "info",
  // Ajouter le nom du service dans chaque log
  base: { service: "order-service" },
});
// ---------- Tracer et Meter ----------
// Le tracer sert a creer des spans (traces manuelles).
// Chaque span cree ici apparaitra dans Jaeger comme une etape
// du parcours de la requete.
// Le meter sert a creer des metriques custom.
const tracer = trace.getTracer("order-service");
const meter = metrics.getMeter("order-service");
// ---------- Metriques custom ----------
// Counter : nombre total de commandes creees.
// Un counter ne fait que monter (comme un compteur de pas).
const ordersCreated = meter.createCounter("orders_created_total", {
  description: "Nombre total de commandes creees",
  unit: "1",
});
// Histogram : temps de traitement des commandes.
// Mesure la distribution des durees (comme les temps au km d'un coureur).
const orderProcessingTime = meter.createHistogram(
  "order_processing_duration_seconds",
  {
    description: "Temps de traitement d une commande en secondes",
    unit: "s",
  },
);
// UpDownCounter (equivalent d'un gauge) : nombre de commandes en cours.
// Peut monter ET descendre (comme la frequence cardiaque).
const ordersInProgress = meter.createUpDownCounter("orders_in_progress", {
  description: "Nombre de commandes en cours de traitement",
  unit: "1",
});
// ---------- Application Express ----------
const app = express();
app.use(express.json());
// ---------- Simulation de base de donnees ----------
const ordersDb = {};
/**
 * Simule une requete de base de donnees avec un span trace.
 * En production, ce serait un vrai appel a PostgreSQL, MongoDB, etc.
 * Le span cree ici apparaitra dans Jaeger comme un enfant du span parent.
 */
function simulateDbQuery(queryType, durationRange = [10, 50]) {
  return new Promise((resolve) => {
    tracer.startActiveSpan(`db.${queryType}`, (span) => {
      span.setAttribute("db.system", "postgresql");
      span.setAttribute("db.operation", queryType);
      // Simuler la latence de la BDD (entre durationRange[0] et durationRange[1]
      const delay =
        Math.random() * (durationRange[1] - durationRange[0]) +
        durationRange[0];
      setTimeout(() => {
        span.end();
        resolve();
      }, delay);
    });
  });
}
/**
 * Simule un appel au service de paiement.
 * 10% du temps, le paiement est lent (simule un probleme externe).
 * 5% du temps, le paiement echoue.
 * Dans Jaeger, vous verrez ces cas clairement :
 * - Les paiements lents auront un span beaucoup plus long
 * - Les paiements en echec auront un span marque en rouge (ERROR)
 */
function simulatePaymentProcessing(orderId, amount) {
  return new Promise((resolve, reject) => {
    tracer.startActiveSpan("payment.process", (span) => {
      span.setAttribute("payment.order_id", orderId);
      span.setAttribute("payment.amount", amount);
      // 10% de chance que ce soit lent (simule un probleme)
      const isSlow = Math.random() < 0.1;
      const delay = isSlow
        ? Math.random() * 2000 + 1000 // Entre 1s et 3s (lent)
        : Math.random() * 150 + 50; //Entre 50ms et 200ms (normal)
      if (isSlow) {
        span.setAttribute("payment.slow", true);
        logger.warn(
          { orderId, delay: Math.round(delay) },
          "Paiement lent pour commande",
        );
      }
      setTimeout(() => {
        // 5% de chance d'echec
        if (Math.random() < 0.05) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Payment declined",
          });
          span.end();
          reject(new Error("Payment declined"));
        } else {
          span.end();
          resolve();
        }
      }, delay);
    });
  });
}
// ---------- Endpoints ----------
app.get("/health", (req, res) => {
  res.json({ status: "healthy" });
});
app.post("/orders", async (req, res) => {
  const startTime = Date.now();
  ordersInProgress.add(1);
  try {
    // Span manuel pour la logique metier.
    // Ce span englobera toutes les etapes de creation de commande.
    // C'est comme une camera qui filme tout le processus du debut a la fin.
    // Dans Jaeger, ce span sera le parent de tous les spans enfants.
    await tracer.startActiveSpan("create_order", async (span) => {
      const orderId = String(Math.floor(Math.random() * 90000) + 10000);
      const amount = Math.round((Math.random() * 490 + 10) * 100) / 100;
      // Les attributs ajoutent du contexte consultable dans Jaeger.
      // Quand vous cherchez "pourquoi cette commande a echoue ?",
      // ces attributs vous donnent la reponse sans lire les logs.
      span.setAttribute("order.id", orderId);
      span.setAttribute("order.amount", amount);
      // Etape 1 : verifier le stock
      await simulateDbQuery("check_inventory");
      // Etape 2 : creer la commande en BDD
      await simulateDbQuery("insert_order");
      // Etape 3 : traiter le paiement
      await simulatePaymentProcessing(orderId, amount);
      // Etape 4 : confirmer la commande
      await simulateDbQuery("update_order_status");
      ordersDb[orderId] = {
        id: orderId,
        amount: amount,
        status: "confirmed",
      };
      // Enregistrer la metrique (compteur de commandes reussies)
      ordersCreated.add(1, { status: "success" });
      // Log structure : chaque champ est un champ JSON indexable
      logger.info(
        { orderId, amount, status: "confirmed" },
        "Commande creee avec succes",
      );
      span.end();
      res.status(201).json(ordersDb[orderId]);
    });
  } catch (err) {
    ordersCreated.add(1, { status: "error" });
    logger.error(
      { error: err.message, stack: err.stack },
      "Erreur lors de la creation de commande",
    );
    res.status(500).json({ error: err.message });
  } finally {
    ordersInProgress.add(-1);
    const duration = (Date.now() - startTime) / 1000; // Convertir ms en secondes
    orderProcessingTime.record(duration);
  }
});
app.get("/orders", async (req, res) => {
  await tracer.startActiveSpan("list_orders", async (span) => {
    await simulateDbQuery("select_all_orders");
    span.end();
    res.json(Object.values(ordersDb));
  });
});
app.get("/orders/:orderId", async (req, res) => {
  await tracer.startActiveSpan("get_order", async (span) => {
    span.setAttribute("order.id", req.params.orderId);
    await simulateDbQuery("select_order");
    const order = ordersDb[req.params.orderId];
    span.end();
    if (order) {
      res.json(order);
    } else {
      res.status(404).json({ error: "Order not found" });
    }
  });
});
// ---------- Demarrer le serveur ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info({ port: PORT }, "Order service demarre");
});
