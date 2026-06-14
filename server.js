import express from "express";
import session from "express-session";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { URL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { isLeadNotificationConfigured, sendLeadCustomerAcknowledgement, sendLeadNotification, sendRemoteAssistCloseoutEmail, sendRemoteAssistLinkEmail, sendReviewRequestEmail } from "./src/server/email.js";

const app = express();
const server = createServer(app);
const prisma = new PrismaClient();
const port = process.env.PORT || 3000;
const root = join(process.cwd(), "dist");
const publicAssetsRoot = join(process.cwd(), "public", "assets");
const siteUrl = process.env.PUBLIC_SITE_URL || "https://909signalit.com";
const serviceTermsUrl = "https://909signalit.com/terms.html";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const googleReviewLink = process.env.GOOGLE_REVIEW_URL || process.env.GOOGLE_REVIEW_LINK || "";
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";

const leadStatuses = ["New Lead", "Contacted", "Scheduled", "In Progress", "Waiting on Customer", "Completed", "Invoice Sent", "Closed", "Lost"];
const ticketStatuses = ["New", "Scheduled", "In Progress", "Waiting on Customer", "Completed", "Closed", "Canceled"];
const invoiceStatuses = ["Draft", "Sent", "Partially Paid", "Paid", "Overdue", "Void", "Refunded"];
const customerTypes = ["Residential", "Business", "Warehouse", "Restaurant", "Church", "Nonprofit", "Other"];
const serviceTypes = ["Computer Repair", "PC Health Check", "Wi-Fi Troubleshooting", "Printer Setup", "Small Business IT Support", "Network Support", "POS Support", "Microsoft 365 Support", "Email Support", "Data Backup Setup", "Remote IT Support", "Other"];
const standardServiceMenu = [
  { name: "Remote IT Support", priceCents: 6500, category: "Remote" },
  { name: "PC Health Check", priceCents: 4900, category: "Assessment" },
  { name: "Computer Repair / Tune-Up", priceCents: 9500, category: "Computer" },
  { name: "Printer Setup", priceCents: 9500, category: "Printer" },
  { name: "Wi-Fi Troubleshooting", priceCents: 9500, category: "Network" },
  { name: "Malware Cleanup", priceCents: 12500, category: "Computer" },
  { name: "Microsoft 365 Support", priceCents: 12500, category: "Business" },
  { name: "New Computer Setup", priceCents: 12500, category: "Computer" },
  { name: "Network Support", priceCents: 15000, category: "Network" },
  { name: "Warehouse Wi-Fi / Network Support", priceCents: 15000, category: "Network" },
  { name: "Workstation Setup", priceCents: 17500, category: "Business" },
  { name: "Same-Day IT Support", priceCents: 17500, category: "Priority" },
  { name: "Technology Checkup", priceCents: 14900, category: "Assessment" },
  { name: "POS Support", priceCents: 12500, category: "Business" },
  { name: "Data Backup Setup", priceCents: 12500, category: "Backup" },
  { name: "Email Setup & Troubleshooting", priceCents: 9500, category: "Email" },
  { name: "Router Setup & Troubleshooting", priceCents: 9500, category: "Network" }
];
const invoiceServiceOptions = standardServiceMenu.map((service) => service.name);
const quickServiceNames = ["Remote IT Support", "PC Health Check", "Computer Repair / Tune-Up", "Wi-Fi Troubleshooting", "Printer Setup", "Network Support", "POS Support"];
const expenseCategories = ["Parts / Hardware", "Software / Subscriptions", "Fuel / Travel", "Tools / Equipment", "Phone / Internet", "Marketing / Ads", "Office Supplies", "Contract Labor", "Fees / Processing", "Meals", "Other"];
const expensePaymentMethods = ["Cash", "Debit Card", "Credit Card", "Bank Transfer", "Stripe/Processing Fee", "Other"];
const remoteDeviceTypes = ["Windows PC", "Mac", "Chromebook", "Android", "iPhone/iPad", "Other"];
const remoteSessionStatuses = ["Requested", "Approved", "Active", "Ended", "Cancelled"];
const urgencyOptions = ["Normal", "Same-day if available", "Emergency"];
const contactOptions = ["Call", "Text", "Email"];
const sourceOptions = ["Website Contact Form", "Website", "Google Business Profile", "Phone", "Text", "Referral", "Facebook", "Nextdoor", "Walk-in", "Other"];

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (request, response) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    response.status(503).send("Stripe webhook is not configured.");
    return;
  }

  const signature = request.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error?.message || error);
    response.status(400).send("Invalid Stripe webhook signature.");
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const invoiceId = Number(session.metadata?.invoiceId);

    if (Number.isInteger(invoiceId) && invoiceId > 0) {
      const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      if (invoice) {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            status: "Paid",
            paidAt: new Date(),
            stripeCheckoutSessionId: session.id || invoice.stripeCheckoutSessionId
          }
        });
      } else {
        console.warn(`Stripe webhook invoice not found: ${invoiceId}`);
      }
    } else {
      console.warn("Stripe webhook missing invoiceId metadata.");
    }
  }

  response.json({ received: true });
});

app.use(express.json());
const sessionMiddleware = session({
  name: "signal_desk",
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
});

app.use(sessionMiddleware);

function esc(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripeMode() {
  if (!stripeSecretKey) return "not configured";
  if (stripeSecretKey.startsWith("sk_test_")) return "test";
  if (stripeSecretKey.startsWith("sk_live_")) return "live";
  return "unknown";
}

function stripeModeLabel() {
  const mode = stripeMode();
  if (mode === "test") return "Stripe test mode";
  if (mode === "live") return "Stripe live mode";
  if (mode === "not configured") return "Stripe not configured";
  return "Stripe mode unknown";
}

function stripeModeNotice() {
  const mode = stripeMode();
  const detail = mode === "test"
    ? "Payment links use Stripe test keys. Do not send test checkout links to real customers."
    : mode === "live"
      ? "Payment links use Stripe live keys. Confirm customer and amount before sending."
      : mode === "not configured"
        ? "Stripe keys are missing, so payment links cannot be generated."
        : "Stripe is configured, but the key prefix is not recognized. Confirm configuration before sending payment links.";
  return `<section class="card"><h2>Stripe Mode</h2><p><strong>${esc(stripeModeLabel())}</strong></p><p class="muted">${esc(detail)}</p></section>`;
}

function appearsTestValue(value = "") {
  const normalized = String(value || "").toLowerCase();
  return normalized.includes("test") || normalized.includes("demo") || normalized.includes("example.com") || normalized.includes("support@909signalit.com");
}

function remoteSessionIsTestDemo(session = {}) {
  return [session.clientName, session.email, session.issueSummary, session.notes, session.customer?.name, session.customer?.email, session.lead?.name, session.lead?.email, session.ticket?.customer?.name, session.ticket?.customer?.email, session.ticket?.lead?.name, session.ticket?.lead?.email].some(appearsTestValue);
}

function invoiceIsTestDemo(invoice = {}) {
  return [invoice.customerName, invoice.customerEmail, invoice.notes, invoice.ticket?.customer?.name, invoice.ticket?.customer?.email, invoice.lead?.name, invoice.lead?.email].some(appearsTestValue);
}

function ticketIsTestDemo(ticket = {}) {
  return [ticket.title, ticket.issue, ticket.customerNotes, ticket.internalNotes, ticket.customer?.name, ticket.customer?.email, ticket.lead?.name, ticket.lead?.email].some(appearsTestValue);
}

function testDemoNotice(isTestDemo, context = "record") {
  return isTestDemo ? `<section class="card warning"><h2>Test/Demo Indicator</h2><p>This ${esc(context)} appears to contain test or demo customer information. Confirm before creating invoices, payment links, or review requests.</p></section>` : "";
}

function money(value) {
  return value == null ? "" : esc(value);
}

function dollars(cents = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((Number(cents) || 0) / 100);
}

function parseMoneyToCents(value) {
  const cleaned = String(value ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return 0;
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function parsePositiveInt(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalMinutes(value) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) return null;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function formatMoneyValue(value) {
  const cents = parseMoneyToCents(value);
  return cents == null ? "" : dollars(cents);
}

function parseOptionalMoneyDecimal(value) {
  const cleaned = String(value ?? "").trim();
  if (!cleaned) return null;
  const cents = parseMoneyToCents(cleaned);
  return cents == null ? null : (cents / 100).toFixed(2);
}

function dateValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16);
}

function displayDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function displayDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function dateOnlyValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function nowMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function lastSevenDaysStart() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - 6);
  return start;
}

function lastThirtyDaysStart() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - 29);
  return start;
}

function tomorrowStart() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() + 1);
  return start;
}

function daysAgoStart(days) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - days);
  return start;
}

function currentMonthRange() {
  const start = nowMonthStart();
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start, end, value: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}` };
}

function parseFollowUpDate(value) {
  return value ? new Date(`${value}T12:00:00`) : null;
}

function monthRangeFromParam(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const year = match ? Number(match[1]) : now.getFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : now.getMonth();
  if (monthIndex < 0 || monthIndex > 11) return currentMonthRange();
  const start = new Date(year, monthIndex, 1);
  if (Number.isNaN(start.getTime())) return currentMonthRange();
  return { start, end: new Date(year, monthIndex + 1, 1), value: `${year}-${String(monthIndex + 1).padStart(2, "0")}` };
}

function isoDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function adminConfigured() {
  return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET);
}

function requireAuth(request, response, next) {
  if (request.session?.adminAuthed) return next();
  response.redirect("/desk/login");
}

const liveViewRooms = new Map();
const liveViewWss = new WebSocketServer({ noServer: true });

function liveViewRoom(sessionCode) {
  if (!liveViewRooms.has(sessionCode)) liveViewRooms.set(sessionCode, { clients: new Set(), technicians: new Set() });
  return liveViewRooms.get(sessionCode);
}

function sendLiveView(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcastLiveView(sockets, message, except) {
  sockets.forEach((socket) => {
    if (socket !== except) sendLiveView(socket, message);
  });
}

function updateRemoteLiveView(sessionCode, data) {
  prisma.remoteSession.update({ where: { sessionCode }, data }).catch((error) => {
    console.error("Remote live view status update failed:", error?.message || error);
  });
}

function cleanupLiveViewSocket(socket) {
  const { sessionCode, role } = socket.liveView || {};
  if (!sessionCode || !role) return;
  const room = liveViewRooms.get(sessionCode);
  if (!room) return;
  const ownSet = role === "technician" ? room.technicians : room.clients;
  const otherSet = role === "technician" ? room.clients : room.technicians;
  ownSet.delete(socket);
  broadcastLiveView(otherSet, { type: `${role}-disconnected` });
  if (!room.clients.size && !room.technicians.size) liveViewRooms.delete(sessionCode);
  updateRemoteLiveView(sessionCode, { liveViewLastConnectedAt: new Date(), liveViewStatus: role === "client" ? "Disconnected" : "Waiting" });
}

liveViewWss.on("connection", (socket, request) => {
  socket.isDeskAuthed = Boolean(request.session?.adminAuthed);
  socket.on("message", async (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      sendLiveView(socket, { type: "error", message: "Invalid signaling message." });
      return;
    }

    if (message.type === "join") {
      const sessionCode = String(message.sessionCode || "").trim().toUpperCase();
      const role = message.role === "technician" ? "technician" : "client";
      if (!sessionCode) {
        sendLiveView(socket, { type: "error", message: "Session code is required." });
        return;
      }
      if (role === "technician" && !socket.isDeskAuthed) {
        sendLiveView(socket, { type: "error", message: "Technician Live View requires desk login." });
        socket.close();
        return;
      }
      const session = await prisma.remoteSession.findUnique({ where: { sessionCode } });
      if (!session) {
        sendLiveView(socket, { type: "error", message: "Remote session was not found." });
        return;
      }
      socket.liveView = { sessionCode, role };
      const room = liveViewRoom(sessionCode);
      const ownSet = role === "technician" ? room.technicians : room.clients;
      const otherSet = role === "technician" ? room.clients : room.technicians;
      ownSet.add(socket);
      sendLiveView(socket, { type: "joined", role, technicianConnected: room.technicians.size > 0, clientConnected: room.clients.size > 0 });
      broadcastLiveView(otherSet, { type: `${role}-connected` }, socket);
      updateRemoteLiveView(sessionCode, { liveViewLastConnectedAt: new Date(), liveViewStatus: role === "client" ? "Waiting" : session.liveViewStatus || "Waiting" });
      return;
    }

    const { sessionCode, role } = socket.liveView || {};
    if (!sessionCode || !role) {
      sendLiveView(socket, { type: "error", message: "Join a Live View session before signaling." });
      return;
    }
    const room = liveViewRooms.get(sessionCode);
    if (!room) return;
    const targetSet = role === "technician" ? room.clients : room.technicians;
    if (["offer", "answer", "ice-candidate"].includes(message.type)) {
      broadcastLiveView(targetSet, message, socket);
    }
    if (message.type === "sharing-started") {
      updateRemoteLiveView(sessionCode, { liveViewStatus: "Sharing", liveViewStartedAt: new Date(), liveViewLastConnectedAt: new Date() });
      broadcastLiveView(targetSet, { type: "sharing-started" }, socket);
    }
    if (message.type === "sharing-stopped") {
      updateRemoteLiveView(sessionCode, { liveViewStatus: "Ended", liveViewEndedAt: new Date(), liveViewLastConnectedAt: new Date() });
      broadcastLiveView(targetSet, { type: "sharing-stopped" }, socket);
    }
  });
  socket.on("close", () => cleanupLiveViewSocket(socket));
});

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (pathname !== "/live-view-signal") {
    socket.destroy();
    return;
  }
  const responseShim = {
    getHeader() {},
    setHeader() {},
    writeHead() {}
  };
  sessionMiddleware(request, responseShim, () => {
    liveViewWss.handleUpgrade(request, socket, head, (ws) => {
      liveViewWss.emit("connection", ws, request);
    });
  });
});

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} | 909 Signal Desk</title>
  <style>
    :root { --navy:#071d3c; --blue:#1268f3; --green:#35b51f; --gray:#f3f6fa; --border:#dbe4ef; --text:#172234; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; color:var(--text); background:var(--gray); }
    a { color: var(--blue); }
    header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px clamp(18px,4vw,48px); color:white; background:var(--navy); }
    .brand { color:white; text-decoration:none; font-weight:900; font-size:1.25rem; }
    .brand span { color:var(--green); }
    nav { display:flex; flex-wrap:wrap; gap:12px; }
    nav a { color:white; text-decoration:none; font-weight:800; }
    main { width:min(1180px, calc(100% - 32px)); margin:28px auto 56px; }
    .card, form, table { background:white; border:1px solid var(--border); border-radius:8px; box-shadow:0 12px 28px rgba(7,29,60,.06); }
    .card { padding:20px; margin-bottom:18px; }
    .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
    .grid.two { grid-template-columns:repeat(2,1fr); }
    .metric strong { display:block; font-size:2rem; color:var(--navy); }
    .attention-card { display:grid; gap:8px; color:var(--navy); text-decoration:none; }
    .attention-card strong { font-size:2rem; color:var(--blue); }
    .attention-card small { color:#5d6b7f; font-weight:800; }
    table { width:100%; border-collapse:collapse; overflow:hidden; }
    th, td { padding:12px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }
    th { color:var(--navy); background:#f8fbff; }
    form { padding:18px; display:grid; gap:12px; }
    form.work-order-form { padding:0; background:transparent; border:0; box-shadow:none; }
    label { display:grid; gap:6px; font-weight:800; color:var(--navy); }
    input, select, textarea { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font:inherit; }
    textarea { min-height:110px; }
    button, .button { display:inline-flex; align-items:center; justify-content:center; width:max-content; min-height:40px; padding:9px 14px; color:white; background:var(--blue); border:0; border-radius:8px; font-weight:900; text-decoration:none; cursor:pointer; }
    .muted { color:#5d6b7f; }
    .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .row form { padding:0; background:transparent; border:0; box-shadow:none; }
    .service-chip { min-height:34px; padding:7px 10px; color:var(--navy); background:#eef8ee; border:1px solid rgba(53,181,31,.28); }
    .quick-add-panel { border-top:4px solid var(--green); }
    .copy-source { position:absolute; left:-9999px; width:1px; height:1px; }
    .danger { color:#b42318; }
    @media (max-width: 850px) { .grid, .grid.two { grid-template-columns:1fr; } table { display:block; overflow-x:auto; } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/desk">909 <span>Signal</span> Desk</a>
    <nav>
      <a href="/desk">Dashboard</a>
      <a href="/desk/leads">Leads</a>
      <a href="/desk/customers">Customers</a>
      <a href="/desk/tickets">Tickets</a>
      <a href="/desk/invoices">Invoices</a>
      <a href="/desk/expenses">Expenses</a>
      <a href="/desk/reports">Reports</a>
      <a href="/desk/follow-ups">Follow-Ups</a>
      <a href="/desk/remote-sessions">Remote Sessions</a>
      <a href="/desk/signalscan">SignalScan</a>
      <a href="/desk/service-menu">Service Menu</a>
      <a href="/desk/logout">Logout</a>
    </nav>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function statusOptions(statuses, selected) {
  return statuses.map((status) => `<option value="${esc(status)}"${status === selected ? " selected" : ""}>${esc(status)}</option>`).join("");
}

function serviceDatalist() {
  return `<datalist id="invoice-service-options">${invoiceServiceOptions.map((service) => `<option value="${esc(service)}"></option>`).join("")}</datalist>`;
}

function centsToInputValue(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

function serviceMenuOptions() {
  return standardServiceMenu.map((service, index) => `<option value="${index}">${esc(service.name)} &mdash; ${dollars(service.priceCents)}</option>`).join("");
}

function quickServiceChips() {
  return quickServiceNames.map((name) => {
    const service = standardServiceMenu.find((item) => item.name === name);
    if (!service) return "";
    return `<button class="button service-chip" type="button" data-service-name="${esc(service.name)}" data-service-price="${centsToInputValue(service.priceCents)}">${esc(service.name)}</button>`;
  }).join("");
}

function serviceMenuTable() {
  return `<table><thead><tr><th>Service</th><th>Category</th><th>Price</th></tr></thead><tbody>${standardServiceMenu.map((service) => `
    <tr>
      <td>${esc(service.name)}</td>
      <td>${esc(service.category || "")}</td>
      <td>${dollars(service.priceCents)}</td>
    </tr>`).join("")}</tbody></table>`;
}

function deskSetupMessage(response) {
  response.status(503).send(layout("Database Setup Needed", `<section class="card"><h1>Database is not ready.</h1><p>Confirm DATABASE_URL is set and run <code>npx prisma db push</code>.</p><p class="muted">After the database is ready, refresh this page.</p></section>`));
}

function fieldValue(values, field, fallback = "") {
  return esc(values?.[field] ?? fallback);
}

function leadForm(action, values = {}) {
  return `<form method="post" action="${esc(action)}">
    <h1>Add Lead</h1>
    <label>Name <input name="name" value="${fieldValue(values, "name")}" required></label>
    <label>Phone <input name="phone" value="${fieldValue(values, "phone")}" required></label>
    <label>Email <input name="email" type="email" value="${fieldValue(values, "email")}"></label>
    <label>Business name <input name="businessName" value="${fieldValue(values, "businessName")}"></label>
    <label>Customer type <select name="customerType" required><option value="">Select one</option>${statusOptions(customerTypes, values.customerType)}</select></label>
    <label>City <input name="city" value="${fieldValue(values, "city")}" required></label>
    <label>Service requested <select name="serviceRequested" required><option value="">Select one</option>${statusOptions(serviceTypes, values.serviceRequested)}</select></label>
    <label>Urgency <select name="urgency" required>${statusOptions(urgencyOptions, values.urgency || "Normal")}</select></label>
    <label>Preferred contact <select name="preferredContact" required>${statusOptions(contactOptions, values.preferredContact || "Call")}</select></label>
    <label>Source <select name="source" required>${statusOptions(sourceOptions, values.source || "Phone")}</select></label>
    <label>Status <select name="status">${statusOptions(leadStatuses, values.status || "New Lead")}</select></label>
    <label>Message <textarea name="message" required>${fieldValue(values, "message")}</textarea></label>
    <label>Notes <textarea name="notes">${fieldValue(values, "notes")}</textarea></label>
    <button type="submit">Create Lead</button>
  </form>`;
}

function searchWhere(q, fields) {
  if (!q) return undefined;
  return { OR: fields.map((field) => ({ [field]: { contains: q, mode: "insensitive" } })) };
}

function leadTable(leads) {
  return `<table><thead><tr><th>Name</th><th>Contact</th><th>Service</th><th>Urgency</th><th>Source</th><th>Status</th><th>Created</th></tr></thead><tbody>${leads.map((lead) => `
    <tr>
      <td><a href="/desk/leads/${lead.id}">${esc(lead.name)}</a><br><span class="muted">${esc(lead.businessName || lead.customerType)}</span></td>
      <td>${esc(lead.phone)}<br>${esc(lead.email || "")}</td>
      <td>${esc(lead.serviceRequested)}<br><span class="muted">${esc(lead.city)}</span></td>
      <td>${esc(lead.urgency)}</td>
      <td>${esc(lead.source || "")}</td>
      <td>${esc(lead.status)}</td>
      <td>${new Date(lead.createdAt).toLocaleDateString()}</td>
    </tr>`).join("") || `<tr><td colspan="7">No leads found.</td></tr>`}</tbody></table>`;
}

function leadQuickDetails(lead) {
  return `<dl class="details">
    <dt>Customer</dt><dd>${esc(lead.name)}</dd>
    <dt>Phone</dt><dd>${esc(lead.phone)}</dd>
    <dt>Email</dt><dd>${esc(lead.email || "Not provided")}</dd>
    <dt>Business</dt><dd>${esc(lead.businessName || "Not provided")}</dd>
    <dt>Customer type</dt><dd>${esc(lead.customerType)}</dd>
    <dt>City</dt><dd>${esc(lead.city)}</dd>
    <dt>Service requested</dt><dd>${esc(lead.serviceRequested)}</dd>
    <dt>Urgency</dt><dd>${esc(lead.urgency)}</dd>
    <dt>Preferred contact</dt><dd>${esc(lead.preferredContact)}</dd>
    <dt>Source</dt><dd>${esc(lead.source || "")}</dd>
  </dl>`;
}

function leadNextSteps() {
  return `<section class="card"><h2>Next Steps for New Website Leads</h2>
    <ol>
      <li>Call or email the customer using their preferred contact method.</li>
      <li>Decide whether remote support or onsite service is the right fit.</li>
      <li>Convert to a customer, ticket, or work order if the request is qualified.</li>
      <li>Send service terms if work is scheduled or an invoice will be created.</li>
    </ol>
  </section>`;
}

function customerTable(customers) {
  return `<table><thead><tr><th>Name</th><th>Business</th><th>Phone</th><th>Email</th><th>City</th><th>Open Balance</th><th>Last Updated</th><th></th></tr></thead><tbody>${customers.map((customer) => `
    <tr>
      <td><a href="/desk/customers/${customer.id}">${esc(customer.name)}</a></td>
      <td>${esc(customer.businessName || "")}</td>
      <td>${esc(customer.phone || "")}</td>
      <td>${esc(customer.email || "")}</td>
      <td>${esc(customer.city || "")}</td>
      <td>${dollars(openInvoiceBalance(customer.invoices || []))}</td>
      <td>${displayDate(customer.updatedAt)}</td>
      <td><a href="/desk/customers/${customer.id}">View</a></td>
    </tr>`).join("") || `<tr><td colspan="8">No customers found.</td></tr>`}</tbody></table>`;
}

function ticketTable(tickets) {
  return `<table><thead><tr><th>Ticket</th><th>Title</th><th>Status</th><th>Work Done</th><th>Completed</th><th>Invoices</th><th>Review</th><th>Appointment</th><th>Updated</th></tr></thead><tbody>${tickets.map((ticket) => `
    <tr>
      <td><a href="/desk/tickets/${ticket.id}">${esc(ticket.ticketNumber)}</a></td>
      <td>${esc(ticket.title)}<br><span class="muted">${esc(ticket.serviceType || "")}</span></td>
      <td>${esc(ticket.status)}</td>
      <td>${ticket.workPerformed ? "Yes" : "No"}</td>
      <td>${displayDate(ticket.completedAt)}</td>
      <td>${ticket.invoices?.length ? `<a href="/desk/invoices/${ticket.invoices[0].id}">${ticket.invoices.length}</a>` : "0"}</td>
      <td>${reviewStatusLabel(ticket)}</td>
      <td>${ticket.appointmentAt ? new Date(ticket.appointmentAt).toLocaleString() : ""}</td>
      <td>${new Date(ticket.updatedAt).toLocaleDateString()}</td>
    </tr>`).join("") || `<tr><td colspan="9">No tickets found.</td></tr>`}</tbody></table>`;
}

function reviewStatusLabel(ticket) {
  if (ticket.reviewReceived) return "Review Received";
  if (ticket.reviewRequested) return "Review Requested";
  return "Review Not Requested";
}

function invoiceTable(invoices) {
  return `<table><thead><tr><th>Invoice</th><th>Customer</th><th>Status</th><th>Total</th><th>Due</th><th>Created</th></tr></thead><tbody>${invoices.map((invoice) => `
    <tr>
      <td><a href="/desk/invoices/${invoice.id}">${esc(invoice.invoiceNumber)}</a></td>
      <td>${esc(invoice.customerName)}<br><span class="muted">${esc(invoice.customerEmail || invoice.customerPhone || "")}</span></td>
      <td>${esc(invoice.status)}</td>
      <td>${dollars(invoice.totalCents)}</td>
      <td>${invoice.dueDate ? new Date(invoice.dueDate).toLocaleDateString() : ""}</td>
      <td>${new Date(invoice.createdAt).toLocaleDateString()}</td>
    </tr>`).join("") || `<tr><td colspan="6">No invoices found.</td></tr>`}</tbody></table>`;
}

function openInvoiceBalance(invoices) {
  const openStatuses = new Set(["Draft", "Sent", "Partially Paid", "Overdue"]);
  return invoices.filter((invoice) => openStatuses.has(invoice.status)).reduce((total, invoice) => total + (Number(invoice.totalCents) || 0), 0);
}

function invoiceFinancialSummary(invoices) {
  const paidInvoices = invoices.filter((invoice) => invoice.status === "Paid");
  const openInvoices = invoices.filter((invoice) => ["Draft", "Sent", "Partially Paid", "Overdue"].includes(invoice.status));
  return {
    totalInvoiced: invoices.filter((invoice) => !["Void", "Refunded"].includes(invoice.status)).reduce((total, invoice) => total + (Number(invoice.totalCents) || 0), 0),
    totalPaid: paidInvoices.reduce((total, invoice) => total + (Number(invoice.totalCents) || 0), 0),
    openBalance: openInvoiceBalance(invoices),
    invoiceCount: invoices.length,
    paidCount: paidInvoices.length,
    openCount: openInvoices.length
  };
}

function customerTicketHistoryTable(tickets) {
  return `<table><thead><tr><th>Ticket</th><th>Title</th><th>Service</th><th>Status</th><th>Appointment</th><th>Completed</th><th>Review Requested</th><th>Review Received</th><th>Created</th></tr></thead><tbody>${tickets.map((ticket) => `
    <tr>
      <td><a href="/desk/tickets/${ticket.id}">${esc(ticket.ticketNumber)}</a></td>
      <td>${esc(ticket.title)}</td>
      <td>${esc(ticket.serviceType || "")}</td>
      <td>${esc(ticket.status)}</td>
      <td>${displayDateTime(ticket.appointmentAt)}</td>
      <td>${displayDate(ticket.completedAt)}</td>
      <td>${ticket.reviewRequested ? "Yes" : "No"}</td>
      <td>${ticket.reviewReceived ? "Yes" : "No"}</td>
      <td>${displayDate(ticket.createdAt)}</td>
    </tr>`).join("") || `<tr><td colspan="9">No tickets yet.</td></tr>`}</tbody></table>`;
}

function customerInvoiceHistoryTable(invoices) {
  return `<table><thead><tr><th>Invoice</th><th>Status</th><th>Total</th><th>Due</th><th>Payment Link</th><th>Paid</th><th>Created</th></tr></thead><tbody>${invoices.map((invoice) => `
    <tr>
      <td><a href="/desk/invoices/${invoice.id}">${esc(invoice.invoiceNumber)}</a></td>
      <td>${esc(invoice.status)}</td>
      <td>${dollars(invoice.totalCents)}</td>
      <td>${displayDate(invoice.dueDate)}</td>
      <td>${invoice.paymentLink ? "Generated" : "Not generated"}</td>
      <td>${displayDate(invoice.paidAt)}</td>
      <td>${displayDate(invoice.createdAt)}</td>
    </tr>`).join("") || `<tr><td colspan="7">No invoices yet.</td></tr>`}</tbody></table>`;
}

function relatedLeadHistoryTable(leads) {
  return `<table><thead><tr><th>Lead</th><th>Service</th><th>Status</th><th>Source</th><th>City</th><th>Created</th></tr></thead><tbody>${leads.map((lead) => `
    <tr>
      <td><a href="/desk/leads/${lead.id}">Lead ${lead.id}</a></td>
      <td>${esc(lead.serviceRequested)}</td>
      <td>${esc(lead.status)}</td>
      <td>${esc(lead.source || "")}</td>
      <td>${esc(lead.city || "")}</td>
      <td>${displayDate(lead.createdAt)}</td>
    </tr>`).join("") || `<tr><td colspan="6">No related leads yet.</td></tr>`}</tbody></table>`;
}

function customerRecentActivity(tickets, invoices) {
  const activities = [
    ...tickets.map((ticket) => ({ date: ticket.updatedAt || ticket.createdAt, label: `Ticket ${ticket.ticketNumber}`, detail: `${ticket.status} - ${ticket.title}`, href: `/desk/tickets/${ticket.id}` })),
    ...invoices.map((invoice) => ({ date: invoice.updatedAt || invoice.createdAt, label: `Invoice ${invoice.invoiceNumber}`, detail: `${invoice.status} - ${dollars(invoice.totalCents)}`, href: `/desk/invoices/${invoice.id}` }))
  ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8);
  return `<table><thead><tr><th>Date</th><th>Activity</th><th>Details</th></tr></thead><tbody>${activities.map((item) => `
    <tr>
      <td>${displayDate(item.date)}</td>
      <td><a href="${esc(item.href)}">${esc(item.label)}</a></td>
      <td>${esc(item.detail)}</td>
    </tr>`).join("") || `<tr><td colspan="3">No recent activity yet.</td></tr>`}</tbody></table>`;
}

function metricCard(label, value, note = "") {
  return `<div class="card metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<p class="muted">${esc(note)}</p>` : ""}</div>`;
}

