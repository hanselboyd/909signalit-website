import express from "express";
import session from "express-session";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { isLeadNotificationConfigured, sendLeadNotification } from "./src/server/email.js";

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3000;
const root = join(process.cwd(), "dist");
const publicAssetsRoot = join(process.cwd(), "public", "assets");
const siteUrl = process.env.PUBLIC_SITE_URL || "https://909signalit.com";
const serviceTermsUrl = "https://909signalit.com/terms.html";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const googleReviewLink = process.env.GOOGLE_REVIEW_LINK || "";

const leadStatuses = ["New Lead", "Contacted", "Scheduled", "In Progress", "Waiting on Customer", "Completed", "Invoice Sent", "Closed", "Lost"];
const ticketStatuses = ["New", "Scheduled", "In Progress", "Waiting on Customer", "Completed", "Closed", "Canceled"];
const invoiceStatuses = ["Draft", "Sent", "Partially Paid", "Paid", "Overdue", "Void", "Refunded"];
const customerTypes = ["Residential", "Business", "Warehouse", "Restaurant", "Church", "Nonprofit", "Other"];
const serviceTypes = ["Computer Repair", "Wi-Fi Troubleshooting", "Printer Setup", "Small Business IT Support", "Network Support", "POS Support", "Microsoft 365 Support", "Email Support", "Data Backup Setup", "Remote IT Support", "Other"];
const standardServiceMenu = [
  { name: "Remote IT Support", priceCents: 6500, category: "Remote" },
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
const quickServiceNames = ["Remote IT Support", "Computer Repair / Tune-Up", "Wi-Fi Troubleshooting", "Printer Setup", "Network Support", "POS Support"];
const urgencyOptions = ["Normal", "Same-day if available", "Emergency"];
const contactOptions = ["Call", "Text", "Email"];
const sourceOptions = ["Website", "Google Business Profile", "Phone", "Text", "Referral", "Facebook", "Nextdoor", "Walk-in", "Other"];

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
app.use(session({
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
}));

function esc(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function currentMonthRange() {
  const start = nowMonthStart();
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start, end };
}

function adminConfigured() {
  return Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET);
}

function requireAuth(request, response, next) {
  if (request.session?.adminAuthed) return next();
  response.redirect("/desk/login");
}

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
  return `<table><thead><tr><th>Name</th><th>Contact</th><th>Service</th><th>Status</th><th>Created</th></tr></thead><tbody>${leads.map((lead) => `
    <tr>
      <td><a href="/desk/leads/${lead.id}">${esc(lead.name)}</a><br><span class="muted">${esc(lead.businessName || lead.customerType)}</span></td>
      <td>${esc(lead.phone)}<br>${esc(lead.email || "")}</td>
      <td>${esc(lead.serviceRequested)}<br><span class="muted">${esc(lead.city)}</span></td>
      <td>${esc(lead.status)}</td>
      <td>${new Date(lead.createdAt).toLocaleDateString()}</td>
    </tr>`).join("") || `<tr><td colspan="5">No leads found.</td></tr>`}</tbody></table>`;
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