function attentionCard(label, count, href) {
  return `<a class="card attention-card" href="${esc(href)}"><span>${esc(label)}</span><strong>${count}</strong><small>Open list</small></a>`;
}

function signalScanDashboardPanel() {
  return `<section class="card">
    <div class="row"><h2>SignalScan</h2><a class="button" href="/desk/signalscan">Open SignalScan Panel</a></div>
    <div class="grid">
      ${metricCard("Product status", "v1.0.0 Demo Ready")}
      ${metricCard("Package type", "Windows zip package")}
      ${metricCard("Safety boundary", "Read-only diagnostics")}
      ${metricCard("Outputs", "PDF Report, Markdown Draft, Local Scan History")}
    </div>
    <p class="muted"><strong>Demo kit:</strong> Available. <strong>Next action:</strong> Book first 3-5 PC Health Check demos.</p>
  </section>`;
}

function signalScanLaunchChecklist() {
  const items = [
    "Zip package tested",
    "PDF export tested",
    "Markdown export tested",
    "Demo report generated",
    "Service offer prepared",
    "Outreach scripts prepared",
    "First local prospects contacted"
  ];
  return `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
}

function signalScanDeskPage() {
  return `<section class="card">
    <div class="row"><h1>SignalScan</h1><a class="button" href="/desk/leads/new">Add PC Health Check Lead</a></div>
    <p class="muted">Internal launch panel for SignalScan by 909 Signal IT. Do not store private artifact links, local paths, or real client reports here.</p>
  </section>
  <section class="card">
    <h2>Product Summary</h2>
    <div class="grid">
      ${metricCard("Product status", "v1.0.0 Demo Ready")}
      ${metricCard("Package type", "Windows zip package")}
      ${metricCard("Safety boundary", "Read-only diagnostics")}
      ${metricCard("Outputs", "PDF Report, Markdown Draft, Local Scan History")}
      ${metricCard("Demo kit", "Available")}
      ${metricCard("Next action", "Book first 3-5 PC Health Check demos")}
    </div>
  </section>
  <section class="card">
    <h2>SignalScan Launch Checklist</h2>
    ${signalScanLaunchChecklist()}
  </section>
  <section class="card">
    <h2>Service Positioning</h2>
    <p><strong>SignalScan by 909 Signal IT</strong> is a PC Health Check / Technician Console used for read-only diagnostic scans and technician-reviewed PDF reports.</p>
    <p><strong>Core message:</strong> AI explains. The technician decides.</p>
    <p class="muted">SignalScan does not repair computers, remove malware, clean up files, delete files, optimize settings, or change system settings. Any follow-up work requires customer approval.</p>
  </section>`;
}

function recentActivityTable(items) {
  return `<table><thead><tr><th>Type</th><th>Label</th><th>Customer/Lead</th><th>Status</th><th>Date</th></tr></thead><tbody>${items.map((item) => `
    <tr>
      <td>${esc(item.type)}</td>
      <td><a href="${esc(item.href)}">${esc(item.label)}</a></td>
      <td>${esc(item.name || "")}</td>
      <td>${esc(item.status || "")}</td>
      <td>${displayDateTime(item.date)}</td>
    </tr>`).join("") || `<tr><td colspan="5">No recent activity yet.</td></tr>`}</tbody></table>`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvRows(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function sendCsv(response, type, rows) {
  const stamp = new Date().toISOString().slice(0, 10);
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", `attachment; filename="909-signal-it-${type}-${stamp}.csv"`);
  response.send(csvRows(rows));
}

function moneyCsv(cents) {
  return centsToInputValue(cents);
}

async function monthlyReport(monthValue) {
  const month = monthRangeFromParam(monthValue);
  const openInvoiceStatuses = ["Draft", "Sent", "Partially Paid", "Overdue"];
  const [
    paidRevenue,
    expenses,
    totalInvoiced,
    openBalance,
    newLeads,
    convertedLeads,
    completedJobs,
    paidInvoices,
    unpaidInvoices,
    reviewRequestsSent,
    reviewsReceived
  ] = await Promise.all([
    prisma.invoice.aggregate({ where: { status: "Paid", paidAt: { gte: month.start, lt: month.end } }, _sum: { totalCents: true } }),
    prisma.expense.aggregate({ where: { expenseDate: { gte: month.start, lt: month.end } }, _sum: { amountCents: true } }),
    prisma.invoice.aggregate({ where: { createdAt: { gte: month.start, lt: month.end }, status: { notIn: ["Void", "Refunded"] } }, _sum: { totalCents: true } }),
    prisma.invoice.aggregate({ where: { status: { in: openInvoiceStatuses } }, _sum: { totalCents: true } }),
    prisma.lead.count({ where: { createdAt: { gte: month.start, lt: month.end } } }),
    prisma.lead.count({ where: { createdAt: { gte: month.start, lt: month.end }, OR: [{ tickets: { some: {} } }, { invoices: { some: {} } }] } }),
    prisma.ticket.count({ where: { status: { in: ["Completed", "Closed"] }, completedAt: { gte: month.start, lt: month.end } } }),
    prisma.invoice.count({ where: { status: "Paid", paidAt: { gte: month.start, lt: month.end } } }),
    prisma.invoice.count({ where: { status: { in: openInvoiceStatuses } } }),
    prisma.ticket.count({ where: { reviewRequested: true, reviewReceived: false, updatedAt: { gte: month.start, lt: month.end } } }),
    prisma.ticket.count({ where: { reviewReceived: true, updatedAt: { gte: month.start, lt: month.end } } })
  ]);
  const paidRevenueCents = paidRevenue._sum.totalCents || 0;
  const expenseCents = expenses._sum.amountCents || 0;
  return {
    month: month.value,
    paidRevenueCents,
    expenseCents,
    estimatedProfitCents: paidRevenueCents - expenseCents,
    totalInvoicedCents: totalInvoiced._sum.totalCents || 0,
    openBalanceCents: openBalance._sum.totalCents || 0,
    newLeads,
    convertedLeads,
    completedJobs,
    paidInvoices,
    unpaidInvoices,
    reviewRequestsSent,
    reviewsReceived
  };
}

function monthlyReportRows(report) {
  return [
    ["Metric", "Value"],
    ["Month", report.month],
    ["Paid Revenue", moneyCsv(report.paidRevenueCents)],
    ["Expenses", moneyCsv(report.expenseCents)],
    ["Estimated Profit", moneyCsv(report.estimatedProfitCents)],
    ["Total Invoiced", moneyCsv(report.totalInvoicedCents)],
    ["Open Balance", moneyCsv(report.openBalanceCents)],
    ["New Leads", report.newLeads],
    ["Converted Leads", report.convertedLeads],
    ["Completed Jobs", report.completedJobs],
    ["Paid Invoices", report.paidInvoices],
    ["Unpaid Invoices", report.unpaidInvoices],
    ["Review Requests Sent", report.reviewRequestsSent],
    ["Reviews Received", report.reviewsReceived]
  ];
}

async function generateRemoteSessionCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `909-${randomBytes(4).toString("hex").toUpperCase().slice(0, 6)}`;
    const existing = await prisma.remoteSession.findUnique({ where: { sessionCode: code } });
    if (!existing) return code;
  }
  return `909-${Date.now().toString(36).toUpperCase().slice(-4)}`;
}

function publicRemotePage(message = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>909 Signal Remote Assist</title><style>
    :root{--navy:#071d3c;--blue:#1268f3;--green:#35b51f;--gray:#f3f6fa;--border:#dbe4ef;--text:#172234}
    *{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text);background:var(--gray);line-height:1.6}
    header,main{width:min(980px,calc(100% - 32px));margin:0 auto}header{padding:28px 0}.brand{font-weight:900;color:var(--navy);text-decoration:none;font-size:1.3rem}.brand span{color:var(--blue)}
    .card,form{background:white;border:1px solid var(--border);border-radius:8px;box-shadow:0 12px 28px rgba(7,29,60,.06)}.card{padding:22px;margin-bottom:18px}form{padding:22px;display:grid;gap:14px}.danger{color:#b42318}
    h1{margin:0;color:var(--navy);font-size:clamp(2rem,6vw,4rem);line-height:1}h2{margin:0 0 10px;color:var(--navy)}.muted{color:#5d6b7f}.warning{border-left:5px solid var(--green)}
    label{display:grid;gap:6px;font-weight:800;color:var(--navy)}input,select,textarea{width:100%;padding:11px 12px;border:1px solid var(--border);border-radius:8px;font:inherit}textarea{min-height:120px}
    button,.button{display:inline-flex;width:max-content;min-height:42px;align-items:center;justify-content:center;padding:10px 16px;color:white;background:var(--blue);border:0;border-radius:8px;font-weight:900;text-decoration:none;cursor:pointer}
    .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}@media(max-width:760px){.grid{grid-template-columns:1fr}}
  </style></head><body><header><a class="brand" href="/">909 <span>Signal</span> IT</a></header><main>
    <section class="card"><p class="muted">Consent-first remote support</p><h1>909 Signal Remote Assist</h1><p>Only start a remote support session if you are currently working with 909 Signal IT. Remote support is for troubleshooting and guidance, not hidden or unattended access.</p></section>
    ${message}
    <section class="card warning"><h2>Before You Continue</h2><ul><li>You are allowing 909 Signal IT to view your screen for troubleshooting.</li><li>You can stop sharing at any time.</li><li>Close private windows, passwords, banking pages, medical records, and sensitive documents before starting.</li><li>909 Signal IT will not request passwords unless absolutely necessary. Do not share passwords in plain text if avoidable.</li><li>Remote support is not unattended access.</li><li>The session may be documented in Signal Desk for service history.</li></ul></section>
    <section class="card"><h2>How Remote Assist Works</h2><ol><li>Review and accept consent.</li><li>Close private or sensitive information.</li><li>Click Start Screen Share after the session is created.</li><li>Choose the screen, window, or browser tab to share.</li><li>Keep the browser window open during support.</li><li>Stop sharing when finished.</li></ol></section>
    <form method="post" action="/remote"><h2>Request Remote Session</h2>
      <div class="grid"><label>Client name <input name="clientName" required></label><label>Phone <input name="phone" required></label></div>
      <div class="grid"><label>Email <input name="email" type="email"></label><label>Company <input name="company"></label></div>
      <div class="grid"><label>Ticket number <input name="ticketNumber"></label><label>Device type <select name="deviceType"><option value="">Select one</option>${statusOptions(remoteDeviceTypes, "")}</select></label></div>
      <label>Issue summary <textarea name="issueSummary" required></textarea></label>
      <label><span><input type="checkbox" name="consentAccepted" value="yes" required> I authorize 909 Signal IT to view my screen for troubleshooting and guidance. I understand I can stop sharing at any time, this is not unattended access, and the session may be documented in Signal Desk for service history. I will close private windows, passwords, banking pages, medical records, and sensitive documents before starting.</span></label>
      <button type="submit">Request Remote Session</button>
    </form>
    <section class="card"><p>Call/text <a href="tel:+19092608660">909-260-8660</a> if you need help starting your session.</p></section>
  </main></body></html>`;
}