function ticketWorkOrderPage(ticket) {
  const customerLabel = ticketContactBlock(ticket);
  const linkedInvoices = ticket.invoices?.length
    ? ticket.invoices.map((invoice) => `<a href="/desk/invoices/${invoice.id}">${esc(invoice.invoiceNumber)}</a> (${esc(invoice.status)}, ${dollars(invoice.totalCents)})`).join("<br>")
    : `<span class="muted">No invoices linked yet.</span>`;
  const requestReview = ["Completed", "Closed"].includes(ticket.status)
    ? ticketReviewRequestSection(ticket)
    : `<section class="card"><h2>Review Follow-Up</h2><p class="muted">Mark the work order completed before requesting a review.</p></section>`;
  return `<section class="card">
      <div class="row">
        <h1>${esc(ticket.ticketNumber)}</h1>
        <form method="post" action="/desk/tickets/${ticket.id}/status"><input type="hidden" name="status" value="Scheduled"><button>Mark Scheduled</button></form>
        <form method="post" action="/desk/tickets/${ticket.id}/status"><input type="hidden" name="status" value="In Progress"><button>Mark In Progress</button></form>
        <form method="post" action="/desk/tickets/${ticket.id}/complete"><button>Mark Completed</button></form>
        <a class="button" href="/desk/invoices/new?ticketId=${ticket.id}">Create Invoice</a>
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
    ${completionSummaryPanel(ticket)}
    ${requestReview}`;
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

function ticketReviewRequestSection(ticket) {
  if (!["Completed", "Closed"].includes(ticket.status)) return "";

  if (!googleReviewLink) {
    return `<section class="card"><h2>Request Google Review</h2><p class="muted">Add GOOGLE_REVIEW_LINK in Railway to enable review request messages.</p></section>`;
  }

  const customerName = ticket.customer?.name || ticket.lead?.name || "there";
  const textMessage = `Hi, this is 909 Signal IT. Thank you for choosing us for your IT support. If the service was helpful, would you mind leaving a quick Google review? It really helps a local Ontario business grow: ${googleReviewLink}`;
  const emailSubject = "Thank you for choosing 909 Signal IT";
  const emailBody = `Hello ${customerName},

Thank you for choosing 909 Signal IT for your technology support.

If the service was helpful, would you mind leaving a quick Google review? It really helps local customers find reliable IT support in Ontario and nearby cities.

Review link:
${googleReviewLink}

Thank you,
909 Signal IT
909-260-8660
support@909signalit.com`;

  return `<section class="card">
    <h2>Request Google Review</h2>
    <p class="muted">Review status: ${reviewStatusLabel(ticket)}</p>
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
    <label>Review Link <input readonly id="review-link" value="${esc(googleReviewLink)}"></label>
    <div class="row"><button type="button" data-copy-target="review-link">Copy Review Link</button><span class="muted" data-copy-status="review-link"></span></div>
    <div class="row">
      <form method="post" action="/desk/tickets/${ticket.id}/review-requested"><button>Mark Review Requested</button></form>
      <form method="post" action="/desk/tickets/${ticket.id}/review-received"><button>Mark Review Received</button></form>
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
        source: body.source?.trim() || "Website",
        status: "New Lead"
      }
    });

    sendLeadNotification(lead).catch((error) => {
      console.error("Lead notification email failed:", error?.message || error);
    });

    response.json({ ok: true, message: "Thank you. Your request has been received. 909 Signal IT will follow up as soon as possible." });
  } catch (error) {
    console.error(error);
    response.status(500).json({ ok: false, message: "The request could not be saved. Please call or text 909-260-8660." });
  }
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
  const month = currentMonthRange();
  const completedStatus = { status: { in: ["Completed", "Closed"] } };
  const needsReviewWhere = { ...completedStatus, reviewRequested: false, reviewReceived: false };
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
    openBalance,
    averageInvoiceTotal,
    reviewRequestsSent,
    reviewsReceived,
    recentLeads,
    recentTickets,
    recentInvoices
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
    prisma.invoice.aggregate({ where: { status: { in: openInvoiceStatuses } }, _sum: { totalCents: true } }),
    prisma.invoice.aggregate({ where: nonVoidInvoiceWhere, _avg: { totalCents: true } }),
    prisma.ticket.count({ where: { reviewRequested: true, reviewReceived: false } }),
    prisma.ticket.count({ where: { reviewReceived: true } }),
    prisma.lead.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.ticket.findMany({ include: { customer: true, lead: true }, orderBy: { updatedAt: "desc" }, take: 20 }),
    prisma.invoice.findMany({ orderBy: { updatedAt: "desc" }, take: 20 })
  ]);

  const paidRevenueCents = paidRevenueThisMonth._sum.totalCents || 0;
  const openBalanceCents = openBalance._sum.totalCents || 0;
  const averageInvoiceCents = Math.round(averageInvoiceTotal._avg.totalCents || 0);
  const activityItems = dashboardActivityItems(recentLeads, recentTickets, recentInvoices);

  response.send(layout("Dashboard", `<section class="card">
    <div class="row"><h1>Dashboard</h1><a class="button" href="/desk/leads/new">Add Lead</a><a class="button" href="/desk/tickets">Tickets</a><a class="button" href="/desk/invoices">Invoices</a></div>
    <p class="muted">Daily command center. Week metrics use the last 7 days. Month metrics use the current server month.</p>
  </section>
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
    ${metricCard("Open balance", dollars(openBalanceCents))}
    ${metricCard("Average invoice total", dollars(averageInvoiceCents))}
  </div></section>
  <section class="card"><h2>Reviews</h2><div class="grid">
    ${metricCard("Review requests needed", ticketsNeedingReview)}
    ${metricCard("Review requests sent", reviewRequestsSent)}
    ${metricCard("Reviews received", reviewsReceived)}
  </div></section>
  <section class="card"><h2>Needs Attention</h2><div class="grid">
    ${attentionCard("Open leads", openLeads, "/desk/leads")}
    ${attentionCard("Tickets needing invoice", ticketsNeedingInvoice, "/desk/tickets")}
    ${attentionCard("Tickets needing review request", ticketsNeedingReview, "/desk/tickets")}
    ${attentionCard("Sent/unpaid invoices", sentUnpaidInvoices, "/desk/invoices")}
  </div></section>
  <section class="card"><h2>Recent Activity</h2>${activityItems.length ? recentActivityTable(activityItems) : `<p class="muted">No recent activity yet.</p>`}</section>`));
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
  const lead = await prisma.lead.findUnique({ where: { id: Number(request.params.id) }, include: { tickets: true } });
  if (!lead) return response.status(404).send(layout("Lead not found", "<section class='card'>Lead not found.</section>"));
  response.send(layout(`Lead ${lead.id}`, `<section class="card"><h1>${esc(lead.name)}</h1><p>${esc(lead.phone)} · ${esc(lead.email || "")}</p><p>${esc(lead.serviceRequested)} in ${esc(lead.city)}</p><p>${esc(lead.message)}</p></section>
    <section class="grid two">
      <form method="post" action="/desk/leads/${lead.id}/update"><h2>Update Lead</h2><label>Status <select name="status">${statusOptions(leadStatuses, lead.status)}</select></label><label>Notes <textarea name="notes">${esc(lead.notes || "")}</textarea></label><button>Save Lead</button></form>
      <form method="post" action="/desk/leads/${lead.id}/note"><h2>Add Follow-Up Note</h2><label>Note <textarea name="note"></textarea></label><button>Add Note</button></form>
    </section>
    <section class="card row"><form method="post" action="/desk/leads/${lead.id}/customer"><button>Create Customer From Lead</button></form><form method="post" action="/desk/leads/${lead.id}/ticket"><button>Create Ticket From Lead</button></form></section>
    <section class="card"><h2>Related Tickets</h2>${ticketTable(lead.tickets)}</section>`));
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
      invoices: { include: { lead: true }, orderBy: { createdAt: "desc" } }
    }
  });
  if (!customer) return response.status(404).send(layout("Customer not found", "<section class='card'>Customer not found.</section>"));
  const summary = invoiceFinancialSummary(customer.invoices);
  const relatedLeads = Array.from(new Map([...customer.tickets.map((ticket) => ticket.lead).filter(Boolean), ...customer.invoices.map((invoice) => invoice.lead).filter(Boolean)].map((lead) => [lead.id, lead])).values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  response.send(layout(customer.name, `<section class="card">
      <div class="row"><h1>${esc(customer.name)}</h1><a class="button" href="/desk/tickets/new?customerId=${customer.id}">New Ticket for Customer</a><a class="button" href="/desk/invoices/new?customerId=${customer.id}">New Invoice for Customer</a><a class="button" href="/desk/customers">Back to Customers</a></div>
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
    <section class="card"><h2>Related Tickets</h2>${customerTicketHistoryTable(customer.tickets)}</section>
    <section class="card"><h2>Related Invoices</h2>${customerInvoiceHistoryTable(customer.invoices)}</section>
    <section class="card"><h2>Related Leads</h2>${relatedLeadHistoryTable(relatedLeads)}</section>
    <section class="card"><h2>Recent Activity</h2>${customerRecentActivity(customer.tickets, customer.invoices)}</section>`));
});

app.get("/desk/customers/:id/summary", requireAuth, async (request, response) => {
  const customer = await prisma.customer.findUnique({ where: { id: Number(request.params.id) }, include: { tickets: true } });
  if (!customer) return response.status(404).send(layout("Customer not found", "<section class='card'>Customer not found.</section>"));
  response.send(layout(customer.name, `<section class="card"><h1>${esc(customer.name)}</h1><p>${esc(customer.phone || "")} · ${esc(customer.email || "")}</p><p>${esc(customer.businessName || "")} ${esc(customer.city || "")}</p></section>
    <form method="post" action="/desk/customers/${customer.id}/update"><h2>Notes</h2><label>Notes <textarea name="notes">${esc(customer.notes || "")}</textarea></label><button>Save Notes</button></form>
    <section class="card"><h2>Related Tickets</h2>${ticketTable(customer.tickets)}</section>`));
});

app.post("/desk/customers/:id/update", requireAuth, async (request, response) => {
  await prisma.customer.update({ where: { id: Number(request.params.id) }, data: { notes: request.body.notes || null } });
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
    include: { lineItems: true, customer: true, lead: true, ticket: true }
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
  const invoiceTerms = `<section class="card"><h2>Invoice Terms</h2><p class="muted">Payment is due upon completion unless otherwise agreed in writing. Client is responsible for data backups, passwords, software licenses, account access, and third-party service availability. 909 Signal IT is not responsible for pre-existing issues, data loss, failed hardware, unsupported software, ISP/vendor outages, or indirect business losses. Labor warranty applies only to the specific issue serviced for 7 days. Full service terms apply.</p><p><a href="${serviceTermsUrl}" target="_blank" rel="noopener">${serviceTermsUrl}</a></p></section>`;
  const lineRows = invoice.lineItems.map((item) => `<tr><td>${esc(item.description)}</td><td>${item.quantity}</td><td>${dollars(item.unitPriceCents)}</td><td>${dollars(item.lineTotalCents)}</td></tr>`).join("");
  response.send(layout(invoice.invoiceNumber, `${notice}${stripeMessage}
    <section class="card">
      <div class="row"><h1>${esc(invoice.invoiceNumber)}</h1><a class="button" href="/desk/invoices">Invoices</a></div>
      <p><strong>${esc(invoice.customerName)}</strong><br>${esc(invoice.customerEmail || "")}<br>${esc(invoice.customerPhone || "")}</p>
      <p>Status: <strong>${esc(invoice.status)}</strong>${invoice.dueDate ? ` Â· Due ${new Date(invoice.dueDate).toLocaleDateString()}` : ""}</p>
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
        <p class="muted">By paying, client agrees to the <a href="${serviceTermsUrl}" target="_blank" rel="noopener">909 Signal IT Service Terms</a>.</p>
        <button>Generate Payment Link</button>
      </form>
    </section>
    ${invoicePaymentMessages(invoice)}
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
    </section>`));
});

app.post("/desk/invoices/:id/status", requireAuth, async (request, response) => {
  const status = invoiceStatuses.includes(request.body.status) ? request.body.status : "Draft";
  const data = { status };
  if (status === "Sent") data.sentAt = new Date();
  if (status === "Paid") data.paidAt = new Date();
  await prisma.invoice.update({ where: { id: Number(request.params.id) }, data });
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
  const ticket = await prisma.ticket.findUnique({ where: { id: Number(request.params.id) }, include: { customer: true, lead: true, invoices: true } });
  if (!ticket) return response.status(404).send(layout("Ticket not found", "<section class='card'>Ticket not found.</section>"));
  response.send(layout(ticket.ticketNumber, ticketWorkOrderPage(ticket)));
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

app.post("/desk/tickets/:id/review-received", requireAuth, async (request, response) => {
  await prisma.ticket.update({
    where: { id: Number(request.params.id) },
    data: { reviewRequested: true, reviewReceived: true }
  });
  response.redirect(`/desk/tickets/${request.params.id}`);
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