function clientLiveViewPage(session) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>909 Signal Live View</title><style>
    :root{--navy:#071d3c;--blue:#1268f3;--green:#35b51f;--gray:#f3f6fa;--border:#dbe4ef;--text:#172234}*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text);background:var(--gray);line-height:1.6}
    main{width:min(920px,calc(100% - 32px));margin:28px auto}.card{padding:22px;margin-bottom:18px;background:white;border:1px solid var(--border);border-radius:8px;box-shadow:0 12px 28px rgba(7,29,60,.06)}h1,h2{margin:0 0 12px;color:var(--navy)}.muted{color:#5d6b7f}.status{font-weight:900;color:var(--blue)}button,.button{display:inline-flex;width:max-content;min-height:42px;align-items:center;justify-content:center;padding:10px 16px;color:white;background:var(--blue);border:0;border-radius:8px;font-weight:900;text-decoration:none;cursor:pointer}.stop{background:#b42318}.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
  </style></head><body><main>
    <section class="card"><p class="muted">Consent-first browser screen sharing</p><h1>909 Signal Live View</h1><p>Session code: <strong>${esc(session.sessionCode)}</strong></p><p class="status" id="status">Waiting</p></section>
    <section class="card"><h2>Before Sharing</h2><ul><li>Only share your screen if you are currently working with 909 Signal IT.</li><li>You can stop sharing at any time.</li><li>Do not type or display passwords while sharing.</li><li>909 Signal IT does not record this session.</li><li>Close banking pages, medical records, private documents, and sensitive browser tabs before starting.</li></ul></section>
    <section class="card"><h2>Customer Steps</h2><ol><li>Review and accept consent.</li><li>Close private or sensitive information.</li><li>Click Start Screen Share.</li><li>Choose the screen, window, or browser tab to share.</li><li>Keep this browser window open during support.</li><li>Stop sharing when finished.</li></ol></section>
    <section class="card"><div class="row"><button id="start">Start Screen Share</button><button id="stop" class="stop" disabled>Stop Sharing</button><a class="button" href="/remote">Back</a></div><p class="muted" id="browser-help"></p></section>
  </main><script>
    const sessionCode = ${JSON.stringify(session.sessionCode)};
    const statusEl = document.getElementById("status");
    const helpEl = document.getElementById("browser-help");
    const startButton = document.getElementById("start");
    const stopButton = document.getElementById("stop");
    let ws;
    let pc;
    let stream;
    const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    function setStatus(text) { statusEl.textContent = text; }
    function send(message) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
    function connect() {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/live-view-signal");
      ws.addEventListener("open", () => send({ type: "join", role: "client", sessionCode }));
      ws.addEventListener("message", async (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "technician-connected") setStatus(stream ? "Sharing active - technician connected" : "Technician connected");
        if (message.type === "answer" && pc) await pc.setRemoteDescription(message);
        if (message.type === "ice-candidate" && pc && message.candidate) await pc.addIceCandidate(message.candidate);
        if (message.type === "error") setStatus(message.message || "Connection error");
      });
      ws.addEventListener("close", () => { if (stream) setStatus("Disconnected"); });
    }
    function stopSharing() {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      stream = null;
      if (pc) pc.close();
      pc = null;
      startButton.disabled = false;
      stopButton.disabled = true;
      send({ type: "sharing-stopped" });
      setStatus("Sharing stopped");
    }
    startButton.addEventListener("click", async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        helpEl.textContent = "Your browser does not support screen sharing. Please use Chrome, Edge, or another supported desktop browser.";
        return;
      }
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        pc = new RTCPeerConnection({ iceServers });
        stream.getTracks().forEach((track) => {
          track.addEventListener("ended", stopSharing);
          pc.addTrack(track, stream);
        });
        pc.onicecandidate = (event) => { if (event.candidate) send({ type: "ice-candidate", candidate: event.candidate }); };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({ type: "sharing-started" });
        send({ type: "offer", sdp: pc.localDescription.sdp });
        startButton.disabled = true;
        stopButton.disabled = false;
        setStatus("Sharing active");
      } catch (error) {
        setStatus("Sharing was not started.");
        helpEl.textContent = error && error.message ? error.message : "Screen sharing permission was cancelled.";
      }
    });
    stopButton.addEventListener("click", stopSharing);
    connect();
  </script></body></html>`;
}

function technicianLiveViewPage(session) {
  return layout("Live View", `<section class="card"><div class="row"><h1>909 Signal Live View</h1><a class="button" href="/desk/remote-sessions/${session.id}">Back to Remote Session</a></div>${remoteSessionDetailGrid(session)}<p class="muted">Viewing only. The customer can stop sharing at any time. Do not ask the client to display passwords, banking pages, medical records, private documents, or sensitive personal information. Use the remote session detail page for troubleshooting notes and completion summary.</p><p><strong>Status:</strong> <span id="live-status">Waiting for client</span></p></section><section class="card"><video id="remote-screen" autoplay playsinline controls style="width:100%;min-height:320px;background:#071d3c;border-radius:8px"></video></section><script>
    const sessionCode = ${JSON.stringify(session.sessionCode)};
    const statusEl = document.getElementById("live-status");
    const video = document.getElementById("remote-screen");
    let ws;
    let pc;
    const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    function setStatus(text) { statusEl.textContent = text; }
    function send(message) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }
    function ensurePeer() {
      if (pc) return pc;
      pc = new RTCPeerConnection({ iceServers });
      pc.ontrack = (event) => { video.srcObject = event.streams[0]; setStatus("Client sharing"); };
      pc.onicecandidate = (event) => { if (event.candidate) send({ type: "ice-candidate", candidate: event.candidate }); };
      pc.onconnectionstatechange = () => { if (["disconnected", "failed", "closed"].includes(pc.connectionState)) setStatus("Disconnected"); };
      return pc;
    }
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/live-view-signal");
    ws.addEventListener("open", () => send({ type: "join", role: "technician", sessionCode }));
    ws.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "joined") setStatus(message.clientConnected ? "Client connected" : "Waiting for client");
      if (message.type === "client-connected") setStatus("Client connected");
      if (message.type === "client-disconnected" || message.type === "sharing-stopped") { setStatus("Disconnected"); video.srcObject = null; if (pc) pc.close(); pc = null; }
      if (message.type === "offer") {
        const peer = ensurePeer();
        await peer.setRemoteDescription({ type: "offer", sdp: message.sdp });
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send({ type: "answer", sdp: peer.localDescription.sdp });
      }
      if (message.type === "ice-candidate" && pc && message.candidate) await pc.addIceCandidate(message.candidate);
      if (message.type === "error") setStatus(message.message || "Connection error");
    });
    ws.addEventListener("close", () => setStatus("Disconnected"));
  </script>`);
}

function remoteSessionTable(sessions) {
  return `<table><thead><tr><th>Session</th><th>Client</th><th>Phone</th><th>Device</th><th>Status</th><th>Live View</th><th>Consent</th><th>Linked</th><th>Last Activity</th><th>Created</th><th>Started</th><th>Ended</th><th>Delivery</th></tr></thead><tbody>${sessions.map((session) => `
    <tr><td><a href="/desk/remote-sessions/${session.id}">${esc(session.sessionCode)}</a></td><td>${esc(session.clientName)}</td><td>${esc(session.phone)}</td><td>${esc(session.deviceType || "")}</td><td>${esc(session.status)}</td><td>${esc(session.liveViewStatus || "Not Started")}</td><td>${session.consentAccepted ? `Accepted ${displayDateTime(session.consentAcceptedAt)}` : "Not accepted"}</td><td>${remoteSessionLinkSummary(session)}</td><td>${remoteSessionLatestActivity(session)}</td><td>${displayDateTime(session.createdAt)}</td><td>${displayDateTime(session.startedAt || session.liveViewStartedAt)}</td><td>${displayDateTime(session.endedAt || session.liveViewEndedAt)}</td><td>${remoteSessionDeliveryActions(session, true)}</td></tr>`).join("") || `<tr><td colspan="13">No remote sessions found.</td></tr>`}</tbody></table>`;
}

function remoteSessionInvoices(session = {}) {
  return session.ticket?.invoices || [];
}

function remoteSessionInvoiceStatus(session = {}) {
  const invoices = remoteSessionInvoices(session);
  if (!invoices.length) return "No linked invoice";
  const unpaid = invoices.filter((invoice) => ["Draft", "Sent", "Partially Paid", "Overdue"].includes(invoice.status));
  if (unpaid.length) return `${unpaid.length} unpaid/open`;
  if (invoices.some((invoice) => invoice.status === "Paid")) return "Paid";
  return invoices.map((invoice) => invoice.status).filter(Boolean).join(", ") || "Linked";
}

function remoteSessionFollowUpNeeded(session = {}) {
  return /^yes$/i.test(remoteSessionCompletionData(session).followUpNeeded || "");
}

function remoteSessionCloseoutSent(session = {}) {
  return String(session.notes || "").includes("Closeout email sent");
}

function remoteSessionCompletedNotInvoiced(session = {}) {
  return remoteSessionIsCompleted(session) && !remoteSessionInvoices(session).length;
}

function remoteSessionInvoicedUnpaid(session = {}) {
  return remoteSessionInvoices(session).some((invoice) => ["Draft", "Sent", "Partially Paid", "Overdue"].includes(invoice.status));
}

function remoteSessionNeedsAttention(session = {}) {
  return !session.consentAccepted ||
    session.status === "Active" ||
    session.liveViewStatus === "Sharing" ||
    remoteSessionCompletedNotInvoiced(session) ||
    remoteSessionInvoicedUnpaid(session) ||
    remoteSessionFollowUpNeeded(session) ||
    (remoteSessionIsCompleted(session) && !remoteSessionCloseoutSent(session));
}

function remoteSessionQueueMatches(session = {}, filter = "") {
  if (filter === "needs-attention") return remoteSessionNeedsAttention(session);
  if (filter === "consent-pending") return !session.consentAccepted;
  if (filter === "in-progress") return session.status === "Active" || session.liveViewStatus === "Sharing";
  if (filter === "completed-not-billed") return remoteSessionCompletedNotInvoiced(session);
  if (filter === "unpaid") return remoteSessionInvoicedUnpaid(session);
  if (filter === "follow-up-needed") return remoteSessionFollowUpNeeded(session);
  return true;
}

function remoteSessionQueueTable(sessions) {
  return `<table><thead><tr><th>Customer</th><th>Status</th><th>Consent</th><th>Live</th><th>Invoice/Payment</th><th>Follow-Up</th><th>Last Activity</th><th></th></tr></thead><tbody>${sessions.map((session) => `
    <tr>
      <td>${esc(session.clientName)}<br><span class="muted">${esc(session.phone || session.email || "")}</span></td>
      <td>${esc(session.status)}</td>
      <td>${session.consentAccepted ? `Accepted ${displayDateTime(session.consentAcceptedAt)}` : "Consent pending"}</td>
      <td>${esc(session.liveViewStatus || "Not Started")}</td>
      <td>${esc(remoteSessionInvoiceStatus(session))}</td>
      <td>${remoteSessionFollowUpNeeded(session) ? "Yes" : "No"}</td>
      <td>${remoteSessionLatestActivity(session)}</td>
      <td><a href="/desk/remote-sessions/${session.id}">Open</a></td>
    </tr>`).join("") || `<tr><td colspan="8">No remote sessions in this queue.</td></tr>`}</tbody></table>`;
}

function remoteSessionQueueFilters(activeFilter = "") {
  const filters = [
    ["", "All"],
    ["needs-attention", "Needs Attention"],
    ["consent-pending", "Consent Pending"],
    ["in-progress", "In Progress"],
    ["completed-not-billed", "Completed Not Billed"],
    ["unpaid", "Unpaid"],
    ["follow-up-needed", "Follow-Up Needed"]
  ];
  return `<div class="row">${filters.map(([value, label]) => `<a class="button ${activeFilter === value ? "secondary" : ""}" href="/desk/remote-sessions${value ? `?queue=${value}` : ""}">${esc(label)}</a>`).join("")}</div>`;
}

function remoteSessionQueueDefinitions() {
  return `<p class="muted">Consent Pending means the customer has not accepted Remote Assist consent yet. Completed not invoiced means the session is complete but no linked invoice exists. Follow-up needed comes from the session completion details.</p>`;
}

function remoteSessionLinkSummary(session) {
  return [
    session.customer ? `<a href="/desk/customers/${session.customer.id}">${esc(session.customer.name)}</a>` : "",
    session.ticket ? `<a href="/desk/tickets/${session.ticket.id}">${esc(session.ticket.ticketNumber)}</a>` : "",
    session.lead ? `<a href="/desk/leads/${session.lead.id}">${esc(session.lead.name)}</a>` : ""
  ].filter(Boolean).join("<br>") || `<span class="muted">No linked CRM records.</span>`;
}

function remoteSessionCustomerLink(session) {
  return `${siteUrl}/remote/live/${session.sessionCode}`;
}

function remoteSessionManualMessage(session) {
  const name = session.clientName || "there";
  return `Hi ${name}, this is 909 Signal IT. Please open this secure Remote Assist link when you are ready: ${remoteSessionCustomerLink(session)}. Before sharing your screen, please close passwords, banking pages, medical records, or private documents. You can stop sharing at any time.`;
}

function remoteSessionDeliveryActions(session, compact = false) {
  const linkId = `remote-customer-link-${session.id}`;
  const messageId = `remote-customer-message-${session.id}`;
  const emailAction = session.email
    ? `<form method="post" action="/desk/remote-sessions/${session.id}/email-link"><button>Email Remote Assist Link</button></form>`
    : `<span class="muted">No customer email.</span>`;
  const manualMessage = compact
    ? `<a href="/desk/remote-sessions/${session.id}">Manual message</a>`
    : `<label>Manual text/SMS message <textarea id="${esc(messageId)}" readonly>${esc(remoteSessionManualMessage(session))}</textarea></label><button class="button" type="button" data-copy-target="${esc(messageId)}">Copy Manual Message</button>`;
  return `<div class="row"><input id="${esc(linkId)}" class="copy-source" value="${esc(remoteSessionCustomerLink(session))}" readonly><button class="button" type="button" data-copy-target="${esc(linkId)}" data-audit-url="/desk/remote-sessions/${session.id}/audit-copy">Copy Customer Link</button>${emailAction}</div>${manualMessage}`;
}

function remoteAuditEntry(label, details = "", at = new Date()) {
  const safeLabel = String(label || "Remote activity").replaceAll("\n", " ").trim();
  const safeDetails = String(details || "").replaceAll("\n", " ").trim();
  return `[Remote Audit ${at.toISOString()}] ${safeLabel}${safeDetails ? ` - ${safeDetails}` : ""}`;
}

function appendRemoteAudit(notes, label, details = "", at = new Date()) {
  return [notes, remoteAuditEntry(label, details, at)].filter(Boolean).join("\n");
}

function parseRemoteAuditEvents(notes = "") {
  return String(notes || "").split("\n").map((line) => {
    const match = line.match(/^\[Remote Audit ([^\]]+)\]\s*(.+)$/);
    if (!match) return null;
    const detailParts = match[2].split(" - ");
    return {
      at: new Date(match[1]),
      label: detailParts.shift() || "Remote activity",
      details: detailParts.join(" - ")
    };
  }).filter((event) => event && !Number.isNaN(event.at.getTime()));
}

function remoteSessionActivityEvents(session) {
  const events = [
    { at: session.createdAt, label: "Session created", details: "Remote Assist session created" },
    session.consentAcceptedAt ? { at: session.consentAcceptedAt, label: "Consent accepted", details: "Customer accepted Remote Assist consent" } : null,
    session.approvedAt ? { at: session.approvedAt, label: "Session approved", details: "Session ready for remote support" } : null,
    session.startedAt ? { at: session.startedAt, label: "Session started", details: "Remote session marked active" } : null,
    session.liveViewStartedAt ? { at: session.liveViewStartedAt, label: "Screen share started", details: "Customer started browser screen sharing" } : null,
    session.liveViewEndedAt ? { at: session.liveViewEndedAt, label: "Screen share stopped", details: "Customer stopped browser screen sharing" } : null,
    session.endedAt ? { at: session.endedAt, label: "Session marked completed", details: "Remote session marked ended" } : null,
    ...parseRemoteAuditEvents(session.notes)
  ].filter((event) => event?.at && !Number.isNaN(new Date(event.at).getTime()));
  return events.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function remoteSessionLatestActivity(session) {
  const latest = remoteSessionActivityEvents(session)[0];
  return latest ? `${esc(latest.label)}<br><span class="muted">${displayDateTime(latest.at)}</span>` : `<span class="muted">No activity yet.</span>`;
}

function remoteSessionActivityTable(session) {
  const events = remoteSessionActivityEvents(session);
  return `<table><thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead><tbody>${events.map((event) => `<tr><td>${displayDateTime(event.at)}</td><td>${esc(event.label)}</td><td>${esc(event.details || "")}</td></tr>`).join("") || `<tr><td colspan="3">No remote activity yet.</td></tr>`}</tbody></table>`;
}

function remoteSessionCompletionSummary(session) {
  const notes = String(session.notes || "");
  const match = notes.match(/\[Remote Session Completion ([^\]]+)\]([\s\S]*?)(?=\n\n\[Remote |\n\[Remote Audit |\s*$)/);
  if (!match) return `<section class="card"><h2>Completion Record</h2><p class="muted">No completion summary saved yet.</p></section>`;
  const rows = match[2].trim().split("\n").map((line) => {
    const [label, ...rest] = line.split(":");
    return `<p><strong>${esc(label || "Detail")}:</strong><br>${esc(rest.join(":").trim() || "Not listed")}</p>`;
  }).join("");
  return `<section class="card"><h2>Completion Record</h2><p class="muted">Saved ${esc(match[1])}</p>${rows}</section>`;
}

function remoteSessionCompletionData(session) {
  const notes = String(session.notes || "");
  const match = notes.match(/\[Remote Session Completion ([^\]]+)\]([\s\S]*?)(?=\n\n\[Remote |\n\[Remote Audit |\s*$)/);
  const data = {
    issueWorkedOn: session.issueSummary || "",
    actionsTaken: "",
    outcome: "",
    recommendedNextSteps: "",
    followUpNeeded: "No",
    workOrderAction: "No action needed"
  };
  if (!match) return data;
  match[2].trim().split("\n").forEach((line) => {
    const [label, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (label === "Issue worked on") data.issueWorkedOn = value;
    if (label === "Actions taken") data.actionsTaken = value;
    if (label === "Outcome") data.outcome = value;
    if (label === "Recommended next steps") data.recommendedNextSteps = value;
    if (label === "Follow-up needed") data.followUpNeeded = value;
    if (label === "Invoice/work order action") data.workOrderAction = value;
  });
  return data;
}

function remoteSessionCustomerEmail(session = {}) {
  return session.email || session.customer?.email || session.lead?.email || session.ticket?.customer?.email || session.ticket?.lead?.email || "";
}

function remoteSessionCustomerName(session = {}) {
  return session.clientName || session.customer?.name || session.lead?.name || session.ticket?.customer?.name || session.ticket?.lead?.name || "there";
}

function remoteSessionPrimaryInvoice(session = {}) {
  return session.ticket?.invoices?.find((invoice) => invoice.paymentLink) || session.ticket?.invoices?.[0] || null;
}

function remoteSessionCloseoutData(session) {
  const completion = remoteSessionCompletionData(session);
  const invoice = remoteSessionPrimaryInvoice(session);
  return {
    customerName: remoteSessionCustomerName(session),
    email: remoteSessionCustomerEmail(session),
    subject: "909 Signal IT Remote Support Summary",
    issueWorkedOn: completion.issueWorkedOn || session.issueSummary || "Not listed",
    actionsTaken: completion.actionsTaken || "Not listed",
    outcome: completion.outcome || "Not listed",
    recommendedNextSteps: completion.recommendedNextSteps || "Not listed",
    followUpNeeded: completion.followUpNeeded || "No",
    invoiceNumber: invoice?.invoiceNumber || "",
    paymentLink: invoice?.paymentLink || "",
    reviewRequested: Boolean(session.ticket?.reviewRequested),
    googleReviewUrl: googleReviewLink
  };
}

function remoteSessionIsCompleted(session = {}) {
  const completion = remoteSessionCompletionData(session);
  return Boolean(session.status === "Ended" || session.endedAt || completion.actionsTaken || completion.outcome);
}

function remoteSessionWorkOrderSummary(session) {
  const completion = remoteSessionCompletionData(session);
  return [
    `Remote Assist session ${session.sessionCode}`,
    `Session date: ${displayDateTime(session.endedAt || session.liveViewEndedAt || session.createdAt)}`,
    `Issue worked on: ${completion.issueWorkedOn || "Not listed"}`,
    `Actions taken: ${completion.actionsTaken || "Not listed"}`,
    `Outcome: ${completion.outcome || "Not listed"}`,
    `Recommended next steps: ${completion.recommendedNextSteps || "Not listed"}`,
    `Follow-up needed: ${completion.followUpNeeded || "No"}`
  ].join("\n");
}

function remoteSessionBillingActions(session) {
  const completed = session.status === "Ended" || session.endedAt || remoteSessionCompletionData(session).actionsTaken;
  const ticket = session.ticket;
  const invoices = ticket?.invoices || [];
  const testDemo = remoteSessionIsTestDemo(session);
  if (!completed) {
    return `${testDemoNotice(testDemo, "Remote Assist session")}<section class="card"><h2>Billing and Follow-Up</h2><p class="muted">Complete the Remote Assist session before creating work orders, invoices, payment links, or review requests.</p></section>`;
  }
  const workOrderAction = ticket
    ? `<a class="button" href="/desk/tickets/${ticket.id}">Update Linked Work Order</a>`
    : `<form method="post" action="/desk/remote-sessions/${session.id}/ticket"><button>Create Work Order from Session</button></form>`;
  const invoiceActions = invoices.length
    ? invoices.map((invoice) => `<div class="row"><a class="button" href="/desk/invoices/${invoice.id}">Open ${esc(invoice.invoiceNumber)}</a>${invoice.paymentLink ? `<a class="button" href="/desk/invoices/${invoice.id}">Send Payment Link</a>` : `<a class="button" href="/desk/remote-sessions/${session.id}/invoices/${invoice.id}/payment-link/confirm">Confirm Payment Link</a>`}</div>`).join("")
    : `<form method="post" action="/desk/remote-sessions/${session.id}/invoice"><button>Create Invoice from Session</button></form>`;
  const reviewAction = ticket
    ? ticket.reviewRequested
      ? `<a class="button" href="/desk/tickets/${ticket.id}">Review Workflow Started</a>`
      : `<a class="button" href="/desk/remote-sessions/${session.id}/review-requested/confirm">Review Request Check</a>`
    : `<p class="muted">Create a work order before starting the review workflow.</p>`;
  return `${testDemoNotice(testDemo, "Remote Assist session")}${stripeModeNotice()}<section class="card">
    <h2>Billing and Follow-Up</h2>
    <p class="muted">Use the existing work order, invoice, Stripe payment link, and review workflow for this completed Remote Assist session.</p>
    <div class="row">${workOrderAction}<form method="post" action="/desk/remote-sessions/${session.id}/ticket-update"><button ${ticket ? "" : "disabled"}>Update Linked Work Order from Session</button></form></div>
    <h3>Invoices and Payment</h3>
    ${invoiceActions}
    <h3>Review</h3>
    ${reviewAction}
  </section>`;
}

function remoteSessionCloseoutActions(session) {
  if (!remoteSessionIsCompleted(session)) return "";
  const email = remoteSessionCustomerEmail(session);
  if (!email) {
    return `<section class="card"><h2>Customer Closeout Email</h2><p class="muted">Customer email required before sending a closeout summary.</p></section>`;
  }
  return `<section class="card"><h2>Customer Closeout Email</h2><p class="muted">Send a customer-facing summary without internal notes, audit entries, passwords, or screen details.</p><a class="button" href="/desk/remote-sessions/${session.id}/closeout-email/confirm">Send Closeout Email</a></section>`;
}

function remoteCloseoutConfirmationPage(session) {
  const closeout = remoteSessionCloseoutData(session);
  return layout("Confirm Closeout Email", `<section class="card">
    <div class="row"><h1>Confirm Closeout Email</h1><a class="button" href="/desk/remote-sessions/${session.id}">Back to Remote Session</a></div>
    <p class="muted">Review the customer-facing summary before sending. Internal notes and audit history are not included.</p>
    <div class="grid two">
      <p><strong>Recipient:</strong><br>${esc(closeout.email || "No customer email")}</p>
      <p><strong>Subject:</strong><br>${esc(closeout.subject)}</p>
      <p><strong>Issue worked on:</strong><br>${esc(closeout.issueWorkedOn)}</p>
      <p><strong>Actions taken:</strong><br>${esc(closeout.actionsTaken)}</p>
      <p><strong>Outcome:</strong><br>${esc(closeout.outcome)}</p>
      <p><strong>Next steps:</strong><br>${esc(closeout.recommendedNextSteps)}</p>
      <p><strong>Invoice/payment link included:</strong><br>${closeout.paymentLink ? "Yes" : "No"}</p>
      <p><strong>Review request included:</strong><br>${closeout.reviewRequested ? "Yes" : "No"}</p>
    </div>
    <form method="post" action="/desk/remote-sessions/${session.id}/closeout-email"><button ${closeout.email ? "" : "disabled"}>Confirm and Send Closeout Email</button></form>
  </section>`);
}

function remotePaymentConfirmationPage(session, invoice) {
  const lineDescription = invoice.lineItems?.[0]?.description || "Invoice service";
  return layout("Confirm Payment Link", `${testDemoNotice(remoteSessionIsTestDemo(session) || invoiceIsTestDemo(invoice), "Remote Assist invoice")}${stripeModeNotice()}
    <section class="card">
      <h1>Confirm Stripe Payment Link</h1>
      <p class="muted">Review this before generating a customer-facing Stripe Checkout link.</p>
      <div class="grid two">
        <p><strong>Customer:</strong><br>${esc(invoice.customerName)}<br>${esc(invoice.customerEmail || "")}<br>${esc(invoice.customerPhone || "")}</p>
        <p><strong>Invoice:</strong><br>${esc(invoice.invoiceNumber)}<br>${dollars(invoice.totalCents)}<br>${esc(lineDescription)}</p>
      </div>
      <p><strong>Stripe mode:</strong> ${esc(stripeModeLabel())}</p>
      <div class="row">
        <form method="post" action="/desk/remote-sessions/${session.id}/invoices/${invoice.id}/payment-link"><button>Confirm and Generate Payment Link</button></form>
        <a class="button" href="/desk/remote-sessions/${session.id}">Back to Remote Session</a>
      </div>
    </section>`);
}

function remoteReviewWarnings(session) {
  const ticket = session.ticket;
  const invoices = ticket?.invoices || [];
  const unpaidInvoices = invoices.filter((invoice) => !["Paid", "Void", "Refunded"].includes(invoice.status));
  const warnings = [];
  if (remoteSessionIsTestDemo(session) || ticketIsTestDemo(ticket)) warnings.push("This appears to be a test/demo session or work order.");
  if (unpaidInvoices.length) warnings.push(`There are ${unpaidInvoices.length} linked invoice(s) that are not paid yet.`);
  const hasContact = Boolean(ticket?.customer?.email || ticket?.customer?.phone || ticket?.lead?.email || ticket?.lead?.phone || session.email || session.phone);
  if (!hasContact) warnings.push("Customer email/phone is missing.");
  return warnings;
}

function remoteReviewConfirmationPage(session) {
  const warnings = remoteReviewWarnings(session);
  const reviewMessage = reviewFollowUpText(session.ticket);
  const reviewLinkStatus = googleReviewLink
    ? `<p class="muted"><strong>Google review link configured.</strong> The manual message can include the Google review link.</p>`
    : `<p class="danger"><strong>Google review link not configured.</strong> Add GOOGLE_REVIEW_URL in Railway to include a direct Google review link.</p>`;
  return layout("Confirm Review Request", `${testDemoNotice(remoteSessionIsTestDemo(session) || ticketIsTestDemo(session.ticket), "Remote Assist review request")}
    <section class="card">
      <h1>Review Request Check</h1>
      <p class="muted">Confirm this before starting the review request workflow for the linked work order.</p>
      ${reviewLinkStatus}
      ${warnings.length ? `<ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>` : `<p>No review request warnings detected.</p>`}
      <label>Manual review message <textarea readonly id="remote-review-message">${esc(reviewMessage)}</textarea></label>
      <div class="row"><button type="button" data-copy-target="remote-review-message">Copy Review Message</button></div>
      <div class="row">
        <form method="post" action="/desk/remote-sessions/${session.id}/review-requested"><button>Confirm and Start Review Request</button></form>
        <a class="button" href="/desk/remote-sessions/${session.id}">Back to Remote Session</a>
        <a class="button" href="/reviews.html" target="_blank" rel="noopener">Open Public Review Page</a>
      </div>
    </section>${copyScript()}`);
}

function remoteSessionSafetyNote() {
  return `<section class="card warning"><h2>Internal Safety Note</h2><p>Remote sessions require customer consent. Do not ask customers to expose passwords, banking pages, private documents, or sensitive personal information during screen sharing. The customer can stop sharing at any time.</p></section>`;
}

function remoteSessionDetailGrid(session) {
  return `<div class="grid two">
    <p><strong>Customer/session:</strong><br>${esc(session.clientName)}<br>${esc(session.phone)}<br>${esc(session.email || "")}</p>
    <p><strong>Related records:</strong><br>${remoteSessionLinkSummary(session)}</p>
    <p><strong>Status:</strong><br>${esc(session.status)}<br><strong>Consent:</strong> ${session.consentAccepted ? `Accepted ${displayDateTime(session.consentAcceptedAt)}` : "Not accepted"}</p>
    <p><strong>Live View:</strong><br>${esc(session.liveViewStatus || "Not Started")}<br><strong>Last connected:</strong> ${displayDateTime(session.liveViewLastConnectedAt)}</p>
    <p><strong>Created:</strong><br>${displayDateTime(session.createdAt)}<br><strong>Updated:</strong> ${displayDateTime(session.updatedAt)}</p>
    <p><strong>Started:</strong><br>${displayDateTime(session.startedAt || session.liveViewStartedAt)}<br><strong>Ended:</strong> ${displayDateTime(session.endedAt || session.liveViewEndedAt)}</p>
  </div>`;
}

function remoteSessionCompletionForm(session) {
  return `<form method="post" action="/desk/remote-sessions/${session.id}/complete">
    <h2>Session Completion Summary</h2>
    <p class="muted">Record what happened after the remote session ends. This is internal service history and can support tickets, work orders, or invoices.</p>
    <label>Issue worked on <textarea name="issueWorkedOn">${esc(session.issueSummary || "")}</textarea></label>
    <label>Actions taken <textarea name="actionsTaken"></textarea></label>
    <label>Outcome <textarea name="outcome"></textarea></label>
    <label>Recommended next steps <textarea name="recommendedNextSteps"></textarea></label>
    <label>Follow-up needed <select name="followUpNeeded"><option>No</option><option>Yes</option></select></label>
    <label>Invoice/work order action <select name="workOrderAction"><option>No action needed</option><option>Create or update ticket/work order</option><option>Create invoice</option><option>Review existing ticket before billing</option></select></label>
    <button>Save Completion and End Session</button>
  </form>`;
}

function remoteSessionCompletionNote(body) {
  return [`[Remote Session Completion ${new Date().toLocaleString()}]`,
    `Issue worked on: ${body.issueWorkedOn || "Not listed"}`,
    `Actions taken: ${body.actionsTaken || "Not listed"}`,
    `Outcome: ${body.outcome || "Not listed"}`,
    `Recommended next steps: ${body.recommendedNextSteps || "Not listed"}`,
    `Follow-up needed: ${body.followUpNeeded || "No"}`,
    `Invoice/work order action: ${body.workOrderAction || "No action needed"}`
  ].join("\n");
}

function followUpForm(title, action, values = {}, extra = "") {
  return `<form method="post" action="${esc(action)}">
    <h2>${esc(title)}</h2>
    <label>Follow-up date <input name="followUpAt" type="date" value="${dateOnlyValue(values.followUpAt)}"></label>
    <label>Follow-up note <textarea name="followUpNote">${esc(values.followUpNote || "")}</textarea></label>
    <button>Save Follow-Up</button>
    ${extra}
  </form>`;
}

function leadFollowUpText(lead) {
  return `Hi ${lead.name}, this is 909 Signal IT following up on your request for ${lead.serviceRequested}. Do you still need help? You can reply here or call/text 909-260-8660.`;
}

function invoiceFollowUpText(invoice) {
  const name = invoice.customerName || "there";
  const paymentLink = invoice.paymentLink || "[payment link not generated yet]";
  return `Hi ${name}, this is 909 Signal IT following up on invoice ${invoice.invoiceNumber}. Here is the secure payment link: ${paymentLink}. Thank you.`;
}

function reviewFollowUpText(ticket) {
  const name = ticket.customer?.name || ticket.lead?.name || "there";
  if (googleReviewLink) {
    return `Hi ${name}, this is 909 Signal IT. Thank you for choosing 909 Signal IT. If the service helped, an honest review would help nearby customers find reliable local IT support. You can leave a review here: ${googleReviewLink}`;
  }
  return `Hi ${name}, this is 909 Signal IT. Thank you for choosing 909 Signal IT. If the service helped, an honest review would help nearby customers find reliable local IT support. Please contact support@909signalit.com if there is anything else we can help with.`;
}

function copyInlineButton(id, text, label = "Copy Message") {
  return `<textarea class="copy-source" id="${esc(id)}" readonly>${esc(text)}</textarea><button class="button" type="button" data-copy-target="${esc(id)}">${esc(label)}</button>`;
}

function leadFollowUpTable(leads) {
  return `<table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Service</th><th>City</th><th>Created</th><th>Follow-up</th><th>Note</th><th></th></tr></thead><tbody>${leads.map((lead) => `
    <tr>
      <td><a href="/desk/leads/${lead.id}">${esc(lead.name)}</a></td>
      <td>${esc(lead.phone)}</td>
      <td>${esc(lead.email || "")}</td>
      <td>${esc(lead.serviceRequested)}</td>
      <td>${esc(lead.city)}</td>
      <td>${displayDate(lead.createdAt)}</td>
      <td>${displayDate(lead.followUpAt)}</td>
      <td>${esc(lead.followUpNote || "")}</td>
      <td>${copyInlineButton(`lead-follow-${lead.id}`, leadFollowUpText(lead))}</td>
    </tr>`).join("") || `<tr><td colspan="9">No lead follow-ups due.</td></tr>`}</tbody></table>`;
}

function invoiceFollowUpTable(invoices) {
  return `<table><thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Due</th><th>Status</th><th>Follow-up</th><th></th></tr></thead><tbody>${invoices.map((invoice) => `
    <tr>
      <td><a href="/desk/invoices/${invoice.id}">${esc(invoice.invoiceNumber)}</a></td>
      <td>${esc(invoice.customerName)}</td>
      <td>${dollars(invoice.totalCents)}</td>
      <td>${displayDate(invoice.dueDate)}</td>
      <td>${esc(invoice.status)}</td>
      <td>${displayDate(invoice.followUpAt)}</td>
      <td>${copyInlineButton(`invoice-follow-${invoice.id}`, invoiceFollowUpText(invoice))}</td>
    </tr>`).join("") || `<tr><td colspan="7">No invoice follow-ups due.</td></tr>`}</tbody></table>`;
}

function ticketFollowUpTable(tickets, emptyMessage = "No stale tickets.") {
  return `<table><thead><tr><th>Ticket</th><th>Customer</th><th>Service</th><th>Status</th><th>Last Updated</th><th>Follow-up</th></tr></thead><tbody>${tickets.map((ticket) => `
    <tr>
      <td><a href="/desk/tickets/${ticket.id}">${esc(ticket.ticketNumber)}</a></td>
      <td>${esc(ticket.customer?.name || ticket.lead?.name || "")}</td>
      <td>${esc(ticket.serviceType || "")}</td>
      <td>${esc(ticket.status)}</td>
      <td>${displayDate(ticket.updatedAt)}</td>
      <td>${displayDate(ticket.followUpAt)}</td>
    </tr>`).join("") || `<tr><td colspan="6">${esc(emptyMessage)}</td></tr>`}</tbody></table>`;
}

function reviewFollowUpTable(tickets) {
  return `<table><thead><tr><th>Ticket</th><th>Customer</th><th>Completed</th><th>Review Requested</th><th></th></tr></thead><tbody>${tickets.map((ticket) => `
    <tr>
      <td><a href="/desk/tickets/${ticket.id}">${esc(ticket.ticketNumber)}</a></td>
      <td>${esc(ticket.customer?.name || ticket.lead?.name || "")}</td>
      <td>${displayDate(ticket.completedAt)}</td>
      <td>${ticket.reviewRequested ? "Yes" : "No"}</td>
      <td>${copyInlineButton(`review-follow-${ticket.id}`, reviewFollowUpText(ticket))}</td>
    </tr>`).join("") || `<tr><td colspan="5">No review follow-ups due.</td></tr>`}</tbody></table>`;
}

function customerFollowUpTable(customers) {
  return `<table><thead><tr><th>Customer</th><th>Phone</th><th>Email</th><th>Follow-up</th><th>Note</th></tr></thead><tbody>${customers.map((customer) => `
    <tr>
      <td><a href="/desk/customers/${customer.id}">${esc(customer.name)}</a></td>
      <td>${esc(customer.phone || "")}</td>
      <td>${esc(customer.email || "")}</td>
      <td>${displayDate(customer.followUpAt)}</td>
      <td>${esc(customer.followUpNote || "")}</td>
    </tr>`).join("") || `<tr><td colspan="5">No customer follow-ups due.</td></tr>`}</tbody></table>`;
}

function expenseLinkSummary(expense) {
  const links = [];
  if (expense.customer) links.push(`<a href="/desk/customers/${expense.customer.id}">${esc(expense.customer.name)}</a>`);
  if (expense.ticket) links.push(`<a href="/desk/tickets/${expense.ticket.id}">${esc(expense.ticket.ticketNumber)}</a>`);
  if (expense.invoice) links.push(`<a href="/desk/invoices/${expense.invoice.id}">${esc(expense.invoice.invoiceNumber)}</a>`);
  return links.join("<br>") || "";
}

function expenseTable(expenses, emptyMessage = "No expenses yet.") {
  return `<table><thead><tr><th>Date</th><th>Description</th><th>Vendor</th><th>Category</th><th>Amount</th><th>Linked</th><th>Created</th><th></th></tr></thead><tbody>${expenses.map((expense) => `
    <tr>
      <td>${displayDate(expense.expenseDate)}</td>
      <td><a href="/desk/expenses/${expense.id}">${esc(expense.description)}</a></td>
      <td>${esc(expense.vendor || "")}</td>
      <td>${esc(expense.category)}</td>
      <td>${dollars(expense.amountCents)}</td>
      <td>${expenseLinkSummary(expense)}</td>
      <td>${displayDate(expense.createdAt)}</td>
      <td><a href="/desk/expenses/${expense.id}">View</a></td>
    </tr>`).join("") || `<tr><td colspan="8">${esc(emptyMessage)}</td></tr>`}</tbody></table>`;
}

function compactExpenseTable(expenses, emptyMessage) {
  return `<table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Amount</th><th></th></tr></thead><tbody>${expenses.map((expense) => `
    <tr>
      <td>${displayDate(expense.expenseDate)}</td>
      <td>${esc(expense.description)}</td>
      <td>${esc(expense.category)}</td>
      <td>${dollars(expense.amountCents)}</td>
      <td><a href="/desk/expenses/${expense.id}">View</a></td>
    </tr>`).join("") || `<tr><td colspan="5">${esc(emptyMessage)}</td></tr>`}</tbody></table>`;
}

function relatedSelectOptions(items, selected, labelFor) {
  return items.map((item) => `<option value="${item.id}"${String(item.id) === String(selected || "") ? " selected" : ""}>${esc(labelFor(item))}</option>`).join("");
}

function expenseForm(action, values = {}, lists = {}, message = "") {
  return `<form method="post" action="${esc(action)}">
    <h1>${values.id ? "Edit Expense" : "New Expense"}</h1>
    ${message}
    <label>Description <input name="description" value="${fieldValue(values, "description")}" required></label>
    <label>Vendor <input name="vendor" value="${fieldValue(values, "vendor")}"></label>
    <label>Category <select name="category" required><option value="">Select one</option>${statusOptions(expenseCategories, values.category)}</select></label>
    <label>Amount <input name="amount" value="${fieldValue(values, "amount")}" inputmode="decimal" required></label>
    <label>Expense date <input name="expenseDate" type="date" value="${fieldValue(values, "expenseDate", dateOnlyValue(new Date()))}" required></label>
    <label>Payment method <select name="paymentMethod"><option value="">Select one</option>${statusOptions(expensePaymentMethods, values.paymentMethod)}</select></label>
    <label>Customer <select name="customerId"><option value="">None</option>${relatedSelectOptions(lists.customers || [], values.customerId, (customer) => `${customer.name}${customer.businessName ? ` - ${customer.businessName}` : ""}`)}</select></label>
    <label>Ticket <select name="ticketId"><option value="">None</option>${relatedSelectOptions(lists.tickets || [], values.ticketId, (ticket) => `${ticket.ticketNumber} - ${ticket.title}`)}</select></label>
    <label>Invoice <select name="invoiceId"><option value="">None</option>${relatedSelectOptions(lists.invoices || [], values.invoiceId, (invoice) => `${invoice.invoiceNumber} - ${invoice.customerName}`)}</select></label>
    <label>Notes <textarea name="notes">${fieldValue(values, "notes")}</textarea></label>
    <button>Save Expense</button>
  </form>`;
}

async function expenseFormLists() {
  const [customers, tickets, invoices] = await Promise.all([
    prisma.customer.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }),
    prisma.ticket.findMany({ orderBy: { updatedAt: "desc" }, take: 200 }),
    prisma.invoice.findMany({ orderBy: { updatedAt: "desc" }, take: 200 })
  ]);
  return { customers, tickets, invoices };
}

function dashboardActivityItems(leads, tickets, invoices) {
  const items = [
    ...leads.map((lead) => ({
      type: "New lead",
      label: lead.serviceRequested || `Lead ${lead.id}`,
      name: lead.name,
      status: lead.status,
      date: lead.createdAt,
      href: `/desk/leads/${lead.id}`
    })),
    ...tickets.map((ticket) => ({
      type: ["Completed", "Closed"].includes(ticket.status) ? "Completed ticket" : "New ticket",
      label: `${ticket.ticketNumber} - ${ticket.title}`,
      name: ticket.customer?.name || ticket.lead?.name || "",
      status: ticket.status,
      date: ["Completed", "Closed"].includes(ticket.status) ? ticket.completedAt || ticket.updatedAt : ticket.createdAt,
      href: `/desk/tickets/${ticket.id}`
    })),
    ...invoices.map((invoice) => ({
      type: invoice.status === "Paid" ? "Paid invoice" : "New invoice",
      label: `${invoice.invoiceNumber} - ${dollars(invoice.totalCents)}`,
      name: invoice.customerName,
      status: invoice.status,
      date: invoice.status === "Paid" ? invoice.paidAt || invoice.updatedAt : invoice.createdAt,
      href: `/desk/invoices/${invoice.id}`
    }))
  ];
  return items.filter((item) => item.date).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10);
}

function ticketContactName(ticket) {
  return ticket.customer?.name || ticket.lead?.name || "Customer";
}

function ticketContactBlock(ticket) {
  const contact = ticket.customer || ticket.lead;
  if (!contact) return "No customer or lead linked.";
  const href = ticket.customer ? `/desk/customers/${ticket.customer.id}` : `/desk/leads/${ticket.lead.id}`;
  const detail = [contact.businessName, contact.phone, contact.email].filter(Boolean).join(" | ");
  return `<a href="${href}">${esc(contact.name)}</a>${detail ? `<br><span class="muted">${esc(detail)}</span>` : ""}`;
}

function partsSummary(ticket) {
  return ticket.partsUsed || ticket.partsNeeded || "None listed";
}

function finalPriceLabel(ticket) {
  return ticket.finalPrice != null ? formatMoneyValue(ticket.finalPrice) : "Not set";
}

function ticketCompletionText(ticket) {
  return `Hi, this is 909 Signal IT. Your service has been completed.

Issue: ${ticket.issue || "Not listed"}
Work performed: ${ticket.workPerformed || "Completed service work"}
Final amount: ${finalPriceLabel(ticket)}

Thank you for choosing 909 Signal IT.`;
}

function ticketCompletionEmail(ticket) {
  return `Hello ${ticketContactName(ticket)},

Your 909 Signal IT service has been completed.

Ticket: ${ticket.ticketNumber}
Service: ${ticket.serviceType || ticket.title || "IT Support"}
Issue reported:
${ticket.issue || "Not listed"}

Diagnosis:
${ticket.diagnosis || "Not listed"}

Work performed:
${ticket.workPerformed || "Completed service work"}

Parts / materials:
${partsSummary(ticket)}

Recommended next steps:
${ticket.recommendedNextSteps || "None listed"}

Final amount:
${finalPriceLabel(ticket)}

Thank you for choosing 909 Signal IT.

909 Signal IT
909-260-8660
support@909signalit.com`;
}

function copyButton(label, targetId) {
  return `<button class="button copy-button" type="button" data-copy-target="${targetId}">${esc(label)}</button>`;
}

function copyScript() {
  return `<script>
    document.querySelectorAll("[data-copy-target]").forEach((button) => {
      button.addEventListener("click", async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        if (!target) return;
        const text = target.value || target.textContent || "";
        try {
          await navigator.clipboard.writeText(text);
          if (button.dataset.auditUrl) {
            fetch(button.dataset.auditUrl, { method: "POST", keepalive: true }).catch(() => {});
          }
          const original = button.textContent;
          button.textContent = "Copied.";
          setTimeout(() => { button.textContent = original; }, 1600);
        } catch (error) {
          target.focus();
          if (target.select) target.select();
        }
      });
    });
  </script>`;
}

function completionSummaryPanel(ticket) {
  const shouldShow = ["Completed", "Closed"].includes(ticket.status) || ticket.workPerformed || ticket.customerNotes || ticket.finalPrice != null;
  if (!shouldShow) return "";
  const textMessage = ticketCompletionText(ticket);
  const emailSubject = `909 Signal IT Service Completed - Ticket ${ticket.ticketNumber}`;
  const emailBody = ticketCompletionEmail(ticket);
  return `<section class="card">
    <h2>Completion Summary</h2>
    <p><strong>Issue reported:</strong><br>${esc(ticket.issue || "Not listed")}</p>
    <p><strong>Diagnosis:</strong><br>${esc(ticket.diagnosis || "Not listed")}</p>
    <p><strong>Work performed:</strong><br>${esc(ticket.workPerformed || "Not listed")}</p>
    <p><strong>Parts used/needed:</strong><br>${esc(partsSummary(ticket))}</p>
    <p><strong>Final price:</strong> ${esc(finalPriceLabel(ticket))}</p>
    <p><strong>Recommended next steps:</strong><br>${esc(ticket.recommendedNextSteps || "None listed")}</p>
    <p>Thank you for choosing 909 Signal IT.</p>
    <div class="row">
      ${copyButton("Copy Completion Text", "completion-text")}
      ${copyButton("Copy Completion Email", "completion-email")}
      ${copyButton("Copy Customer Notes", "customer-notes-copy")}
    </div>
    <label>Text Message <textarea id="completion-text" readonly>${esc(textMessage)}</textarea></label>
    <label>Email Subject <input id="completion-subject" value="${esc(emailSubject)}" readonly></label>
    <label>Email Body <textarea id="completion-email" readonly>${esc(emailBody)}</textarea></label>
    <textarea id="customer-notes-copy" class="copy-source" readonly>${esc(ticket.customerNotes || "")}</textarea>
  </section>${copyScript()}`;
}

function ticketWorkOrderPage(ticket, notice = "") {
  const customerLabel = ticketContactBlock(ticket);
  const testDemo = ticketIsTestDemo(ticket);
  const linkedInvoices = ticket.invoices?.length
    ? ticket.invoices.map((invoice) => `<a href="/desk/invoices/${invoice.id}">${esc(invoice.invoiceNumber)}</a> (${esc(invoice.status)}, ${dollars(invoice.totalCents)})`).join("<br>")
    : `<span class="muted">No invoices linked yet.</span>`;
  const ticketExpenses = ticket.expenses || [];
  const requestReview = ["Completed", "Closed"].includes(ticket.status)
    ? ticketReviewRequestSection(ticket)
    : `<section class="card"><h2>Review Follow-Up</h2><p class="muted">Mark the work order completed before requesting a review.</p></section>`;
  return `${notice}${testDemoNotice(testDemo, "work order")}<section class="card">
      <div class="row">
        <h1>${esc(ticket.ticketNumber)}</h1>
        <form method="post" action="/desk/tickets/${ticket.id}/status"><input type="hidden" name="status" value="Scheduled"><button>Mark Scheduled</button></form>
        <form method="post" action="/desk/tickets/${ticket.id}/status"><input type="hidden" name="status" value="In Progress"><button>Mark In Progress</button></form>
        <form method="post" action="/desk/tickets/${ticket.id}/complete"><button>Mark Completed</button></form>
        <a class="button" href="/desk/invoices/new?ticketId=${ticket.id}">Create Invoice</a>
        <a class="button" href="/desk/expenses/new?ticketId=${ticket.id}">Add Expense for Ticket</a>
        <a class="button" href="/desk/tickets">Back to Tickets</a>
      </div>
      <div class="grid two">
        <p><strong>Customer/lead:</strong><br>${customerLabel}</p>
        <p><strong>Service type:</strong><br>${esc(ticket.serviceType || "")}</p>
        <p><strong>Status:</strong><br>${esc(ticket.status)}</p>
        <p><strong>Appointment:</strong><br>${displayDateTime(ticket.appointmentAt)}</p>
        <p><strong>Created:</strong><br>${displayDateTime(ticket.createdAt)}</p>
        <p><strong>Updated:</strong><br>${displayDateTime(ticket.updatedAt)}</p>
        <p><strong>Completed:</strong><br>${displayDateTime(ticket.completedAt)}</p>
        <p><strong>Linked invoices:</strong><br>${linkedInvoices}</p>
      </div>
    </section>
    <form class="work-order-form" method="post" action="/desk/tickets/${ticket.id}/update">
      <h2>Work Order</h2>
      <section class="card">
        <h3>Ticket Summary</h3>
        <label>Title <input name="title" value="${esc(ticket.title)}"></label>
        <label>Service type <select name="serviceType"><option value="">Select one</option>${statusOptions(serviceTypes, ticket.serviceType)}</select></label>
        <label>Status <select name="status">${statusOptions(ticketStatuses, ticket.status)}</select></label>
        <label>Appointment <input name="appointmentAt" type="datetime-local" value="${dateValue(ticket.appointmentAt)}"></label>
      </section>
      <section class="card">
        <h3>Reported Issue</h3>
        <label>Issue <textarea name="issue">${esc(ticket.issue || "")}</textarea></label>
      </section>
      <section class="card">
        <h3>Diagnosis</h3>
        <label>Diagnosis <textarea name="diagnosis">${esc(ticket.diagnosis || "")}</textarea></label>
      </section>
      <section class="card">
        <h3>Work Performed</h3>
        <label>Work performed <textarea name="workPerformed">${esc(ticket.workPerformed || "")}</textarea></label>
      </section>
      <section class="card">
        <h3>Parts / Materials</h3>
        <label>Parts needed <textarea name="partsNeeded">${esc(ticket.partsNeeded || "")}</textarea></label>
        <label>Parts used <textarea name="partsUsed">${esc(ticket.partsUsed || "")}</textarea></label>
      </section>
      <section class="card">
        <h3>Time / Pricing</h3>
        <label>Time spent minutes <input name="timeSpentMinutes" type="number" min="0" step="1" value="${esc(ticket.timeSpentMinutes ?? "")}"></label>
        <label>Price quoted <input name="priceQuoted" value="${money(ticket.priceQuoted)}"></label>
        <label>Final price <input name="finalPrice" value="${money(ticket.finalPrice)}"></label>
      </section>
      <section class="card">
        <h3>Customer-Facing Notes</h3>
        <label>Customer notes <textarea name="customerNotes">${esc(ticket.customerNotes || "")}</textarea></label>
      </section>
      <section class="card">
        <h3>Internal Notes</h3>
        <p class="muted">Internal only. Do not send these notes to customers.</p>
        <label>Internal notes <textarea name="internalNotes">${esc(ticket.internalNotes || "")}</textarea></label>
      </section>
      <section class="card">
        <h3>Recommended Next Steps</h3>
        <label>Recommended next steps <textarea name="recommendedNextSteps">${esc(ticket.recommendedNextSteps || "")}</textarea></label>
      </section>
      <section class="card">
        <h3>Review Status</h3>
        <label><input type="checkbox" name="reviewRequested" ${ticket.reviewRequested ? "checked" : ""}> Review requested</label>
        <label><input type="checkbox" name="reviewReceived" ${ticket.reviewReceived ? "checked" : ""}> Review received</label>
      </section>
      <button>Save Work Order</button>
    </form>
    ${followUpForm("Ticket Follow-Up", `/desk/tickets/${ticket.id}/follow-up`, ticket)}
    <section class="card"><h2>Remote Sessions</h2>${remoteSessionTable(ticket.remoteSessions || [])}</section>
    <section class="card"><h2>Related Expenses</h2>${compactExpenseTable(ticketExpenses, "No expenses connected to this ticket yet.")}</section>
    ${completionSummaryPanel(ticket)}
    ${requestReview}
    ${copyScript()}`;
}

function invoiceForm(action, values = {}, message = "") {
  const itemCount = Math.max(3, values.descriptions?.length || 0);
  const rows = Array.from({ length: itemCount }, (_, index) => `
    <div class="grid line-item-row">
      <label>Description <input name="description" list="invoice-service-options" value="${esc(values.descriptions?.[index] || "")}" ${index === 0 ? "required" : ""}></label>
      <label>Quantity <input name="quantity" type="number" min="1" step="1" value="${esc(values.quantities?.[index] || "1")}"></label>
      <label>Unit price <input name="unitPrice" inputmode="decimal" placeholder="0.00" value="${esc(values.unitPrices?.[index] || "")}" ${index === 0 ? "required" : ""}></label>
      <span></span>
    </div>`).join("");

  return `<form method="post" action="${esc(action)}">
    <h1>New Invoice</h1>
    ${message}
    <input type="hidden" name="customerId" value="${fieldValue(values, "customerId")}">
    <input type="hidden" name="ticketId" value="${fieldValue(values, "ticketId")}">
    <p class="muted">Estimate terms: This estimate is based on the information currently available and may change if additional issues, parts, labor, access problems, or customer-requested work are discovered. Estimate valid for 7 days unless otherwise stated. Client is responsible for backing up important data before service begins.</p>
    <section class="grid two">
      <label>Customer name <input name="customerName" value="${fieldValue(values, "customerName")}" required></label>
      <label>Customer email <input name="customerEmail" type="email" value="${fieldValue(values, "customerEmail")}"></label>
      <label>Customer phone <input name="customerPhone" value="${fieldValue(values, "customerPhone")}"></label>
      <label>Due date <input name="dueDate" type="date" value="${fieldValue(values, "dueDate")}"></label>
    </section>
    <h2>Line Items</h2>
    <section class="card quick-add-panel">
      <h2>Quick Add Service</h2>
      <div class="row">
        <label>Standard service <select id="quick-service-select"><option value="">Select a service</option>${serviceMenuOptions()}</select></label>
        <button type="button" id="add-standard-service">Add Selected Service</button>
      </div>
      <div class="row" aria-label="Suggested services">${quickServiceChips()}</div>
    </section>
    ${serviceDatalist()}
    <div id="line-items">${rows}</div>
    <section class="grid two">
      <label>Discount <input name="discount" inputmode="decimal" placeholder="0.00" value="${fieldValue(values, "discount")}"></label>
      <label>Tax <input name="tax" inputmode="decimal" placeholder="0.00" value="${fieldValue(values, "tax")}"></label>
    </section>
    <label>Notes <textarea name="notes">${fieldValue(values, "notes")}</textarea></label>
    <button type="submit">Save Draft</button>
  </form>
  <script>
    (() => {
      const services = ${JSON.stringify(standardServiceMenu.map((service) => ({ name: service.name, price: centsToInputValue(service.priceCents) })))};
      const lineItems = document.querySelector("#line-items");

      function addService(name, price) {
        if (!lineItems || !name || !price) return;
        const rows = Array.from(lineItems.querySelectorAll(".line-item-row"));
        const emptyRow = rows.find((row) => !row.querySelector('[name="description"]')?.value.trim());
        const row = emptyRow || rows[rows.length - 1]?.cloneNode(true);
        if (!row) return;
        row.querySelector('[name="description"]').value = name;
        row.querySelector('[name="quantity"]').value = "1";
        row.querySelector('[name="unitPrice"]').value = price;
        row.querySelectorAll("input").forEach((input) => { input.required = false; });
        if (!emptyRow) lineItems.appendChild(row);
      }

      document.querySelector("#add-standard-service")?.addEventListener("click", () => {
        const select = document.querySelector("#quick-service-select");
        if (!select?.value) return;
        const service = services[Number(select.value)];
        if (service) addService(service.name, service.price);
      });

      document.querySelectorAll("[data-service-name]").forEach((button) => {
        button.addEventListener("click", () => addService(button.dataset.serviceName, button.dataset.servicePrice));
      });
    })();
  </script>`;
}

function ticketForm(action, values = {}, message = "") {
  return `<form method="post" action="${esc(action)}">
    <h1>New Ticket</h1>
    ${message}
    <input type="hidden" name="customerId" value="${fieldValue(values, "customerId")}">
    ${values.customerName ? `<p class="muted">Customer: <strong>${esc(values.customerName)}</strong></p>` : ""}
    <label>Title <input name="title" value="${fieldValue(values, "title")}" required></label>
    <label>Service type <select name="serviceType"><option value="">Select one</option>${statusOptions(serviceTypes, values.serviceType)}</select></label>
    <label>Appointment <input name="appointmentAt" type="datetime-local" value="${fieldValue(values, "appointmentAt")}"></label>
    <label>Issue <textarea name="issue">${fieldValue(values, "issue")}</textarea></label>
    <label>Customer notes <textarea name="customerNotes">${fieldValue(values, "customerNotes")}</textarea></label>
    <button type="submit">Create Ticket</button>
  </form>`;
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const prefix = `SIG-${year}-`;
  const latest = await prisma.invoice.findFirst({
    where: { invoiceNumber: { startsWith: prefix } },
    orderBy: { invoiceNumber: "desc" }
  });
  const lastSequence = latest ? Number.parseInt(latest.invoiceNumber.slice(prefix.length), 10) : 0;
  return `${prefix}${String((Number.isFinite(lastSequence) ? lastSequence : 0) + 1).padStart(4, "0")}`;
}

function parseInvoiceInput(body) {
  const descriptions = Array.isArray(body.description) ? body.description : [body.description];
  const quantities = Array.isArray(body.quantity) ? body.quantity : [body.quantity];
  const unitPrices = Array.isArray(body.unitPrice) ? body.unitPrice : [body.unitPrice];
  const lineItems = descriptions.map((description, index) => {
    const trimmedDescription = String(description || "").trim();
    if (!trimmedDescription) return null;
    const quantity = parsePositiveInt(quantities[index], 1);
    const unitPriceCents = parseMoneyToCents(unitPrices[index]);
    if (unitPriceCents == null) return { error: "Line item prices must be valid positive amounts." };
    return {
      description: trimmedDescription,
      quantity,
      unitPriceCents,
      lineTotalCents: quantity * unitPriceCents
    };
  }).filter(Boolean);
  const invalidLine = lineItems.find((item) => item.error);
  if (invalidLine) return { error: invalidLine.error };
  if (!lineItems.length) return { error: "Add at least one invoice line item." };

  const subtotalCents = lineItems.reduce((total, item) => total + item.lineTotalCents, 0);
  const discountCents = parseMoneyToCents(body.discount);
  const taxCents = parseMoneyToCents(body.tax);
  if (discountCents == null || taxCents == null) return { error: "Tax and discount must be valid positive amounts." };
  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);

  return {
    lineItems,
    subtotalCents,
    discountCents,
    taxCents,
    totalCents
  };
}

function invoicePaymentMessages(invoice) {
  if (!invoice.paymentLink) {
    return `<section class="card"><h2>Send Payment Link</h2><p class="muted">Generate a payment link to unlock copy-ready client messages.</p></section>`;
  }

  const customerName = invoice.customerName || "there";
  const textMessage = `Hi, this is 909 Signal IT. Here is your secure payment link for today's IT service: ${invoice.paymentLink}. By paying this invoice, you acknowledge and agree to 909 Signal IT's service terms: ${serviceTermsUrl}. Thank you for choosing 909 Signal IT.`;
  const emailSubject = `909 Signal IT Invoice ${invoice.invoiceNumber}`;
  const emailBody = `Hello ${customerName},

Thank you for choosing 909 Signal IT. Your secure payment link is below:

${invoice.paymentLink}

Invoice: ${invoice.invoiceNumber}
Amount Due: ${dollars(invoice.totalCents)}

By paying this invoice, you acknowledge and agree to 909 Signal IT's service terms:
${serviceTermsUrl}

Please let me know if you have any questions.

Thank you,
909 Signal IT
909-260-8660
support@909signalit.com`;

  return `<section class="card">
    <h2>Send Payment Link</h2>
    <div class="grid two">
      <div>
        <h3>Text Message</h3>
        <textarea readonly id="invoice-text-message">${esc(textMessage)}</textarea>
        <div class="row"><button type="button" data-copy-target="invoice-text-message">Copy Text Message</button><span class="muted" data-copy-status="invoice-text-message"></span></div>
      </div>
      <div>
        <h3>Email Message</h3>
        <label>Subject <input readonly value="${esc(emailSubject)}"></label>
        <textarea readonly id="invoice-email-body">${esc(emailBody)}</textarea>
        <div class="row"><button type="button" data-copy-target="invoice-email-body">Copy Email Body</button><span class="muted" data-copy-status="invoice-email-body"></span></div>
      </div>
    </div>
    <label>Payment Link <input readonly id="invoice-payment-link" value="${esc(invoice.paymentLink)}"></label>
    <p class="muted">By paying this invoice, client agrees to the <a href="${serviceTermsUrl}" target="_blank" rel="noopener">909 Signal IT Service Terms</a>.</p>
    <div class="row"><button type="button" data-copy-target="invoice-payment-link">Copy Payment Link</button><span class="muted" data-copy-status="invoice-payment-link"></span></div>
  </section>
  <script>
    document.querySelectorAll("[data-copy-target]").forEach((button) => {
      button.addEventListener("click", async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        const status = document.querySelector('[data-copy-status="' + button.dataset.copyTarget + '"]');
        if (!target || !navigator.clipboard) return;
        await navigator.clipboard.writeText(target.value);
        if (status) {
          status.textContent = "Copied.";
          window.setTimeout(() => { status.textContent = ""; }, 1800);
        }
      });
    });
  </script>`;
}

function publicReviewsPage() {
  const reviewAction = googleReviewLink
    ? `<a class="button primary" href="${esc(googleReviewLink)}" target="_blank" rel="noopener">Leave an Honest Review</a>`
    : `<p class="muted"><strong>Google review link not configured.</strong> Please contact <a href="mailto:support@909signalit.com">support@909signalit.com</a> if you need help or want to share feedback.</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Reviews | 909 Signal IT</title>
    <meta name="description" content="Leave an honest review for 909 Signal IT or contact support for help with local IT support, computer repair, remote support, Wi-Fi, printers, and small business IT in Ontario, CA." />
    <meta property="og:title" content="Reviews | 909 Signal IT" />
    <meta property="og:description" content="Share honest feedback for 909 Signal IT or contact support for follow-up help." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://909signalit.com/reviews.html" />
    <meta property="og:image" content="https://909signalit.com/assets/cover-office.jpg" />
    <link rel="canonical" href="https://909signalit.com/reviews.html" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/"><span class="brand-909">909</span><span class="brand-text">Signal <strong>IT</strong></span><span class="brand-signal" aria-hidden="true"></span></a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
      <nav id="site-nav" class="site-nav" aria-label="Primary navigation">
        <a href="/">Home</a><a href="/services.html">Services</a><a href="/remote-support.html">Remote Support</a><a href="/business-it.html">Small Business</a><a href="/service-areas.html">Service Areas</a><a class="nav-cta" href="/contact.html">Contact</a>
      </nav>
    </header>
    <main>
      <section class="page-hero">
        <p class="eyebrow">Customer feedback</p>
        <h1>Review 909 Signal IT</h1>
        <p>Thank you for choosing 909 Signal IT. Honest reviews help nearby customers find reliable local IT support in Ontario, CA and nearby Inland Empire cities.</p>
        <div class="cta-row">
          ${reviewAction}
          <a class="button secondary" href="mailto:support@909signalit.com">Email support@909signalit.com</a>
          <a class="button ghost" href="/contact.html">Contact Support</a>
        </div>
      </section>
      <section class="section">
        <div class="section-heading">
          <p class="eyebrow">Helpful feedback</p>
          <h2>Share Your Experience</h2>
          <p>If 909 Signal IT helped with local IT support, computer repair, remote support, Wi-Fi troubleshooting, printer setup, small business IT support, Microsoft 365/email help, POS support, or network support, a quick honest review can help other local customers make a confident choice.</p>
          <p>If something still needs attention, please contact 909 Signal IT directly so the issue can be reviewed and followed up.</p>
        </div>
        <div class="services-list">
          <article><h2>Need follow-up?</h2><p>Call or text <a href="tel:+19092608660">909-260-8660</a> or email <a href="mailto:support@909signalit.com">support@909signalit.com</a>.</p></article>
          <article><h2>Service area</h2><p>909 Signal IT serves Ontario, Rancho Cucamonga, Fontana, Rialto, Upland, Montclair, Chino, Chino Hills, Eastvale, Pomona, Claremont, and nearby Inland Empire areas.</p></article>
        </div>
      </section>
    </main>
    <footer class="site-footer"><div class="footer-brand"><span class="brand footer-brand-logo" aria-label="909 Signal IT"><span class="brand-909">909</span><span class="brand-text">Signal <strong>IT</strong></span><span class="brand-signal" aria-hidden="true"></span></span><p>&copy; 2026 909 Signal IT. Local IT Support in Ontario, CA.</p></div><nav class="footer-links" aria-label="Footer links"><a href="/it-support-ontario-ca.html">IT Support Ontario CA</a><a href="/computer-repair-ontario-ca.html">Computer Repair Ontario CA</a><a href="/wifi-troubleshooting-ontario-ca.html">Wi-Fi Troubleshooting</a><a href="/printer-setup-ontario-ca.html">Printer Setup</a><a href="/remote-support.html">Remote Support</a><a href="/business-it.html">Business IT Support</a><a href="/reviews.html">Reviews</a><a href="/contact.html">Contact</a><a href="/terms.html">Service Terms</a></nav><p>Phone: <a href="tel:+19092608660">909-260-8660</a> - Email: <a href="mailto:support@909signalit.com">support@909signalit.com</a></p><p>Serving Ontario, CA and nearby Inland Empire cities.</p></footer>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`;
}

function ticketReviewRequestSection(ticket) {
  if (!["Completed", "Closed"].includes(ticket.status)) return "";

  const customerName = ticket.customer?.name || ticket.lead?.name || "there";
  const customerEmail = ticket.customer?.email || ticket.lead?.email || "";
  const linkStatus = googleReviewLink
    ? `<p class="muted"><strong>Google review link configured.</strong> Review request messages can include the Google review link.</p>`
    : `<p class="danger"><strong>Google review link not configured.</strong> Add GOOGLE_REVIEW_URL in Railway to include a direct Google review link. Manual follow-up copy is still available.</p>`;
  const textMessage = googleReviewLink
    ? `Thank you for choosing 909 Signal IT. If the service helped, an honest review would help nearby customers find reliable local IT support. You can leave a review here: ${googleReviewLink}`
    : "Thank you for choosing 909 Signal IT. If the service helped, an honest review would help nearby customers find reliable local IT support. Please contact support@909signalit.com if there is anything else we can help with.";
  const emailSubject = "How was your 909 Signal IT service?";
  const emailBody = `Hello ${customerName},

Thank you for choosing 909 Signal IT for your technology support.

If the service helped, an honest review would help nearby customers find reliable local IT support.
${googleReviewLink ? `
You can leave a review here:
${googleReviewLink}
` : `
Please contact support@909signalit.com if there is anything else we can help with.
`}

Thank you,
909 Signal IT
909-260-8660
support@909signalit.com`;
  const emailAction = customerEmail
    ? `<form method="post" action="/desk/tickets/${ticket.id}/review-email"><button>Email Review Request</button></form>`
    : `<p class="muted">Customer email required to send a review request email.</p>`;

  return `<section class="card">
    <h2>Request Google Review</h2>
    <p class="muted">Review status: ${reviewStatusLabel(ticket)}</p>
    ${linkStatus}
    <div class="grid two">
      <div>
        <h3>Text Message</h3>
        <textarea readonly id="review-text-message">${esc(textMessage)}</textarea>
        <div class="row"><button type="button" data-copy-target="review-text-message">Copy Review Text</button><span class="muted" data-copy-status="review-text-message"></span></div>
      </div>
      <div>
        <h3>Email Message</h3>
        <label>Subject <input readonly value="${esc(emailSubject)}"></label>
        <textarea readonly id="review-email-body">${esc(emailBody)}</textarea>
        <div class="row"><button type="button" data-copy-target="review-email-body">Copy Review Email</button><span class="muted" data-copy-status="review-email-body"></span></div>
      </div>
    </div>
    ${googleReviewLink ? `<label>Review Link <input readonly id="review-link" value="${esc(googleReviewLink)}"></label><div class="row"><button type="button" data-copy-target="review-link">Copy Google Review Link</button><span class="muted" data-copy-status="review-link"></span></div>` : `<p class="muted">Google review link not configured.</p>`}
    <div class="row">
      ${emailAction}
      <form method="post" action="/desk/tickets/${ticket.id}/review-requested"><button>Mark Review Requested</button></form>
      <form method="post" action="/desk/tickets/${ticket.id}/review-received"><button>Mark Review Received</button></form>
      <a class="button" href="/reviews.html" target="_blank" rel="noopener">Open Public Review Page</a>
    </div>
  </section>
  <script>
    document.querySelectorAll("[data-copy-target]").forEach((button) => {
      button.addEventListener("click", async () => {
        const target = document.getElementById(button.dataset.copyTarget);
        const status = document.querySelector('[data-copy-status="' + button.dataset.copyTarget + '"]');
        if (!target || !navigator.clipboard) return;
        await navigator.clipboard.writeText(target.value);
        if (status) {
          status.textContent = "Copied.";
          window.setTimeout(() => { status.textContent = ""; }, 1800);
        }
      });
    });
  </script>`;
}

async function generateInvoiceCheckoutSession(invoice) {
  if (!stripe) {
    return { error: "Stripe is not configured. Add STRIPE_SECRET_KEY in Railway to generate payment links." };
  }

  if (!invoice.lineItems.length || invoice.totalCents <= 0) {
    return { error: "Add billable line items before generating a payment link." };
  }

  const lineItems = invoice.lineItems.filter((item) => item.unitPriceCents > 0).map((item) => ({
    quantity: item.quantity,
    price_data: {
      currency: "usd",
      product_data: {
        name: item.description
      },
      unit_amount: item.unitPriceCents
    }
  }));

  if (!lineItems.length) {
    return { error: "Add billable line items before generating a payment link." };
  }

  if (invoice.taxCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        product_data: { name: "Tax" },
        unit_amount: invoice.taxCents
      }
    });
  }

  const discounts = [];
  if (invoice.discountCents > 0) {
    const coupon = await stripe.coupons.create({
      amount_off: invoice.discountCents,
      currency: "usd",
      duration: "once",
      name: `${invoice.invoiceNumber} discount`
    });
    discounts.push({ coupon: coupon.id });
  }

  const sessionParams = {
    mode: "payment",
    customer_email: invoice.customerEmail || undefined,
    line_items: lineItems,
    metadata: {
      invoiceId: String(invoice.id),
      invoiceNumber: invoice.invoiceNumber
    },
    success_url: `${siteUrl}/desk/invoices/${invoice.id}?payment=success`,
    cancel_url: `${siteUrl}/desk/invoices/${invoice.id}?payment=cancel`
  };
  if (discounts.length) sessionParams.discounts = discounts;

  const session = await stripe.checkout.sessions.create(sessionParams);

  return { session };
}

app.post("/api/leads", async (request, response) => {
  const body = request.body;
  const required = ["name", "phone", "city", "customerType", "serviceRequested", "urgency", "preferredContact", "message"];
  const missing = required.filter((field) => !String(body[field] || "").trim());
  if (missing.length) {
    response.status(400).json({ ok: false, message: "Please complete the required fields." });
    return;
  }

  try {
    const source = "Website Contact Form";
    const pageContext = String(body.pageContext || "").trim();
    const remoteSupportAcceptable = String(body.remoteSupportAcceptable || "").trim();
    const notes = [
      "Website lead received. Review and follow up from Signal Desk.",
      pageContext ? `Page/source context: ${pageContext}` : "",
      remoteSupportAcceptable ? `Remote support acceptable: ${remoteSupportAcceptable}` : "",
      body.notes?.trim() || ""
    ].filter(Boolean).join("\n");
    const lead = await prisma.lead.create({
      data: {
        name: body.name.trim(),
        phone: body.phone.trim(),
        email: body.email?.trim() || null,
        businessName: body.businessName?.trim() || null,
        customerType: body.customerType,
        city: body.city.trim(),
        serviceRequested: body.serviceRequested,
        urgency: body.urgency,
        preferredContact: body.preferredContact,
        message: body.message.trim(),
        source,
        status: "New Lead",
        notes: notes || null
      }
    });

    sendLeadNotification(lead).catch((error) => {
      console.error("Lead notification email failed:", error?.message || error);
    });
    sendLeadCustomerAcknowledgement(lead).catch((error) => {
      console.error("Lead customer acknowledgement email failed:", error?.message || error);
    });

    response.json({ ok: true, message: "Thanks - your request was received. 909 Signal IT will review the issue and follow up as soon as possible." });
  } catch (error) {
    console.error(error);
    response.status(500).json({ ok: false, message: "The request could not be saved. Please call or text 909-260-8660." });
  }
});

app.get("/remote", (request, response) => {
  response.send(publicRemotePage());
});

app.post("/remote", async (request, response) => {
  const body = request.body;
  const required = ["clientName", "phone", "issueSummary"];
  const missing = required.filter((field) => !String(body[field] || "").trim());
  if (missing.length || body.consentAccepted !== "yes") {
    response.status(400).send(publicRemotePage(`<section class="card"><p class="danger">Please complete the required fields and accept the consent terms.</p></section>`));
    return;
  }
  const ticketNumber = String(body.ticketNumber || "").trim();
  const ticket = ticketNumber ? await prisma.ticket.findFirst({ where: { ticketNumber } }) : null;
  const session = await prisma.remoteSession.create({
    data: {
      sessionCode: await generateRemoteSessionCode(),
      clientName: body.clientName.trim(),
      phone: body.phone.trim(),
      email: body.email?.trim() || null,
      company: body.company?.trim() || null,
      deviceType: remoteDeviceTypes.includes(body.deviceType) ? body.deviceType : null,
      issueSummary: body.issueSummary?.trim() || null,
      consentAccepted: true,
      consentAcceptedAt: new Date(),
      status: "Approved",
      approvedAt: new Date(),
      ticketId: ticket?.id || null,
      customerId: ticket?.customerId || null,
      leadId: ticket?.leadId || null
    }
  });
  response.send(publicRemotePage(`<section class="card"><h2>Your remote support request has been created.</h2><p>Give this code to 909 Signal IT: <strong>${esc(session.sessionCode)}</strong></p><p>A technician will guide you through the next step.</p><a class="button" href="/remote/live/${esc(session.sessionCode)}">Start Live View</a></section>`));
});

app.get("/remote/live/:sessionCode", async (request, response) => {
  const sessionCode = String(request.params.sessionCode || "").trim().toUpperCase();
  const session = await prisma.remoteSession.findUnique({ where: { sessionCode } });
  if (!session || ["Cancelled", "Ended"].includes(session.status)) {
    response.status(404).send(publicRemotePage(`<section class="card"><p class="danger">This Live View session is not available. Please contact 909 Signal IT.</p></section>`));
    return;
  }
  response.send(clientLiveViewPage(session));
});

app.get("/desk/login", (request, response) => {
  response.send(layout("Login", `<section class="card"><h1>909 Signal Desk Login</h1>${!adminConfigured() ? `<p class="danger">Admin environment variables are not fully configured.</p>` : ""}</section>
    <form method="post" action="/desk/login">
      <label>Username <input name="username" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Login</button>
    </form>`));
});

app.post("/desk/login", (request, response) => {
  if (request.body.username === process.env.ADMIN_USERNAME && request.body.password === process.env.ADMIN_PASSWORD) {
    request.session.adminAuthed = true;
    response.redirect("/desk");
    return;
  }
  response.status(401).send(layout("Login failed", `<section class="card"><h1>Login failed</h1><p class="danger">Invalid username or password.</p><a class="button" href="/desk/login">Try again</a></section>`));
});

app.get("/desk/logout", (request, response) => {
  request.session.destroy(() => response.redirect("/desk/login"));
});

app.get("/desk", requireAuth, async (request, response) => {
  const today = todayRange();
  const weekStart = lastSevenDaysStart();
  const thirtyDaysStart = lastThirtyDaysStart();
  const dueBefore = tomorrowStart();
  const staleBefore = daysAgoStart(3);
  const month = currentMonthRange();
  const completedStatus = { status: { in: ["Completed", "Closed"] } };
  const needsReviewWhere = { ...completedStatus, reviewRequested: false, reviewReceived: false };
  const leadFollowUpWhere = {
    status: { notIn: ["Completed", "Closed", "Lost"] },
    OR: [{ lastContactedAt: null }, { followUpAt: { lt: dueBefore } }]
  };
  const invoiceFollowUpWhere = { status: { in: ["Sent", "Partially Paid", "Overdue"] }, paidAt: null, OR: [{ followUpAt: null }, { followUpAt: { lt: dueBefore } }] };
  const ticketFollowUpWhere = {
    status: { in: ["New", "Scheduled", "In Progress", "Waiting on Customer"] },
    OR: [{ updatedAt: { lt: staleBefore } }, { followUpAt: { lt: dueBefore } }]
  };
  const reviewFollowUpWhere = {
    status: { in: ["Completed", "Closed"] },
    reviewRequested: true,
    reviewReceived: false,
    OR: [{ updatedAt: { lt: staleBefore } }, { followUpAt: { lt: dueBefore } }]
  };
  const openInvoiceStatuses = ["Draft", "Sent", "Partially Paid", "Overdue"];
  const sentUnpaidStatuses = ["Sent", "Partially Paid", "Overdue"];
  const nonVoidInvoiceWhere = { status: { notIn: ["Void", "Refunded"] } };

  const [
    newLeadsToday,
    newLeadsWeek,
    openLeads,
    convertedLeads,
    openTickets,
    scheduledJobs,
    inProgressJobs,
    completedThisMonth,
    ticketsNeedingInvoice,
    ticketsNeedingReview,
    draftInvoices,
    sentUnpaidInvoices,
    paidInvoicesThisMonth,
    paidRevenueThisMonth,
    expensesThisMonth,
    expensesLast30Days,
    openBalance,
    averageInvoiceTotal,
    reviewRequestsSent,
    reviewsReceived,
    leadsNeedingContact,
    invoiceFollowUps,
    ticketFollowUps,
    reviewFollowUps,
    remoteSessionsRequested,
    remoteSessionsActive,
    remoteSessionsConsentPending,
    remoteSessionsCompleted,
    remoteSessionsCompletedThisMonth,
    activeLiveViewSessions,
    recentLeads,
    recentTickets,
    recentInvoices,
    remoteSessionsForQueue
  ] = await Promise.all([
    prisma.lead.count({ where: { createdAt: { gte: today.start, lt: today.end } } }),
    prisma.lead.count({ where: { createdAt: { gte: weekStart } } }),
    prisma.lead.count({ where: { status: { notIn: ["Completed", "Closed", "Lost"] } } }),
    prisma.lead.count({ where: { OR: [{ tickets: { some: {} } }, { invoices: { some: {} } }] } }),
    prisma.ticket.count({ where: { status: { notIn: ["Completed", "Closed"] } } }),
    prisma.ticket.count({ where: { status: "Scheduled" } }),
    prisma.ticket.count({ where: { status: "In Progress" } }),
    prisma.ticket.count({ where: { ...completedStatus, completedAt: { gte: month.start, lt: month.end } } }),
    prisma.ticket.count({ where: { ...completedStatus, invoices: { none: {} } } }),
    prisma.ticket.count({ where: needsReviewWhere }),
    prisma.invoice.count({ where: { status: "Draft" } }),
    prisma.invoice.count({ where: { status: { in: sentUnpaidStatuses } } }),
    prisma.invoice.count({ where: { status: "Paid", paidAt: { gte: month.start, lt: month.end } } }),
    prisma.invoice.aggregate({ where: { status: "Paid", paidAt: { gte: month.start, lt: month.end } }, _sum: { totalCents: true } }),
    prisma.expense.aggregate({ where: { expenseDate: { gte: month.start, lt: month.end } }, _sum: { amountCents: true } }),
    prisma.expense.aggregate({ where: { expenseDate: { gte: thirtyDaysStart } }, _sum: { amountCents: true } }),
    prisma.invoice.aggregate({ where: { status: { in: openInvoiceStatuses } }, _sum: { totalCents: true } }),
    prisma.invoice.aggregate({ where: nonVoidInvoiceWhere, _avg: { totalCents: true } }),
    prisma.ticket.count({ where: { reviewRequested: true, reviewReceived: false } }),
    prisma.ticket.count({ where: { reviewReceived: true } }),
    prisma.lead.count({ where: leadFollowUpWhere }),
    prisma.invoice.count({ where: invoiceFollowUpWhere }),
    prisma.ticket.count({ where: ticketFollowUpWhere }),
    prisma.ticket.count({ where: reviewFollowUpWhere }),
    prisma.remoteSession.count({ where: { status: "Requested" } }),
    prisma.remoteSession.count({ where: { status: "Active" } }),
    prisma.remoteSession.count({ where: { consentAccepted: false } }),
    prisma.remoteSession.count({ where: { status: "Ended" } }),
    prisma.remoteSession.count({ where: { status: "Ended", endedAt: { gte: month.start, lt: month.end } } }),
    prisma.remoteSession.count({ where: { liveViewStatus: "Sharing" } }),
    prisma.lead.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.ticket.findMany({ include: { customer: true, lead: true }, orderBy: { updatedAt: "desc" }, take: 20 }),
    prisma.invoice.findMany({ orderBy: { updatedAt: "desc" }, take: 20 }),
    prisma.remoteSession.findMany({
      include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true },
      orderBy: { updatedAt: "desc" },
      take: 100
    })
  ]);

  const paidRevenueCents = paidRevenueThisMonth._sum.totalCents || 0;
  const expensesThisMonthCents = expensesThisMonth._sum.amountCents || 0;
  const expensesLast30DaysCents = expensesLast30Days._sum.amountCents || 0;
  const estimatedProfitCents = paidRevenueCents - expensesThisMonthCents;
  const openBalanceCents = openBalance._sum.totalCents || 0;
  const averageInvoiceCents = Math.round(averageInvoiceTotal._avg.totalCents || 0);
  const activityItems = dashboardActivityItems(recentLeads, recentTickets, recentInvoices);
  const remoteQueue = remoteSessionsForQueue.filter((session) => remoteSessionQueueMatches(session, "needs-attention")).slice(0, 10);
  const remoteLiveInProgress = remoteSessionsForQueue.filter((session) => remoteSessionQueueMatches(session, "in-progress")).length;
  const remoteCompletedNotInvoiced = remoteSessionsForQueue.filter(remoteSessionCompletedNotInvoiced).length;
  const remoteInvoicedUnpaid = remoteSessionsForQueue.filter(remoteSessionInvoicedUnpaid).length;
  const remoteFollowUpNeeded = remoteSessionsForQueue.filter(remoteSessionFollowUpNeeded).length;
  const remoteCloseoutNotSent = remoteSessionsForQueue.filter((session) => remoteSessionIsCompleted(session) && !remoteSessionCloseoutSent(session)).length;

  response.send(layout("Dashboard", `<section class="card">
    <div class="row"><h1>Dashboard</h1><a class="button" href="/desk/leads/new">Add Lead</a><a class="button" href="/desk/tickets">Tickets</a><a class="button" href="/desk/invoices">Invoices</a><a class="button" href="/desk/expenses">Expenses</a></div>
    <p class="muted">Daily command center. Week metrics use the last 7 days. Month metrics use the current server month.</p>
  </section>
  ${signalScanDashboardPanel()}
  <section class="card"><h2>Leads</h2><div class="grid">
    ${metricCard("New leads today", newLeadsToday)}
    ${metricCard("New leads last 7 days", newLeadsWeek)}
    ${metricCard("Open leads", openLeads)}
    ${metricCard("Converted leads", convertedLeads, "Lead has ticket or invoice")}
  </div></section>
  <section class="card"><h2>Tickets / Work Orders</h2><div class="grid">
    ${metricCard("Open tickets", openTickets)}
    ${metricCard("Scheduled jobs", scheduledJobs)}
    ${metricCard("In-progress jobs", inProgressJobs)}
    ${metricCard("Completed this month", completedThisMonth)}
    ${metricCard("Tickets needing invoice", ticketsNeedingInvoice)}
    ${metricCard("Tickets needing review request", ticketsNeedingReview)}
  </div></section>
  <section class="card"><h2>Invoices / Revenue</h2><div class="grid">
    ${metricCard("Draft invoices", draftInvoices)}
    ${metricCard("Sent/unpaid invoices", sentUnpaidInvoices)}
    ${metricCard("Paid invoices this month", paidInvoicesThisMonth)}
    ${metricCard("Paid revenue this month", dollars(paidRevenueCents))}
    ${metricCard("Expenses this month", dollars(expensesThisMonthCents))}
    ${metricCard("Expenses last 30 days", dollars(expensesLast30DaysCents))}
    ${metricCard("Estimated profit this month", dollars(estimatedProfitCents))}
    ${metricCard("Open balance", dollars(openBalanceCents))}
    ${metricCard("Average invoice total", dollars(averageInvoiceCents))}
  </div></section>
  <section class="card"><h2>Reviews</h2><div class="grid">
    ${metricCard("Review requests needed", ticketsNeedingReview)}
    ${metricCard("Review requests sent", reviewRequestsSent)}
    ${metricCard("Reviews received", reviewsReceived)}
  </div></section>
  <section class="card"><h2>Remote Assist</h2><div class="grid">
    ${metricCard("Active remote sessions", remoteSessionsActive)}
    ${metricCard("Consent pending", remoteSessionsConsentPending)}
    ${metricCard("Live/in-progress sessions", remoteLiveInProgress)}
    ${metricCard("Completed remote sessions", remoteSessionsCompleted)}
    ${metricCard("Completed this month", remoteSessionsCompletedThisMonth)}
    ${metricCard("Completed but not invoiced", remoteCompletedNotInvoiced)}
    ${metricCard("Invoiced but unpaid", remoteInvoicedUnpaid)}
    ${metricCard("Follow-up needed", remoteFollowUpNeeded)}
    ${metricCard("Closeout email not sent", remoteCloseoutNotSent)}
    ${attentionCard("Remote Sessions", remoteSessionsRequested + remoteSessionsActive + remoteCompletedNotInvoiced + remoteInvoicedUnpaid + remoteFollowUpNeeded + remoteCloseoutNotSent, "/desk/remote-sessions?queue=needs-attention")}
  </div>${remoteSessionQueueDefinitions()}</section>
  <section class="card"><h2>Remote Assist Queue</h2>${remoteSessionQueueTable(remoteQueue)}</section>
  <section class="card"><h2>Needs Attention</h2><div class="grid">
    ${attentionCard("Open leads", openLeads, "/desk/leads")}
    ${attentionCard("Tickets needing invoice", ticketsNeedingInvoice, "/desk/tickets")}
    ${attentionCard("Tickets needing review request", ticketsNeedingReview, "/desk/tickets")}
    ${attentionCard("Sent/unpaid invoices", sentUnpaidInvoices, "/desk/invoices")}
    ${attentionCard("Leads needing contact", leadsNeedingContact, "/desk/follow-ups")}
    ${attentionCard("Invoice follow-ups", invoiceFollowUps, "/desk/follow-ups")}
    ${attentionCard("Ticket follow-ups", ticketFollowUps, "/desk/follow-ups")}
    ${attentionCard("Review follow-ups", reviewFollowUps, "/desk/follow-ups")}
  </div></section>
  <section class="card"><h2>Reports & Exports</h2><p class="muted">Download CSV records for bookkeeping, taxes, and backups.</p><a class="button" href="/desk/reports">Open Reports</a></section>
  <section class="card"><h2>Recent Activity</h2>${activityItems.length ? recentActivityTable(activityItems) : `<p class="muted">No recent activity yet.</p>`}</section>`));
});

app.get("/desk/signalscan", requireAuth, (request, response) => {
  response.send(layout("SignalScan", signalScanDeskPage()));
});

app.get("/desk/follow-ups", requireAuth, async (request, response) => {
  const dueBefore = tomorrowStart();
  const staleBefore = daysAgoStart(3);
  const [leads, invoices, tickets, reviewTickets, customers] = await Promise.all([
    prisma.lead.findMany({
      where: { status: { notIn: ["Completed", "Closed", "Lost"] }, OR: [{ lastContactedAt: null }, { followUpAt: { lt: dueBefore } }] },
      orderBy: [{ followUpAt: "asc" }, { createdAt: "asc" }]
    }),
    prisma.invoice.findMany({
      where: { status: { in: ["Sent", "Partially Paid", "Overdue"] }, paidAt: null, OR: [{ followUpAt: null }, { followUpAt: { lt: dueBefore } }] },
      orderBy: [{ followUpAt: "asc" }, { dueDate: "asc" }]
    }),
    prisma.ticket.findMany({
      where: { status: { in: ["New", "Scheduled", "In Progress", "Waiting on Customer"] }, OR: [{ updatedAt: { lt: staleBefore } }, { followUpAt: { lt: dueBefore } }] },
      include: { customer: true, lead: true },
      orderBy: [{ followUpAt: "asc" }, { updatedAt: "asc" }]
    }),
    prisma.ticket.findMany({
      where: { status: { in: ["Completed", "Closed"] }, reviewRequested: true, reviewReceived: false, OR: [{ updatedAt: { lt: staleBefore } }, { followUpAt: { lt: dueBefore } }] },
      include: { customer: true, lead: true },
      orderBy: [{ followUpAt: "asc" }, { updatedAt: "asc" }]
    }),
    prisma.customer.findMany({
      where: { followUpAt: { lt: dueBefore } },
      orderBy: { followUpAt: "asc" }
    })
  ]);
  response.send(layout("Follow-Ups", `<section class="card">
    <h1>Follow-Ups</h1>
    <p class="muted">Internal reminders only. No automatic emails or texts are sent.</p>
  </section>
  <section class="card"><h2>Leads Needing Contact</h2>${leadFollowUpTable(leads)}</section>
  <section class="card"><h2>Unpaid Invoice Follow-Ups</h2>${invoiceFollowUpTable(invoices)}</section>
  <section class="card"><h2>Ticket Follow-Ups</h2>${ticketFollowUpTable(tickets)}</section>
  <section class="card"><h2>Review Follow-Ups</h2>${reviewFollowUpTable(reviewTickets)}</section>
  <section class="card"><h2>Customer Follow-Ups</h2>${customerFollowUpTable(customers)}</section>
  ${copyScript()}`));
});

app.get("/desk/remote-sessions", requireAuth, async (request, response) => {
  const status = String(request.query.status || "");
  const queue = String(request.query.queue || "");
  const sessions = await prisma.remoteSession.findMany({
    where: status && remoteSessionStatuses.includes(status) ? { status } : {},
    include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true },
    orderBy: { createdAt: "desc" }
  });
  const visibleSessions = queue ? sessions.filter((session) => remoteSessionQueueMatches(session, queue)) : sessions;
  response.send(layout("Remote Sessions", `<section class="card"><div class="row"><h1>Remote Sessions</h1><a class="button" href="/remote" target="_blank" rel="noopener">Open Client Portal</a></div><p class="muted">Consent-first tracking for 909 Signal Remote Assist. No hidden, unattended, or stealth access is provided.</p><form method="get" class="row"><label>Status <select name="status"><option value="">All statuses</option>${statusOptions(remoteSessionStatuses, status)}</select></label><button>Filter</button></form>${remoteSessionQueueDefinitions()}${remoteSessionQueueFilters(queue)}</section>${remoteSessionSafetyNote()}<section class="card"><h2>Remote Assist Queue</h2>${remoteSessionQueueTable(visibleSessions)}</section><section class="card"><h2>Remote Sessions</h2>${remoteSessionTable(visibleSessions)}</section>${copyScript()}`));
});

app.get("/desk/remote-sessions/:id", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({
    where: { id: request.params.id },
    include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true }
  });
  if (!session) return response.status(404).send(layout("Remote session not found", "<section class='card'>Remote session not found.</section>"));
  const deliveryStatus = request.query.email === "sent"
    ? `<section class="card"><p><strong>Remote Assist link email sent.</strong></p></section>`
    : request.query.email === "skipped"
      ? `<section class="card"><p class="danger">Remote Assist link email was skipped because no customer email or email configuration was available.</p></section>`
      : request.query.email === "failed"
        ? `<section class="card"><p class="danger">Remote Assist link email could not be sent. The session was not changed.</p></section>`
        : "";
  const closeoutStatus = request.query.closeout === "sent"
    ? `<section class="card"><p><strong>Closeout email sent.</strong></p></section>`
    : request.query.closeout === "skipped"
      ? `<section class="card"><p class="danger">Closeout email was skipped because no customer email or email configuration was available.</p></section>`
      : request.query.closeout === "failed"
        ? `<section class="card"><p class="danger">Closeout email could not be sent. The session was not changed.</p></section>`
        : "";
  response.send(layout(session.sessionCode, `<section class="card">
    <div class="row"><h1>${esc(session.sessionCode)}</h1><a class="button" href="/desk/remote-sessions">Back to Remote Sessions</a></div>
    ${remoteSessionDetailGrid(session)}
    <p><strong>Company:</strong> ${esc(session.company || "")}<br><strong>Device:</strong> ${esc(session.deviceType || "")}</p>
    <p><strong>Issue summary:</strong><br>${esc(session.issueSummary || "")}</p>
    <p><strong>Approved:</strong> ${displayDateTime(session.approvedAt)}<br><strong>Started:</strong> ${displayDateTime(session.startedAt)}<br><strong>Ended:</strong> ${displayDateTime(session.endedAt)}<br><strong>Created:</strong> ${displayDateTime(session.createdAt)}<br><strong>Updated:</strong> ${displayDateTime(session.updatedAt)}</p>
  </section>
  ${remoteSessionSafetyNote()}
  <section class="card row">
    <a class="button" href="/desk/remote-sessions/${session.id}/live">Open Live View</a>
    <form method="post" action="/desk/remote-sessions/${session.id}/status"><input type="hidden" name="status" value="Approved"><button>Approve Session</button></form>
    <form method="post" action="/desk/remote-sessions/${session.id}/status"><input type="hidden" name="status" value="Active"><button>Mark Active</button></form>
    <form method="post" action="/desk/remote-sessions/${session.id}/status"><input type="hidden" name="status" value="Ended"><button>Mark Ended</button></form>
    <form method="post" action="/desk/remote-sessions/${session.id}/status"><input type="hidden" name="status" value="Cancelled"><button>Cancel Session</button></form>
    <form method="post" action="/desk/remote-sessions/${session.id}/ticket"><button>Create Ticket from Remote Session</button></form>
  </section>
  ${deliveryStatus}
  ${closeoutStatus}
  <section class="card"><h2>Customer Link Delivery</h2><p class="muted">Send or copy the customer-facing Remote Assist link. This is the public consent/session page, not the technician view.</p>${remoteSessionDeliveryActions(session)}</section>
  ${remoteSessionBillingActions(session)}
  ${remoteSessionCloseoutActions(session)}
  <section class="card"><h2>Remote Assist Activity</h2>${remoteSessionActivityTable(session)}</section>
  ${remoteSessionCompletionSummary(session)}
  <form method="post" action="/desk/remote-sessions/${session.id}/update">
    <h2>Technician Notes</h2>
    <p class="muted">Do not store client passwords or sensitive personal information in session notes.</p>
    <label>Technician name <input name="technicianName" value="${esc(session.technicianName || "")}"></label>
    <label>Remote tool <input name="remoteTool" value="${esc(session.remoteTool || "")}" placeholder="Visible, client-approved tool only"></label>
    <label>Connection URL <input name="connectionUrl" value="${esc(session.connectionUrl || "")}"></label>
    <label>Notes <textarea name="notes">${esc(session.notes || "")}</textarea></label>
    <button>Save Notes</button>
  </form>
  ${remoteSessionCompletionForm(session)}
  ${copyScript()}`));
});

app.get("/desk/remote-sessions/:id/live", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.status(404).send(layout("Remote session not found", "<section class='card'>Remote session not found.</section>"));
  response.send(technicianLiveViewPage(session));
});

app.post("/desk/remote-sessions/:id/status", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.redirect("/desk/remote-sessions");
  const status = remoteSessionStatuses.includes(request.body.status) ? request.body.status : "Requested";
  const data = { status };
  if (status === "Approved") data.approvedAt = new Date();
  if (status === "Active") data.startedAt = new Date();
  if (status === "Ended") data.endedAt = new Date();
  data.notes = appendRemoteAudit(session.notes, `Status changed to ${status}`, "Updated in Signal Desk");
  await prisma.remoteSession.update({ where: { id: request.params.id }, data });
  response.redirect(`/desk/remote-sessions/${request.params.id}`);
});

app.post("/desk/remote-sessions/:id/update", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.redirect("/desk/remote-sessions");
  const notes = request.body.notes?.trim() || "";
  await prisma.remoteSession.update({
    where: { id: request.params.id },
    data: {
      technicianName: request.body.technicianName?.trim() || null,
      remoteTool: request.body.remoteTool?.trim() || null,
      connectionUrl: request.body.connectionUrl?.trim() || null,
      notes: appendRemoteAudit(notes, "Technician notes updated", "Remote session details saved")
    }
  });
  response.redirect(`/desk/remote-sessions/${request.params.id}`);
});

app.post("/desk/remote-sessions/:id/audit-copy", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.status(404).json({ ok: false });
  await prisma.remoteSession.update({
    where: { id: request.params.id },
    data: { notes: appendRemoteAudit(session.notes, "Customer link copied", "Remote Assist customer link copied in Signal Desk") }
  });
  response.json({ ok: true });
});

app.post("/desk/remote-sessions/:id/email-link", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.redirect("/desk/remote-sessions");
  try {
    const result = await sendRemoteAssistLinkEmail(session, remoteSessionCustomerLink(session));
    if (result?.skipped) {
      console.warn("Remote Assist link email skipped:", { sessionId: session.id, hasEmail: Boolean(session.email) });
      await prisma.remoteSession.update({
        where: { id: request.params.id },
        data: { notes: appendRemoteAudit(session.notes, "Email link skipped", session.email ? "Email configuration unavailable" : "No customer email available") }
      });
      response.redirect(`/desk/remote-sessions/${request.params.id}?email=skipped`);
      return;
    }
    console.log("Remote Assist link email sent:", { sessionId: session.id });
    await prisma.remoteSession.update({
      where: { id: request.params.id },
      data: { notes: appendRemoteAudit(session.notes, "Email link sent", "Remote Assist customer link emailed") }
    });
    response.redirect(`/desk/remote-sessions/${request.params.id}?email=sent`);
  } catch (error) {
    console.error("Remote Assist link email failed:", error?.message || error);
    await prisma.remoteSession.update({
      where: { id: request.params.id },
      data: { notes: appendRemoteAudit(session.notes, "Email link failed", "Remote Assist customer link email failed") }
    });
    response.redirect(`/desk/remote-sessions/${request.params.id}?email=failed`);
  }
});

app.get("/desk/remote-sessions/:id/closeout-email/confirm", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({
    where: { id: request.params.id },
    include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true }
  });
  if (!session) return response.redirect("/desk/remote-sessions");
  if (!remoteSessionIsCompleted(session)) return response.redirect(`/desk/remote-sessions/${request.params.id}`);
  await prisma.remoteSession.update({
    where: { id: session.id },
    data: { notes: appendRemoteAudit(session.notes, "Closeout email preview shown", "Remote Assist closeout summary preview opened") }
  });
  response.send(remoteCloseoutConfirmationPage(session));
});

app.post("/desk/remote-sessions/:id/closeout-email", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({
    where: { id: request.params.id },
    include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true }
  });
  if (!session) return response.redirect("/desk/remote-sessions");
  if (!remoteSessionIsCompleted(session)) return response.redirect(`/desk/remote-sessions/${request.params.id}`);
  const closeout = remoteSessionCloseoutData(session);
  try {
    const result = await sendRemoteAssistCloseoutEmail(closeout);
    if (result?.skipped) {
      await prisma.remoteSession.update({
        where: { id: session.id },
        data: { notes: appendRemoteAudit(session.notes, "Closeout email skipped", closeout.email ? "Email configuration unavailable" : "No customer email available") }
      });
      response.redirect(`/desk/remote-sessions/${request.params.id}?closeout=skipped`);
      return;
    }
    console.log("Remote Assist closeout email sent:", { sessionId: session.id });
    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { notes: appendRemoteAudit(session.notes, "Closeout email sent", "Remote Assist closeout summary emailed") }
    });
    response.redirect(`/desk/remote-sessions/${request.params.id}?closeout=sent`);
  } catch (error) {
    console.error("Remote Assist closeout email failed:", error?.message || error);
    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { notes: appendRemoteAudit(session.notes, "Closeout email failed", "Remote Assist closeout summary email failed") }
    });
    response.redirect(`/desk/remote-sessions/${request.params.id}?closeout=failed`);
  }
});

app.post("/desk/remote-sessions/:id/complete", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.redirect("/desk/remote-sessions");
  const completionNote = remoteSessionCompletionNote(request.body);
  const completionAudit = remoteAuditEntry("Completion summary saved", `Follow-up needed: ${request.body.followUpNeeded || "No"}; invoice/work order action: ${request.body.workOrderAction || "No action needed"}`);
  await prisma.remoteSession.update({
    where: { id: request.params.id },
    data: {
      status: "Ended",
      endedAt: new Date(),
      liveViewEndedAt: session.liveViewEndedAt || new Date(),
      notes: [session.notes, completionNote, completionAudit].filter(Boolean).join("\n\n")
    }
  });
  response.redirect(`/desk/remote-sessions/${request.params.id}`);
});

app.post("/desk/remote-sessions/:id/ticket", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.redirect("/desk/remote-sessions");
  if (session.ticketId) return response.redirect(`/desk/tickets/${session.ticketId}`);
  const completion = remoteSessionCompletionData(session);
  const ticket = await prisma.ticket.create({
    data: {
      ticketNumber: `909-${Date.now()}`,
      customerId: session.customerId,
      leadId: session.leadId,
      title: "Remote IT Support",
      serviceType: "Remote IT Support",
      issue: completion.issueWorkedOn || session.issueSummary,
      diagnosis: completion.outcome || null,
      workPerformed: completion.actionsTaken || null,
      customerNotes: remoteSessionWorkOrderSummary(session),
      internalNotes: `Created from Remote Assist session ${session.sessionCode}`,
      recommendedNextSteps: completion.recommendedNextSteps || null,
      appointmentAt: session.startedAt || session.liveViewStartedAt || session.createdAt,
      completedAt: session.endedAt || session.liveViewEndedAt || null,
      status: session.status === "Ended" || session.endedAt ? "Completed" : "New"
    }
  });
  await prisma.remoteSession.update({ where: { id: session.id }, data: { ticketId: ticket.id, notes: appendRemoteAudit(session.notes, "Work order created from session", `Ticket ${ticket.ticketNumber} created`) } });
  response.redirect(`/desk/tickets/${ticket.id}`);
});

app.post("/desk/remote-sessions/:id/ticket-update", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id }, include: { ticket: true } });
  if (!session) return response.redirect("/desk/remote-sessions");
  if (!session.ticketId || !session.ticket) return response.redirect(`/desk/remote-sessions/${request.params.id}`);
  const completion = remoteSessionCompletionData(session);
  await prisma.ticket.update({
    where: { id: session.ticketId },
    data: {
      serviceType: "Remote IT Support",
      issue: completion.issueWorkedOn || session.issueSummary || session.ticket.issue,
      diagnosis: completion.outcome || session.ticket.diagnosis,
      workPerformed: completion.actionsTaken || session.ticket.workPerformed,
      customerNotes: remoteSessionWorkOrderSummary(session),
      internalNotes: [session.ticket.internalNotes, `Updated from Remote Assist session ${session.sessionCode}`].filter(Boolean).join("\n\n"),
      recommendedNextSteps: completion.recommendedNextSteps || session.ticket.recommendedNextSteps,
      appointmentAt: session.ticket.appointmentAt || session.startedAt || session.liveViewStartedAt || session.createdAt,
      completedAt: session.ticket.completedAt || session.endedAt || session.liveViewEndedAt || null,
      status: session.status === "Ended" || session.endedAt ? "Completed" : session.ticket.status
    }
  });
  await prisma.remoteSession.update({
    where: { id: session.id },
    data: { notes: appendRemoteAudit(session.notes, "Linked work order updated", `Ticket ${session.ticket.ticketNumber} updated from Remote Assist completion`) }
  });
  response.redirect(`/desk/tickets/${session.ticketId}`);
});

app.post("/desk/remote-sessions/:id/invoice", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({
    where: { id: request.params.id },
    include: { ticket: { include: { customer: true, lead: true } }, customer: true, lead: true }
  });
  if (!session) return response.redirect("/desk/remote-sessions");
  const completion = remoteSessionCompletionData(session);
  let ticket = session.ticket;
  let auditNotes = session.notes;
  if (!ticket) {
    ticket = await prisma.ticket.create({
      data: {
        ticketNumber: `909-${Date.now()}`,
        customerId: session.customerId,
        leadId: session.leadId,
        title: "Remote IT Support",
        serviceType: "Remote IT Support",
        issue: completion.issueWorkedOn || session.issueSummary,
        diagnosis: completion.outcome || null,
        workPerformed: completion.actionsTaken || null,
        customerNotes: remoteSessionWorkOrderSummary(session),
        internalNotes: `Created from Remote Assist session ${session.sessionCode} before invoice generation`,
        recommendedNextSteps: completion.recommendedNextSteps || null,
        appointmentAt: session.startedAt || session.liveViewStartedAt || session.createdAt,
        completedAt: session.endedAt || session.liveViewEndedAt || null,
        status: "Completed"
      }
    });
    auditNotes = appendRemoteAudit(auditNotes, "Work order created from session", `Ticket ${ticket.ticketNumber} created before invoice generation`);
  }
  const remoteService = standardServiceMenu.find((service) => service.name === "Remote IT Support");
  const priceCents = remoteService?.priceCents || 0;
  const customerName = session.ticket?.customer?.name || session.customer?.name || session.ticket?.lead?.name || session.lead?.name || session.clientName || "Customer";
  const customerEmail = session.ticket?.customer?.email || session.customer?.email || session.ticket?.lead?.email || session.lead?.email || session.email || null;
  const customerPhone = session.ticket?.customer?.phone || session.customer?.phone || session.ticket?.lead?.phone || session.lead?.phone || session.phone || null;
  const description = `Remote IT Support - Session ${session.sessionCode}`;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: await nextInvoiceNumber(),
      customerId: ticket.customerId || session.customerId || null,
      leadId: ticket.leadId || session.leadId || null,
      ticketId: ticket.id,
      customerName,
      customerEmail,
      customerPhone,
      subtotalCents: priceCents,
      taxCents: 0,
      discountCents: 0,
      totalCents: priceCents,
      notes: [
        description,
        `Session date: ${displayDateTime(session.endedAt || session.liveViewEndedAt || session.createdAt)}`,
        completion.actionsTaken ? `Actions taken: ${completion.actionsTaken}` : "",
        completion.outcome ? `Outcome: ${completion.outcome}` : "",
        completion.recommendedNextSteps ? `Next steps: ${completion.recommendedNextSteps}` : ""
      ].filter(Boolean).join("\n"),
      status: "Draft",
      lineItems: {
        create: [{
          description,
          quantity: 1,
          unitPriceCents: priceCents,
          lineTotalCents: priceCents
        }]
      }
    }
  });
  await prisma.remoteSession.update({
    where: { id: session.id },
    data: { ticketId: ticket.id, notes: appendRemoteAudit(auditNotes, "Invoice created from session", `Invoice ${invoice.invoiceNumber} created`) }
  });
  response.redirect(`/desk/invoices/${invoice.id}`);
});

app.get("/desk/remote-sessions/:id/invoices/:invoiceId/payment-link/confirm", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({
    where: { id: request.params.id },
    include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true }
  });
  if (!session) return response.redirect("/desk/remote-sessions");
  const invoice = await prisma.invoice.findUnique({
    where: { id: Number(request.params.invoiceId) },
    include: { lineItems: true, customer: true, lead: true, ticket: { include: { customer: true, lead: true } } }
  });
  if (!invoice) return response.redirect(`/desk/remote-sessions/${request.params.id}`);
  await prisma.remoteSession.update({
    where: { id: session.id },
    data: { notes: appendRemoteAudit(session.notes, "Payment link confirmation shown", `${stripeModeLabel()} for invoice ${invoice.invoiceNumber}`) }
  });
  response.send(remotePaymentConfirmationPage(session, invoice));
});

app.post("/desk/remote-sessions/:id/invoices/:invoiceId/payment-link", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id } });
  if (!session) return response.redirect("/desk/remote-sessions");
  const invoice = await prisma.invoice.findUnique({
    where: { id: Number(request.params.invoiceId) },
    include: { lineItems: true }
  });
  if (!invoice) return response.redirect(`/desk/remote-sessions/${request.params.id}`);
  const confirmedNotes = appendRemoteAudit(session.notes, "Payment link confirmation accepted", `${stripeModeLabel()} for invoice ${invoice.invoiceNumber}`);
  try {
    const result = await generateInvoiceCheckoutSession(invoice);
    if (result.error) {
      await prisma.remoteSession.update({
        where: { id: session.id },
        data: { notes: appendRemoteAudit(confirmedNotes, "Payment link failed", `${stripeModeLabel()} - invoice ${invoice.invoiceNumber} payment link was not generated`) }
      });
      response.redirect(`/desk/invoices/${invoice.id}?stripe=${stripe ? "error" : "missing"}`);
      return;
    }
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        paymentLink: result.session.url,
        stripeCheckoutSessionId: result.session.id,
        status: invoice.status === "Draft" ? "Sent" : invoice.status,
        sentAt: invoice.sentAt || new Date()
      }
    });
    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { notes: appendRemoteAudit(confirmedNotes, "Payment link generated", `${stripeModeLabel()} - Stripe payment link generated for invoice ${invoice.invoiceNumber}`) }
    });
    response.redirect(`/desk/invoices/${invoice.id}`);
  } catch (error) {
    console.error(error);
    await prisma.remoteSession.update({
      where: { id: session.id },
      data: { notes: appendRemoteAudit(confirmedNotes, "Payment link failed", `${stripeModeLabel()} - invoice ${invoice.invoiceNumber} payment link generation failed`) }
    });
    response.redirect(`/desk/invoices/${invoice.id}?stripe=error`);
  }
});

app.get("/desk/remote-sessions/:id/review-requested/confirm", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({
    where: { id: request.params.id },
    include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true }
  });
  if (!session) return response.redirect("/desk/remote-sessions");
  if (!session.ticketId || !session.ticket) return response.redirect(`/desk/remote-sessions/${request.params.id}`);
  await prisma.remoteSession.update({
    where: { id: session.id },
    data: { notes: appendRemoteAudit(session.notes, "Review request warning shown", remoteReviewWarnings(session).join("; ") || "No warnings detected") }
  });
  response.send(remoteReviewConfirmationPage(session));
});

app.post("/desk/remote-sessions/:id/review-requested", requireAuth, async (request, response) => {
  const session = await prisma.remoteSession.findUnique({ where: { id: request.params.id }, include: { ticket: { include: { invoices: true, customer: true, lead: true } }, customer: true, lead: true } });
  if (!session) return response.redirect("/desk/remote-sessions");
  if (!session.ticketId || !session.ticket) return response.redirect(`/desk/remote-sessions/${request.params.id}`);
  await prisma.ticket.update({
    where: { id: session.ticketId },
    data: { reviewRequested: true }
  });
  await prisma.remoteSession.update({
    where: { id: session.id },
    data: { notes: appendRemoteAudit(session.notes, "Review workflow started", `Review warnings accepted; review requested for ticket ${session.ticket.ticketNumber}; Google review link configured: ${googleReviewLink ? "yes" : "no"}`) }
  });
  response.redirect(`/desk/tickets/${session.ticketId}`);
});

app.get("/desk/reports", requireAuth, async (request, response) => {
  const report = await monthlyReport(request.query.month);
  response.send(layout("Reports", `<section class="card">
    <h1>Reports</h1>
    <p class="muted">Download CSV records for backups, taxes, bookkeeping, and monthly review.</p>
  </section>
  <section class="card">
    <h2>Data Exports</h2>
    <div class="row">
      <a class="button" href="/desk/reports/export/leads.csv">Export Leads CSV</a>
      <a class="button" href="/desk/reports/export/customers.csv">Export Customers CSV</a>
      <a class="button" href="/desk/reports/export/tickets.csv">Export Tickets CSV</a>
      <a class="button" href="/desk/reports/export/invoices.csv">Export Invoices CSV</a>
      <a class="button" href="/desk/reports/export/expenses.csv">Export Expenses CSV</a>
      <a class="button" href="/desk/reports/export/remote-sessions.csv">Export Remote Sessions CSV</a>
    </div>
  </section>
  <section class="card">
    <h2>Monthly Business Report</h2>
    <form method="get" action="/desk/reports" class="row">
      <label>Month <input type="month" name="month" value="${esc(report.month)}"></label>
      <button>View Month</button>
      <a class="button" href="/desk/reports/export/monthly.csv?month=${esc(report.month)}">Export Monthly Report CSV</a>
    </form>
    <div class="grid">
      ${metricCard("Paid revenue", dollars(report.paidRevenueCents))}
      ${metricCard("Expenses", dollars(report.expenseCents))}
      ${metricCard("Estimated profit", dollars(report.estimatedProfitCents))}
      ${metricCard("Total invoiced", dollars(report.totalInvoicedCents))}
      ${metricCard("Open balance", dollars(report.openBalanceCents))}
      ${metricCard("New leads", report.newLeads)}
      ${metricCard("Converted leads", report.convertedLeads)}
      ${metricCard("Completed jobs", report.completedJobs)}
      ${metricCard("Paid invoices", report.paidInvoices)}
      ${metricCard("Unpaid invoices", report.unpaidInvoices)}
      ${metricCard("Review requests sent", report.reviewRequestsSent)}
      ${metricCard("Reviews received", report.reviewsReceived)}
    </div>
  </section>
  <section class="card">
    <h2>Bookkeeping Helper</h2>
    <p class="muted">Use invoice and expense exports for bookkeeping and tax preparation. Estimated profit is calculated as paid revenue minus recorded expenses.</p>
  </section>`));
});

app.get("/desk/reports/export/leads.csv", requireAuth, async (request, response) => {
  const leads = await prisma.lead.findMany({ orderBy: { createdAt: "desc" } });
  sendCsv(response, "leads", [
    ["id", "createdAt", "updatedAt", "name", "phone", "email", "city", "serviceType", "urgency", "status", "source", "message"],
    ...leads.map((lead) => [lead.id, isoDate(lead.createdAt), isoDate(lead.updatedAt), lead.name, lead.phone, lead.email, lead.city, lead.serviceRequested, lead.urgency, lead.status, lead.source, lead.message])
  ]);
});

app.get("/desk/reports/export/customers.csv", requireAuth, async (request, response) => {
  const customers = await prisma.customer.findMany({ orderBy: { updatedAt: "desc" } });
  sendCsv(response, "customers", [
    ["id", "createdAt", "updatedAt", "name", "businessName", "customerType", "phone", "email", "city", "address", "notes"],
    ...customers.map((customer) => [customer.id, isoDate(customer.createdAt), isoDate(customer.updatedAt), customer.name, customer.businessName, customer.customerType, customer.phone, customer.email, customer.city, customer.address, customer.notes])
  ]);
});

app.get("/desk/reports/export/tickets.csv", requireAuth, async (request, response) => {
  const tickets = await prisma.ticket.findMany({ include: { customer: true, lead: true }, orderBy: { updatedAt: "desc" } });
  sendCsv(response, "tickets", [
    ["id", "ticketNumber", "createdAt", "updatedAt", "completedAt", "customerName", "customerPhone", "customerEmail", "serviceType", "status", "issue", "diagnosis", "workPerformed", "partsNeeded", "partsUsed", "timeSpentMinutes", "priceQuoted", "finalPrice", "reviewRequested", "reviewReceived"],
    ...tickets.map((ticket) => {
      const contact = ticket.customer || ticket.lead || {};
      return [ticket.id, ticket.ticketNumber, isoDate(ticket.createdAt), isoDate(ticket.updatedAt), isoDate(ticket.completedAt), contact.name, contact.phone, contact.email, ticket.serviceType, ticket.status, ticket.issue, ticket.diagnosis, ticket.workPerformed, ticket.partsNeeded, ticket.partsUsed, ticket.timeSpentMinutes, ticket.priceQuoted, ticket.finalPrice, ticket.reviewRequested, ticket.reviewReceived];
    })
  ]);
});

app.get("/desk/reports/export/invoices.csv", requireAuth, async (request, response) => {
  const invoices = await prisma.invoice.findMany({ orderBy: { createdAt: "desc" } });
  sendCsv(response, "invoices", [
    ["id", "invoiceNumber", "createdAt", "updatedAt", "dueDate", "paidAt", "customerName", "customerEmail", "customerPhone", "status", "total", "subtotal", "tax", "stripeCheckoutSessionId", "stripePaymentLinkUrl"],
    ...invoices.map((invoice) => [invoice.id, invoice.invoiceNumber, isoDate(invoice.createdAt), isoDate(invoice.updatedAt), isoDate(invoice.dueDate), isoDate(invoice.paidAt), invoice.customerName, invoice.customerEmail, invoice.customerPhone, invoice.status, moneyCsv(invoice.totalCents), moneyCsv(invoice.subtotalCents), moneyCsv(invoice.taxCents), invoice.stripeCheckoutSessionId, invoice.paymentLink])
  ]);
});

app.get("/desk/reports/export/expenses.csv", requireAuth, async (request, response) => {
  const expenses = await prisma.expense.findMany({ include: { customer: true, ticket: true, invoice: true }, orderBy: { expenseDate: "desc" } });
  sendCsv(response, "expenses", [
    ["id", "createdAt", "updatedAt", "expenseDate", "description", "vendor", "category", "amount", "paymentMethod", "customerName", "ticketId", "invoiceId", "notes"],
    ...expenses.map((expense) => [expense.id, isoDate(expense.createdAt), isoDate(expense.updatedAt), isoDate(expense.expenseDate), expense.description, expense.vendor, expense.category, moneyCsv(expense.amountCents), expense.paymentMethod, expense.customer?.name, expense.ticketId, expense.invoiceId, expense.notes])
  ]);
});

app.get("/desk/reports/export/remote-sessions.csv", requireAuth, async (request, response) => {
  const sessions = await prisma.remoteSession.findMany({ orderBy: { createdAt: "desc" } });
  sendCsv(response, "remote-sessions", [
    ["sessionCode", "clientName", "phone", "email", "company", "deviceType", "issueSummary", "consentAccepted", "consentAcceptedAt", "status", "liveViewStatus", "liveViewStartedAt", "liveViewEndedAt", "liveViewLastConnectedAt", "approvedAt", "startedAt", "endedAt", "remoteTool", "createdAt"],
    ...sessions.map((session) => [session.sessionCode, session.clientName, session.phone, session.email, session.company, session.deviceType, session.issueSummary, session.consentAccepted, isoDate(session.consentAcceptedAt), session.status, session.liveViewStatus, isoDate(session.liveViewStartedAt), isoDate(session.liveViewEndedAt), isoDate(session.liveViewLastConnectedAt), isoDate(session.approvedAt), isoDate(session.startedAt), isoDate(session.endedAt), session.remoteTool, isoDate(session.createdAt)])
  ]);
});

app.get("/desk/reports/export/monthly.csv", requireAuth, async (request, response) => {
  const report = await monthlyReport(request.query.month);
  sendCsv(response, `monthly-${report.month}`, monthlyReportRows(report));
});

app.get("/desk/expenses", requireAuth, async (request, response) => {
  const category = String(request.query.category || "");
  const range = String(request.query.range || "month");
  const now = new Date();
  const month = currentMonthRange();
  const thirtyDaysStart = lastThirtyDaysStart();
  const where = {
    AND: [
      category ? { category } : {},
      range === "month" ? { expenseDate: { gte: month.start, lt: month.end } } : {},
      range === "30" ? { expenseDate: { gte: thirtyDaysStart, lte: now } } : {}
    ]
  };
  const expenses = await prisma.expense.findMany({
    where,
    include: { customer: true, ticket: true, invoice: true },
    orderBy: { expenseDate: "desc" }
  });
  const totalCents = expenses.reduce((total, expense) => total + expense.amountCents, 0);
  response.send(layout("Expenses", `<section class="card">
    <div class="row"><h1>Expenses</h1><a class="button" href="/desk/expenses/new">Add Expense</a></div>
    <form method="get" class="row">
      <label>Category <select name="category"><option value="">All categories</option>${statusOptions(expenseCategories, category)}</select></label>
      <label>Range <select name="range"><option value="month"${range === "month" ? " selected" : ""}>Current month</option><option value="30"${range === "30" ? " selected" : ""}>Last 30 days</option><option value="all"${range === "all" ? " selected" : ""}>All</option></select></label>
      <button>Filter</button>
    </form>
    <p>Total: <strong>${dollars(totalCents)}</strong></p>
  </section>${expenseTable(expenses)}`));
});

app.get("/desk/expenses/new", requireAuth, async (request, response) => {
  const lists = await expenseFormLists();
  const customerId = Number(request.query.customerId);
  const ticketId = Number(request.query.ticketId);
  const invoiceId = Number(request.query.invoiceId);
  const [ticket, invoice] = await Promise.all([
    Number.isInteger(ticketId) && ticketId > 0 ? prisma.ticket.findUnique({ where: { id: ticketId } }) : null,
    Number.isInteger(invoiceId) && invoiceId > 0 ? prisma.invoice.findUnique({ where: { id: invoiceId } }) : null
  ]);
  const values = {
    category: "Parts / Hardware",
    expenseDate: dateOnlyValue(new Date()),
    customerId: ticket?.customerId || invoice?.customerId || (Number.isInteger(customerId) && customerId > 0 ? customerId : ""),
    ticketId: ticket?.id || invoice?.ticketId || "",
    invoiceId: invoice?.id || ""
  };
  response.send(layout("New Expense", expenseForm("/desk/expenses/new", values, lists)));
});

app.post("/desk/expenses/new", requireAuth, async (request, response) => {
  const lists = await expenseFormLists();
  const amountCents = parseMoneyToCents(request.body.amount);
  const expenseDate = request.body.expenseDate ? new Date(`${request.body.expenseDate}T12:00:00`) : null;
  const values = { ...request.body };
  if (!String(request.body.description || "").trim() || !expenseCategories.includes(request.body.category) || !expenseDate || amountCents == null || amountCents <= 0) {
    response.status(400).send(layout("New Expense", expenseForm("/desk/expenses/new", values, lists, `<p class="danger">Description, category, positive amount, and expense date are required.</p>`)));
    return;
  }
  const customerId = Number(request.body.customerId);
  const ticketId = Number(request.body.ticketId);
  const invoiceId = Number(request.body.invoiceId);
  const expense = await prisma.expense.create({
    data: {
      description: request.body.description.trim(),
      vendor: request.body.vendor?.trim() || null,
      category: request.body.category,
      amountCents,
      expenseDate,
      paymentMethod: expensePaymentMethods.includes(request.body.paymentMethod) ? request.body.paymentMethod : null,
      notes: request.body.notes?.trim() || null,
      customerId: Number.isInteger(customerId) && customerId > 0 ? customerId : null,
      ticketId: Number.isInteger(ticketId) && ticketId > 0 ? ticketId : null,
      invoiceId: Number.isInteger(invoiceId) && invoiceId > 0 ? invoiceId : null
    }
  });
  response.redirect(`/desk/expenses/${expense.id}`);
});

app.get("/desk/expenses/:id", requireAuth, async (request, response) => {
  const expense = await prisma.expense.findUnique({
    where: { id: request.params.id },
    include: { customer: true, ticket: true, invoice: true }
  });
  if (!expense) return response.status(404).send(layout("Expense not found", "<section class='card'>Expense not found.</section>"));
  const lists = await expenseFormLists();
  const values = {
    id: expense.id,
    description: expense.description,
    vendor: expense.vendor || "",
    category: expense.category,
    amount: centsToInputValue(expense.amountCents),
    expenseDate: dateOnlyValue(expense.expenseDate),
    paymentMethod: expense.paymentMethod || "",
    notes: expense.notes || "",
    customerId: expense.customerId || "",
    ticketId: expense.ticketId || "",
    invoiceId: expense.invoiceId || ""
  };
  response.send(layout("Expense", `<section class="card">
    <div class="row"><h1>${esc(expense.description)}</h1><a class="button" href="/desk/expenses">Back to Expenses</a></div>
    <p><strong>Amount:</strong> ${dollars(expense.amountCents)}<br><strong>Date:</strong> ${displayDate(expense.expenseDate)}<br><strong>Vendor:</strong> ${esc(expense.vendor || "")}<br><strong>Category:</strong> ${esc(expense.category)}</p>
    <p><strong>Linked records:</strong><br>${expenseLinkSummary(expense) || `<span class="muted">No linked customer, ticket, or invoice.</span>`}</p>
    ${expense.notes ? `<p><strong>Notes:</strong><br>${esc(expense.notes)}</p>` : ""}
  </section>${expenseForm(`/desk/expenses/${expense.id}/update`, values, lists)}`));
});

app.post("/desk/expenses/:id/update", requireAuth, async (request, response) => {
  const lists = await expenseFormLists();
  const amountCents = parseMoneyToCents(request.body.amount);
  const expenseDate = request.body.expenseDate ? new Date(`${request.body.expenseDate}T12:00:00`) : null;
  if (!String(request.body.description || "").trim() || !expenseCategories.includes(request.body.category) || !expenseDate || amountCents == null || amountCents <= 0) {
    response.status(400).send(layout("Edit Expense", expenseForm(`/desk/expenses/${request.params.id}/update`, { ...request.body, id: request.params.id }, lists, `<p class="danger">Description, category, positive amount, and expense date are required.</p>`)));
    return;
  }
  const customerId = Number(request.body.customerId);
  const ticketId = Number(request.body.ticketId);
  const invoiceId = Number(request.body.invoiceId);
  await prisma.expense.update({
    where: { id: request.params.id },
    data: {
      description: request.body.description.trim(),
      vendor: request.body.vendor?.trim() || null,
      category: request.body.category,
      amountCents,
      expenseDate,
      paymentMethod: expensePaymentMethods.includes(request.body.paymentMethod) ? request.body.paymentMethod : null,
      notes: request.body.notes?.trim() || null,
      customerId: Number.isInteger(customerId) && customerId > 0 ? customerId : null,
      ticketId: Number.isInteger(ticketId) && ticketId > 0 ? ticketId : null,
      invoiceId: Number.isInteger(invoiceId) && invoiceId > 0 ? invoiceId : null
    }
  });
  response.redirect(`/desk/expenses/${request.params.id}`);
});

app.get("/desk/leads", requireAuth, async (request, response) => {
  const q = String(request.query.q || "");
  const status = String(request.query.status || "");
  const where = { AND: [status ? { status } : {}, searchWhere(q, ["name", "phone", "email", "businessName", "city", "serviceRequested"]) || {}] };
  const leads = await prisma.lead.findMany({ where, orderBy: { createdAt: "desc" } });
  response.send(layout("Leads", `<section class="card"><div class="row"><h1>Leads</h1><a class="button" href="/desk/leads/new">Add Lead</a></div><form method="get" class="row"><input name="q" value="${esc(q)}" placeholder="Search leads"><select name="status"><option value="">All statuses</option>${statusOptions(leadStatuses, status)}</select><button>Filter</button></form></section>${leadTable(leads)}`));
});

app.get("/desk/leads/new", requireAuth, (request, response) => {
  response.send(layout("Add Lead", leadForm("/desk/leads/new")));
});

app.post("/desk/leads/new", requireAuth, async (request, response) => {
  const body = request.body;
  const required = ["name", "phone", "city", "customerType", "serviceRequested", "urgency", "preferredContact", "source", "message"];
  const missing = required.filter((field) => !String(body[field] || "").trim());
  if (missing.length) {
    response.status(400).send(layout("Add Lead", `<section class="card"><p class="danger">Please complete the required fields.</p></section>${leadForm("/desk/leads/new", body)}`));
    return;
  }
  const lead = await prisma.lead.create({
    data: {
      name: body.name.trim(),
      phone: body.phone.trim(),
      email: body.email?.trim() || null,
      businessName: body.businessName?.trim() || null,
      customerType: body.customerType,
      city: body.city.trim(),
      serviceRequested: body.serviceRequested,
      urgency: body.urgency,
      preferredContact: body.preferredContact,
      message: body.message.trim(),
      source: body.source,
      status: body.status || "New Lead",
      notes: body.notes?.trim() || null
    }
  });
  response.redirect(`/desk/leads/${lead.id}`);
});

app.get("/desk/leads/:id", requireAuth, async (request, response) => {
  const lead = await prisma.lead.findUnique({
    where: { id: Number(request.params.id) },
    include: {
      tickets: true,
      remoteSessions: { include: { ticket: true, customer: true, lead: true }, orderBy: { createdAt: "desc" } }
    }
  });
  if (!lead) return response.status(404).send(layout("Lead not found", "<section class='card'>Lead not found.</section>"));
  response.send(layout(`Lead ${lead.id}`, `<section class="card"><h1>${esc(lead.name)}</h1><p>${esc(lead.phone)} Â· ${esc(lead.email || "")}</p><p>${esc(lead.serviceRequested)} in ${esc(lead.city)}</p><p>${esc(lead.message)}</p></section>
    <section class="grid two">
      <section class="card"><h2>Lead Details</h2>${leadQuickDetails(lead)}</section>
      ${leadNextSteps()}
    </section>
    <section class="grid two">
      <section class="card"><h2>Issue Description</h2><p>${esc(lead.message)}</p></section>
      <section class="card"><h2>Website Intake Notes</h2><p>${esc(lead.notes || "No website intake notes yet.").replaceAll("\n", "<br>")}</p></section>
    </section>
    <section class="grid two">
      <form method="post" action="/desk/leads/${lead.id}/update"><h2>Update Lead</h2><label>Status <select name="status">${statusOptions(leadStatuses, lead.status)}</select></label><label>Notes <textarea name="notes">${esc(lead.notes || "")}</textarea></label><button>Save Lead</button></form>
      <form method="post" action="/desk/leads/${lead.id}/note"><h2>Add Follow-Up Note</h2><label>Note <textarea name="note"></textarea></label><button>Add Note</button></form>
    </section>
    <section class="grid two">
      ${followUpForm("Follow-Up Reminder", `/desk/leads/${lead.id}/follow-up`, lead)}
      <section class="card"><h2>Contact</h2><p><strong>Last contacted:</strong> ${displayDateTime(lead.lastContactedAt) || "Not recorded"}</p><div class="row"><form method="post" action="/desk/leads/${lead.id}/contacted"><button>Mark Contacted Now</button></form>${copyInlineButton(`lead-detail-follow-${lead.id}`, leadFollowUpText(lead))}</div></section>
    </section>
    <section class="card row"><form method="post" action="/desk/leads/${lead.id}/customer"><button>Create Customer From Lead</button></form><form method="post" action="/desk/leads/${lead.id}/ticket"><button>Create Ticket From Lead</button></form></section>
    <section class="card"><h2>Remote Sessions</h2>${remoteSessionTable(lead.remoteSessions || [])}</section>
    <section class="card"><h2>Related Tickets</h2>${ticketTable(lead.tickets)}</section>${copyScript()}`));
});

app.post("/desk/leads/:id/update", requireAuth, async (request, response) => {
  await prisma.lead.update({ where: { id: Number(request.params.id) }, data: { status: request.body.status, notes: request.body.notes || null } });
  response.redirect(`/desk/leads/${request.params.id}`);
});

app.post("/desk/leads/:id/note", requireAuth, async (request, response) => {
  const lead = await prisma.lead.findUnique({ where: { id: Number(request.params.id) } });
  const stamp = new Date().toLocaleString();
  await prisma.lead.update({ where: { id: Number(request.params.id) }, data: { notes: `${lead?.notes || ""}\n[${stamp}] ${request.body.note || ""}`.trim() } });
  response.redirect(`/desk/leads/${request.params.id}`);
});

app.post("/desk/leads/:id/follow-up", requireAuth, async (request, response) => {
  await prisma.lead.update({
    where: { id: Number(request.params.id) },
    data: {
      followUpAt: parseFollowUpDate(request.body.followUpAt),
      followUpNote: request.body.followUpNote?.trim() || null
    }
  });
  response.redirect(`/desk/leads/${request.params.id}`);
});

app.post("/desk/leads/:id/contacted", requireAuth, async (request, response) => {
  const lead = await prisma.lead.findUnique({ where: { id: Number(request.params.id) } });
  if (!lead) return response.redirect("/desk/leads");
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lastContactedAt: new Date(),
      followUpAt: null,
      status: lead.status === "New Lead" && leadStatuses.includes("Contacted") ? "Contacted" : lead.status
    }
  });
  response.redirect(`/desk/leads/${lead.id}`);
});

app.post("/desk/leads/:id/customer", requireAuth, async (request, response) => {
  const lead = await prisma.lead.findUnique({ where: { id: Number(request.params.id) } });
  if (!lead) return response.redirect("/desk/leads");
  const customer = await prisma.customer.create({ data: { name: lead.name, phone: lead.phone, email: lead.email, businessName: lead.businessName, customerType: lead.customerType, city: lead.city, notes: lead.notes } });
  response.redirect(`/desk/customers/${customer.id}`);
});

app.post("/desk/leads/:id/ticket", requireAuth, async (request, response) => {
  const lead = await prisma.lead.findUnique({ where: { id: Number(request.params.id) } });
  if (!lead) return response.redirect("/desk/leads");
  const ticket = await prisma.ticket.create({ data: { ticketNumber: `909-${Date.now()}`, leadId: lead.id, title: lead.serviceRequested, serviceType: lead.serviceRequested, issue: lead.message, status: "New" } });
  response.redirect(`/desk/tickets/${ticket.id}`);
});

app.get("/desk/customers", requireAuth, async (request, response) => {
  const q = String(request.query.q || "");
  const customers = await prisma.customer.findMany({ where: searchWhere(q, ["name", "phone", "email", "businessName", "city"]), include: { invoices: true }, orderBy: { updatedAt: "desc" } });
  response.send(layout("Customers", `<section class="card"><h1>Customers</h1><form method="get" class="row"><input name="q" value="${esc(q)}" placeholder="Search customers"><button>Search</button></form></section>
    ${customerTable(customers)}`));
});

app.get("/desk/customers/:id", requireAuth, async (request, response) => {
  const customer = await prisma.customer.findUnique({
    where: { id: Number(request.params.id) },
    include: {
      tickets: { include: { lead: true }, orderBy: { updatedAt: "desc" } },
      invoices: { include: { lead: true }, orderBy: { createdAt: "desc" } },
      remoteSessions: { include: { ticket: true, customer: true, lead: true }, orderBy: { createdAt: "desc" } },
      expenses: { orderBy: { expenseDate: "desc" } }
    }
  });
  if (!customer) return response.status(404).send(layout("Customer not found", "<section class='card'>Customer not found.</section>"));
  const summary = invoiceFinancialSummary(customer.invoices);
  const relatedLeads = Array.from(new Map([...customer.tickets.map((ticket) => ticket.lead).filter(Boolean), ...customer.invoices.map((invoice) => invoice.lead).filter(Boolean)].map((lead) => [lead.id, lead])).values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  response.send(layout(customer.name, `<section class="card">
      <div class="row"><h1>${esc(customer.name)}</h1><a class="button" href="/desk/tickets/new?customerId=${customer.id}">New Ticket for Customer</a><a class="button" href="/desk/invoices/new?customerId=${customer.id}">New Invoice for Customer</a><a class="button" href="/desk/expenses/new?customerId=${customer.id}">Add Expense</a><a class="button" href="/desk/customers">Back to Customers</a></div>
      <p><strong>Business:</strong> ${esc(customer.businessName || "")}</p>
      <p><strong>Type:</strong> ${esc(customer.customerType || "")}</p>
      <p><strong>Phone:</strong> ${esc(customer.phone || "")}<br><strong>Email:</strong> ${esc(customer.email || "")}</p>
      <p><strong>Address/City:</strong> ${esc([customer.address, customer.city].filter(Boolean).join(", "))}</p>
      <p><strong>Created:</strong> ${displayDate(customer.createdAt)}<br><strong>Updated:</strong> ${displayDate(customer.updatedAt)}</p>
      ${customer.notes ? `<p><strong>Notes:</strong><br>${esc(customer.notes)}</p>` : `<p class="muted">No customer notes yet.</p>`}
    </section>
    <section class="grid">
      <div class="card metric"><span>Total invoiced</span><strong>${dollars(summary.totalInvoiced)}</strong></div>
      <div class="card metric"><span>Total paid</span><strong>${dollars(summary.totalPaid)}</strong></div>
      <div class="card metric"><span>Open balance</span><strong>${dollars(summary.openBalance)}</strong></div>
      <div class="card metric"><span>Invoices</span><strong>${summary.invoiceCount}</strong></div>
      <div class="card metric"><span>Paid invoices</span><strong>${summary.paidCount}</strong></div>
      <div class="card metric"><span>Open invoices</span><strong>${summary.openCount}</strong></div>
    </section>
    <form method="post" action="/desk/customers/${customer.id}/update"><h2>Notes</h2><label>Notes <textarea name="notes">${esc(customer.notes || "")}</textarea></label><button>Save Notes</button></form>
    ${followUpForm("Customer Follow-Up", `/desk/customers/${customer.id}/follow-up`, customer)}
    <section class="card"><h2>Remote Sessions</h2>${remoteSessionTable(customer.remoteSessions || [])}</section>
    <section class="card"><h2>Related Tickets</h2>${customerTicketHistoryTable(customer.tickets)}</section>
    <section class="card"><h2>Related Invoices</h2>${customerInvoiceHistoryTable(customer.invoices)}</section>
    <section class="card"><h2>Related Expenses</h2>${compactExpenseTable(customer.expenses, "No expenses for this customer yet.")}</section>
    <section class="card"><h2>Related Leads</h2>${relatedLeadHistoryTable(relatedLeads)}</section>
    <section class="card"><h2>Recent Activity</h2>${customerRecentActivity(customer.tickets, customer.invoices)}</section>${copyScript()}`));
});

app.get("/desk/customers/:id/summary", requireAuth, async (request, response) => {
  const customer = await prisma.customer.findUnique({ where: { id: Number(request.params.id) }, include: { tickets: true } });
  if (!customer) return response.status(404).send(layout("Customer not found", "<section class='card'>Customer not found.</section>"));
  response.send(layout(customer.name, `<section class="card"><h1>${esc(customer.name)}</h1><p>${esc(customer.phone || "")} Â· ${esc(customer.email || "")}</p><p>${esc(customer.businessName || "")} ${esc(customer.city || "")}</p></section>
    <form method="post" action="/desk/customers/${customer.id}/update"><h2>Notes</h2><label>Notes <textarea name="notes">${esc(customer.notes || "")}</textarea></label><button>Save Notes</button></form>
    <section class="card"><h2>Related Tickets</h2>${ticketTable(customer.tickets)}</section>`));
});

app.post("/desk/customers/:id/update", requireAuth, async (request, response) => {
  await prisma.customer.update({ where: { id: Number(request.params.id) }, data: { notes: request.body.notes || null } });
  response.redirect(`/desk/customers/${request.params.id}`);
});

app.post("/desk/customers/:id/follow-up", requireAuth, async (request, response) => {
  await prisma.customer.update({
    where: { id: Number(request.params.id) },
    data: {
      followUpAt: parseFollowUpDate(request.body.followUpAt),
      followUpNote: request.body.followUpNote?.trim() || null
    }
  });
  response.redirect(`/desk/customers/${request.params.id}`);
});

app.get("/desk/tickets", requireAuth, async (request, response) => {
  const q = String(request.query.q || "");
  const status = String(request.query.status || "");
  const where = { AND: [status ? { status } : {}, searchWhere(q, ["ticketNumber", "title", "serviceType", "issue", "diagnosis", "workPerformed"]) || {}] };
  const tickets = await prisma.ticket.findMany({ where, include: { invoices: true }, orderBy: { updatedAt: "desc" } });
  response.send(layout("Tickets", `<section class="card"><h1>Tickets</h1><form method="get" class="row"><input name="q" value="${esc(q)}" placeholder="Search tickets"><select name="status"><option value="">All statuses</option>${statusOptions(ticketStatuses, status)}</select><button>Filter</button></form></section>${ticketTable(tickets)}`));
});

app.get("/desk/tickets/new", requireAuth, async (request, response) => {
  const customerId = Number(request.query.customerId);
  const customer = Number.isInteger(customerId) && customerId > 0 ? await prisma.customer.findUnique({ where: { id: customerId } }) : null;
  response.send(layout("New Ticket", ticketForm("/desk/tickets/new", {
    customerId: customer?.id || "",
    customerName: customer?.name || "",
    title: customer ? "IT Support" : ""
  })));
});

app.post("/desk/tickets/new", requireAuth, async (request, response) => {
  const customerId = Number(request.body.customerId);
  const customer = Number.isInteger(customerId) && customerId > 0 ? await prisma.customer.findUnique({ where: { id: customerId } }) : null;
  const data = {
    ticketNumber: `909-${Date.now()}`,
    customerId: customer?.id || null,
    title: String(request.body.title || "").trim(),
    serviceType: request.body.serviceType || null,
    issue: request.body.issue?.trim() || null,
    customerNotes: request.body.customerNotes?.trim() || null,
    appointmentAt: request.body.appointmentAt ? new Date(request.body.appointmentAt) : null,
    status: "New"
  };
  if (!data.title) {
    response.status(400).send(layout("New Ticket", ticketForm("/desk/tickets/new", { ...request.body, customerName: customer?.name || "" }, `<p class="danger">Title is required.</p>`)));
    return;
  }
  const ticket = await prisma.ticket.create({ data });
  response.redirect(`/desk/tickets/${ticket.id}`);
});

app.get("/desk/invoices", requireAuth, async (request, response) => {
  const q = String(request.query.q || "");
  const status = String(request.query.status || "");
  const where = { AND: [status ? { status } : {}, searchWhere(q, ["invoiceNumber", "customerName", "customerEmail", "customerPhone"]) || {}] };
  const invoices = await prisma.invoice.findMany({ where, orderBy: { createdAt: "desc" } });
  response.send(layout("Invoices", `<section class="card"><div class="row"><h1>Invoices</h1><a class="button" href="/desk/invoices/new">New Invoice</a></div><form method="get" class="row"><input name="q" value="${esc(q)}" placeholder="Search invoice, name, email, phone"><select name="status"><option value="">All statuses</option>${statusOptions(invoiceStatuses, status)}</select><button>Filter</button></form></section>${invoiceTable(invoices)}`));
});

app.get("/desk/service-menu", requireAuth, (request, response) => {
  response.send(layout("Service Menu", `<section class="card"><div class="row"><h1>Service Menu</h1><a class="button" href="/desk/invoices/new">New Invoice</a></div><p class="muted">Read-only standard services used for quick invoice line items. Edit the service menu in code for now.</p></section>${serviceMenuTable()}`));
});

app.get("/desk/invoices/new", requireAuth, async (request, response) => {
  const customerId = Number(request.query.customerId);
  const ticketId = Number(request.query.ticketId);
  const ticket = Number.isInteger(ticketId) && ticketId > 0
    ? await prisma.ticket.findUnique({ where: { id: ticketId }, include: { customer: true, lead: true } })
    : null;
  const customer = ticket?.customer || (Number.isInteger(customerId) && customerId > 0 ? await prisma.customer.findUnique({ where: { id: customerId } }) : null);
  const lead = ticket?.lead || null;
  const priceCents = ticket ? parseMoneyToCents(ticket.finalPrice ?? "") : 0;
  const invoiceValues = {
    ticketId: ticket?.id || "",
    customerId: customer?.id || "",
    customerName: customer?.name || lead?.name || "",
    customerEmail: customer?.email || lead?.email || "",
    customerPhone: customer?.phone || lead?.phone || ""
  };
  if (ticket) {
    invoiceValues.notes = ticket.customerNotes || "";
    invoiceValues.descriptions = [ticket.workPerformed || ticket.serviceType || ticket.title || "IT Support"];
    invoiceValues.quantities = ["1"];
    invoiceValues.unitPrices = [priceCents ? centsToInputValue(priceCents) : ""];
  }
  response.send(layout("New Invoice", invoiceForm("/desk/invoices", {
    ...invoiceValues
  })));
});

app.post("/desk/invoices", requireAuth, async (request, response) => {
  const body = request.body;
  const values = {
    customerId: body.customerId,
    ticketId: body.ticketId,
    customerName: body.customerName,
    customerEmail: body.customerEmail,
    customerPhone: body.customerPhone,
    dueDate: body.dueDate,
    discount: body.discount,
    tax: body.tax,
    notes: body.notes,
    descriptions: Array.isArray(body.description) ? body.description : [body.description],
    quantities: Array.isArray(body.quantity) ? body.quantity : [body.quantity],
    unitPrices: Array.isArray(body.unitPrice) ? body.unitPrice : [body.unitPrice]
  };

  if (!String(body.customerName || "").trim()) {
    response.status(400).send(layout("New Invoice", invoiceForm("/desk/invoices", values, `<p class="danger">Customer name is required.</p>`)));
    return;
  }

  const parsed = parseInvoiceInput(body);
  if (parsed.error) {
    response.status(400).send(layout("New Invoice", invoiceForm("/desk/invoices", values, `<p class="danger">${esc(parsed.error)}</p>`)));
    return;
  }

  const customerId = Number(body.customerId);
  const customer = Number.isInteger(customerId) && customerId > 0 ? await prisma.customer.findUnique({ where: { id: customerId } }) : null;
  const ticketId = Number(body.ticketId);
  const ticket = Number.isInteger(ticketId) && ticketId > 0 ? await prisma.ticket.findUnique({ where: { id: ticketId } }) : null;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: await nextInvoiceNumber(),
      customerId: customer?.id || ticket?.customerId || null,
      leadId: ticket?.leadId || null,
      ticketId: ticket?.id || null,
      customerName: body.customerName.trim(),
      customerEmail: body.customerEmail?.trim() || null,
      customerPhone: body.customerPhone?.trim() || null,
      dueDate: body.dueDate ? new Date(`${body.dueDate}T12:00:00`) : null,
      subtotalCents: parsed.subtotalCents,
      taxCents: parsed.taxCents,
      discountCents: parsed.discountCents,
      totalCents: parsed.totalCents,
      notes: body.notes?.trim() || null,
      status: "Draft",
      lineItems: {
        create: parsed.lineItems
      }
    }
  });

  response.redirect(`/desk/invoices/${invoice.id}`);
});

app.get("/desk/invoices/:id", requireAuth, async (request, response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: Number(request.params.id) },
    include: { lineItems: true, customer: true, lead: true, ticket: true, expenses: { orderBy: { expenseDate: "desc" } } }
  });
  if (!invoice) return response.status(404).send(layout("Invoice not found", "<section class='card'>Invoice not found.</section>"));

  const notice = request.query.payment === "success"
    ? `<section class="card"><p><strong>Payment completed in Stripe Checkout.</strong> Mark the invoice paid after confirming the payment in Stripe.</p></section>`
    : request.query.payment === "cancel"
      ? `<section class="card"><p class="muted">Payment checkout was canceled.</p></section>`
      : "";
  const stripeMessage = request.query.stripe === "missing"
    ? `<section class="card"><p class="danger">Stripe is not configured. Add STRIPE_SECRET_KEY in Railway to generate payment links.</p></section>`
    : request.query.stripe === "error"
      ? `<section class="card"><p class="danger">Stripe could not generate a payment link. Check the server logs and Stripe configuration.</p></section>`
      : "";
  const paidReviewPrompt = invoice.status === "Paid"
    ? `<section class="card"><h2>Review Follow-Up</h2><p>Payment received. If this job is complete, request a Google review from the related ticket.</p>${invoice.ticket ? `<a class="button" href="/desk/tickets/${invoice.ticket.id}">Open Ticket</a>` : `<p class="muted">No related ticket is linked to this invoice.</p>`}</section>`
    : "";
  const testDemoWarning = testDemoNotice(invoiceIsTestDemo(invoice), "invoice");
  const invoiceTerms = `<section class="card"><h2>Invoice Terms</h2><p class="muted">Payment is due upon completion unless otherwise agreed in writing. Client is responsible for data backups, passwords, software licenses, account access, and third-party service availability. 909 Signal IT is not responsible for pre-existing issues, data loss, failed hardware, unsupported software, ISP/vendor outages, or indirect business losses. Labor warranty applies only to the specific issue serviced for 7 days. Full service terms apply.</p><p><a href="${serviceTermsUrl}" target="_blank" rel="noopener">${serviceTermsUrl}</a></p></section>`;
  const lineRows = invoice.lineItems.map((item) => `<tr><td>${esc(item.description)}</td><td>${item.quantity}</td><td>${dollars(item.unitPriceCents)}</td><td>${dollars(item.lineTotalCents)}</td></tr>`).join("");
  response.send(layout(invoice.invoiceNumber, `${notice}${stripeMessage}${testDemoWarning}${stripeModeNotice()}
    <section class="card">
      <div class="row"><h1>${esc(invoice.invoiceNumber)}</h1><a class="button" href="/desk/expenses/new?invoiceId=${invoice.id}">Add Expense for Invoice</a><a class="button" href="/desk/invoices">Invoices</a></div>
      <p><strong>${esc(invoice.customerName)}</strong><br>${esc(invoice.customerEmail || "")}<br>${esc(invoice.customerPhone || "")}</p>
      <p>Status: <strong>${esc(invoice.status)}</strong>${invoice.dueDate ? ` Ã‚Â· Due ${new Date(invoice.dueDate).toLocaleDateString()}` : ""}</p>
      ${invoice.paymentLink ? `<p>Payment link: <a href="${esc(invoice.paymentLink)}" target="_blank" rel="noopener">${esc(invoice.paymentLink)}</a></p>` : `<p class="muted">No payment link generated yet.</p>`}
      ${invoice.ticket ? `<p>Related ticket: <a href="/desk/tickets/${invoice.ticket.id}">${esc(invoice.ticket.ticketNumber)}</a></p>` : ""}
      ${invoice.lead ? `<p>Related lead: <a href="/desk/leads/${invoice.lead.id}">${esc(invoice.lead.name)}</a></p>` : ""}
    </section>
    <section class="grid two">
      <form method="post" action="/desk/invoices/${invoice.id}/status">
        <h2>Status</h2>
        <label>Invoice status <select name="status">${statusOptions(invoiceStatuses, invoice.status)}</select></label>
        <button>Update Status</button>
      </form>
      <form method="post" action="/desk/invoices/${invoice.id}/payment-link">
        <h2>Payment</h2>
        <p class="muted">Generate a Stripe-hosted Checkout link for this invoice.</p>
        <p class="muted"><strong>${esc(stripeModeLabel())}</strong></p>
        <p class="muted">By paying, client agrees to the <a href="${serviceTermsUrl}" target="_blank" rel="noopener">909 Signal IT Service Terms</a>.</p>
        <button>Generate Payment Link</button>
      </form>
    </section>
    ${invoicePaymentMessages(invoice)}
    <section class="grid two">
      ${followUpForm("Invoice Follow-Up", `/desk/invoices/${invoice.id}/follow-up`, invoice)}
      <section class="card"><h2>Follow-Up Message</h2><div class="row">${copyInlineButton(`invoice-detail-follow-${invoice.id}`, invoiceFollowUpText(invoice))}</div></section>
    </section>
    ${invoiceTerms}
    ${paidReviewPrompt}
    <section class="card">
      <h2>Line Items</h2>
      <table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead><tbody>${lineRows}</tbody></table>
      <p>Subtotal: <strong>${dollars(invoice.subtotalCents)}</strong></p>
      <p>Discount: <strong>${dollars(invoice.discountCents)}</strong></p>
      <p>Tax: <strong>${dollars(invoice.taxCents)}</strong></p>
      <p>Total: <strong>${dollars(invoice.totalCents)}</strong></p>
      ${invoice.notes ? `<h2>Notes</h2><p>${esc(invoice.notes)}</p>` : ""}
    </section>
    <section class="card"><h2>Related Expenses</h2>${compactExpenseTable(invoice.expenses, "No expenses connected to this invoice yet.")}</section>${copyScript()}`));
});

app.post("/desk/invoices/:id/status", requireAuth, async (request, response) => {
  const status = invoiceStatuses.includes(request.body.status) ? request.body.status : "Draft";
  const data = { status };
  if (status === "Sent") data.sentAt = new Date();
  if (status === "Paid") data.paidAt = new Date();
  await prisma.invoice.update({ where: { id: Number(request.params.id) }, data });
  response.redirect(`/desk/invoices/${request.params.id}`);
});

app.post("/desk/invoices/:id/follow-up", requireAuth, async (request, response) => {
  await prisma.invoice.update({
    where: { id: Number(request.params.id) },
    data: {
      followUpAt: parseFollowUpDate(request.body.followUpAt),
      followUpNote: request.body.followUpNote?.trim() || null
    }
  });
  response.redirect(`/desk/invoices/${request.params.id}`);
});

app.post("/desk/invoices/:id/payment-link", requireAuth, async (request, response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: Number(request.params.id) },
    include: { lineItems: true }
  });
  if (!invoice) return response.status(404).send(layout("Invoice not found", "<section class='card'>Invoice not found.</section>"));

  try {
    const result = await generateInvoiceCheckoutSession(invoice);
    if (result.error) {
      response.redirect(`/desk/invoices/${invoice.id}?stripe=${stripe ? "error" : "missing"}`);
      return;
    }

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        paymentLink: result.session.url,
        stripeCheckoutSessionId: result.session.id,
        status: invoice.status === "Draft" ? "Sent" : invoice.status,
        sentAt: invoice.sentAt || new Date()
      }
    });
    response.redirect(`/desk/invoices/${invoice.id}`);
  } catch (error) {
    console.error(error);
    response.redirect(`/desk/invoices/${invoice.id}?stripe=error`);
  }
});

app.post("/desk/tickets/:id/create-invoice", requireAuth, async (request, response) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: Number(request.params.id) },
    include: { customer: true, lead: true }
  });
  if (!ticket) return response.redirect("/desk/tickets");
  const customerName = ticket.customer?.name || ticket.lead?.name || "Customer";
  const customerEmail = ticket.customer?.email || ticket.lead?.email || null;
  const customerPhone = ticket.customer?.phone || ticket.lead?.phone || null;
  const priceCents = parseMoneyToCents(ticket.finalPrice ?? ticket.priceQuoted ?? 0) || 0;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: await nextInvoiceNumber(),
      customerId: ticket.customerId,
      leadId: ticket.leadId,
      ticketId: ticket.id,
      customerName,
      customerEmail,
      customerPhone,
      subtotalCents: priceCents,
      taxCents: 0,
      discountCents: 0,
      totalCents: priceCents,
      notes: ticket.customerNotes || ticket.internalNotes || null,
      status: "Draft",
      lineItems: {
        create: [{
          description: ticket.workPerformed || ticket.serviceType || ticket.title || "IT Support",
          quantity: 1,
          unitPriceCents: priceCents,
          lineTotalCents: priceCents
        }]
      }
    }
  });
  response.redirect(`/desk/invoices/${invoice.id}`);
});

app.get("/desk/tickets/:id", requireAuth, async (request, response) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: Number(request.params.id) },
    include: {
      customer: true,
      lead: true,
      invoices: true,
      expenses: { orderBy: { expenseDate: "desc" } },
      remoteSessions: { include: { ticket: true, customer: true, lead: true }, orderBy: { createdAt: "desc" } }
    }
  });
  if (!ticket) return response.status(404).send(layout("Ticket not found", "<section class='card'>Ticket not found.</section>"));
  const reviewEmailNotice = request.query.reviewEmail === "sent"
    ? `<section class="card"><p><strong>Review request email sent.</strong></p></section>`
    : request.query.reviewEmail === "skipped"
      ? `<section class="card"><p class="danger">Review request email was skipped because customer email or email configuration is missing.</p></section>`
      : request.query.reviewEmail === "failed"
        ? `<section class="card"><p class="danger">Review request email failed. The ticket was not blocked.</p></section>`
        : "";
  response.send(layout(ticket.ticketNumber, ticketWorkOrderPage(ticket, reviewEmailNotice)));
});

app.post("/desk/tickets/:id/update", requireAuth, async (request, response) => {
  const existing = await prisma.ticket.findUnique({ where: { id: Number(request.params.id) } });
  if (!existing) return response.redirect("/desk/tickets");
  const status = ticketStatuses.includes(request.body.status) ? request.body.status : "New";
  const completedAt = ["Completed", "Closed"].includes(status) && !existing.completedAt ? new Date() : null;
  const data = {
    title: request.body.title || "Service Ticket",
    serviceType: request.body.serviceType || null,
    status,
    appointmentAt: request.body.appointmentAt ? new Date(request.body.appointmentAt) : null,
    issue: request.body.issue || null,
    diagnosis: request.body.diagnosis || null,
    workPerformed: request.body.workPerformed || null,
    partsNeeded: request.body.partsNeeded || null,
    partsUsed: request.body.partsUsed || null,
    timeSpentMinutes: parseOptionalMinutes(request.body.timeSpentMinutes),
    priceQuoted: parseOptionalMoneyDecimal(request.body.priceQuoted),
    finalPrice: parseOptionalMoneyDecimal(request.body.finalPrice),
    internalNotes: request.body.internalNotes || null,
    customerNotes: request.body.customerNotes || null,
    recommendedNextSteps: request.body.recommendedNextSteps || null,
    reviewRequested: Boolean(request.body.reviewRequested),
    reviewReceived: Boolean(request.body.reviewReceived),
    ...(completedAt ? { completedAt } : {})
  };
  await prisma.ticket.update({ where: { id: Number(request.params.id) }, data });
  response.redirect(`/desk/tickets/${request.params.id}`);
});

app.post("/desk/tickets/:id/follow-up", requireAuth, async (request, response) => {
  await prisma.ticket.update({
    where: { id: Number(request.params.id) },
    data: {
      followUpAt: parseFollowUpDate(request.body.followUpAt),
      followUpNote: request.body.followUpNote?.trim() || null
    }
  });
  response.redirect(`/desk/tickets/${request.params.id}`);
});

app.post("/desk/tickets/:id/status", requireAuth, async (request, response) => {
  const status = ticketStatuses.includes(request.body.status) ? request.body.status : "New";
  await prisma.ticket.update({ where: { id: Number(request.params.id) }, data: { status } });
  response.redirect(`/desk/tickets/${request.params.id}`);
});

app.post("/desk/tickets/:id/complete", requireAuth, async (request, response) => {
  await prisma.ticket.update({
    where: { id: Number(request.params.id) },
    data: { status: "Completed", completedAt: new Date() }
  });
  response.redirect(`/desk/tickets/${request.params.id}`);
});

app.post("/desk/tickets/:id/review-requested", requireAuth, async (request, response) => {
  await prisma.ticket.update({
    where: { id: Number(request.params.id) },
    data: { reviewRequested: true }
  });
  response.redirect(`/desk/tickets/${request.params.id}`);
});

app.post("/desk/tickets/:id/review-email", requireAuth, async (request, response) => {
  const ticket = await prisma.ticket.findUnique({
    where: { id: Number(request.params.id) },
    include: { customer: true, lead: true }
  });
  if (!ticket) return response.redirect("/desk/tickets");
  const email = ticket.customer?.email || ticket.lead?.email || "";
  const customerName = ticket.customer?.name || ticket.lead?.name || "there";
  try {
    const result = await sendReviewRequestEmail({
      email,
      customerName,
      googleReviewUrl: googleReviewLink
    });
    if (result?.skipped) {
      console.warn("Review request email skipped:", { ticketId: ticket.id, hasEmail: Boolean(email), hasGoogleReviewUrl: Boolean(googleReviewLink) });
      response.redirect(`/desk/tickets/${request.params.id}?reviewEmail=skipped`);
      return;
    }
    console.log("Review request email sent:", { ticketId: ticket.id, hasGoogleReviewUrl: Boolean(googleReviewLink) });
    await prisma.ticket.update({
      where: { id: Number(request.params.id) },
      data: { reviewRequested: true }
    });
    response.redirect(`/desk/tickets/${request.params.id}?reviewEmail=sent`);
  } catch (error) {
    console.error("Review request email failed:", error?.message || error);
    response.redirect(`/desk/tickets/${request.params.id}?reviewEmail=failed`);
  }
});

app.post("/desk/tickets/:id/review-received", requireAuth, async (request, response) => {
  await prisma.ticket.update({
    where: { id: Number(request.params.id) },
    data: { reviewRequested: true, reviewReceived: true }
  });
  response.redirect(`/desk/tickets/${request.params.id}`);
});

app.get("/reviews.html", (request, response) => {
  response.setHeader("Cache-Control", "no-cache");
  response.send(publicReviewsPage());
});

app.use((error, request, response, next) => {
  console.error(error);
  if (request.path.startsWith("/desk")) {
    deskSetupMessage(response);
    return;
  }
  next(error);
});

app.use("/assets", express.static(publicAssetsRoot, {
  setHeaders(response) {
    response.setHeader("Cache-Control", "public, max-age=31536000");
  }
}));

app.use(express.static(root, {
  extensions: ["html"],
  setHeaders(response, filePath) {
    response.setHeader("Cache-Control", extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000");
  }
}));

app.use((request, response) => {
  const fallback = join(root, "index.html");
  if (existsSync(fallback)) {
    response.sendFile(fallback);
    return;
  }
  response.status(404).send("Page not found");
});

app.listen(port, () => {
  console.log(`909 Signal IT site running on port ${port}`);
  console.log(`Lead notification configured: ${isLeadNotificationConfigured() ? "yes" : "no"}`);
  console.log(`Stripe payments configured: ${stripe ? "yes" : "no"}`);
});
