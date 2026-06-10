import express from "express";
import session from "express-session";
import { PrismaClient } from "@prisma/client";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { isLeadNotificationConfigured, sendLeadNotification } from "./src/server/email.js";

const app = express();
const prisma = new PrismaClient();
const port = process.env.PORT || 3000;
const root = join(process.cwd(), "dist");

const leadStatuses = ["New Lead", "Contacted", "Scheduled", "In Progress", "Waiting on Customer", "Completed", "Invoice Sent", "Closed", "Lost"];
const ticketStatuses = ["New", "Scheduled", "In Progress", "Waiting on Customer", "Completed", "Closed", "Canceled"];
const customerTypes = ["Residential", "Business", "Warehouse", "Restaurant", "Church", "Nonprofit", "Other"];
const serviceTypes = ["Computer Repair", "Wi-Fi Troubleshooting", "Printer Setup", "Small Business IT Support", "Network Support", "POS Support", "Microsoft 365 Support", "Email Support", "Data Backup Setup", "Remote IT Support", "Other"];
const urgencyOptions = ["Normal", "Same-day if available", "Emergency"];
const contactOptions = ["Call", "Text", "Email"];
const sourceOptions = ["Website", "Google Business Profile", "Phone", "Text", "Referral", "Facebook", "Nextdoor", "Walk-in", "Other"];

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
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

function dateValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 16);
}

function nowMonthStart() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
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
    table { width:100%; border-collapse:collapse; overflow:hidden; }
    th, td { padding:12px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }
    th { color:var(--navy); background:#f8fbff; }
    form { padding:18px; display:grid; gap:12px; }
    label { display:grid; gap:6px; font-weight:800; color:var(--navy); }
    input, select, textarea { width:100%; padding:10px 12px; border:1px solid var(--border); border-radius:8px; font:inherit; }
    textarea { min-height:110px; }
    button, .button { display:inline-flex; align-items:center; justify-content:center; width:max-content; min-height:40px; padding:9px 14px; color:white; background:var(--blue); border:0; border-radius:8px; font-weight:900; text-decoration:none; cursor:pointer; }
    .muted { color:#5d6b7f; }
    .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
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

function ticketTable(tickets) {
  return `<table><thead><tr><th>Ticket</th><th>Title</th><th>Status</th><th>Appointment</th><th>Updated</th></tr></thead><tbody>${tickets.map((ticket) => `
    <tr>
      <td><a href="/desk/tickets/${ticket.id}">${esc(ticket.ticketNumber)}</a></td>
      <td>${esc(ticket.title)}<br><span class="muted">${esc(ticket.serviceType || "")}</span></td>
      <td>${esc(ticket.status)}</td>
      <td>${ticket.appointmentAt ? new Date(ticket.appointmentAt).toLocaleString() : ""}</td>
      <td>${new Date(ticket.updatedAt).toLocaleDateString()}</td>
    </tr>`).join("") || `<tr><td colspan="5">No tickets found.</td></tr>`}</tbody></table>`;
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
  const [newLeads, scheduledJobs, inProgress, completedThisMonth, recentLeads, recentTickets] = await Promise.all([
    prisma.lead.count({ where: { status: "New Lead" } }),
    prisma.ticket.count({ where: { status: "Scheduled" } }),
    prisma.ticket.count({ where: { status: "In Progress" } }),
    prisma.ticket.count({ where: { status: "Completed", updatedAt: { gte: nowMonthStart() } } }),
    prisma.lead.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.ticket.findMany({ orderBy: { updatedAt: "desc" }, take: 8 })
  ]);
  response.send(layout("Dashboard", `<section class="card row"><a class="button" href="/desk/leads/new">Add Lead</a></section><section class="grid">
    <div class="card metric"><span>New leads</span><strong>${newLeads}</strong></div>
    <div class="card metric"><span>Scheduled jobs</span><strong>${scheduledJobs}</strong></div>
    <div class="card metric"><span>In progress</span><strong>${inProgress}</strong></div>
    <div class="card metric"><span>Completed this month</span><strong>${completedThisMonth}</strong></div>
  </section><section class="card"><h1>Recent Leads</h1>${leadTable(recentLeads)}</section>
  <section class="card"><h1>Recent Tickets</h1>${ticketTable(recentTickets)}</section>`));
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
  const customers = await prisma.customer.findMany({ where: searchWhere(q, ["name", "phone", "email", "businessName", "city"]), orderBy: { updatedAt: "desc" } });
  response.send(layout("Customers", `<section class="card"><h1>Customers</h1><form method="get" class="row"><input name="q" value="${esc(q)}" placeholder="Search customers"><button>Search</button></form></section>
    <table><thead><tr><th>Name</th><th>Contact</th><th>City</th><th>Updated</th></tr></thead><tbody>${customers.map((customer) => `<tr><td><a href="/desk/customers/${customer.id}">${esc(customer.name)}</a><br>${esc(customer.businessName || "")}</td><td>${esc(customer.phone || "")}<br>${esc(customer.email || "")}</td><td>${esc(customer.city || "")}</td><td>${new Date(customer.updatedAt).toLocaleDateString()}</td></tr>`).join("") || `<tr><td colspan="4">No customers found.</td></tr>`}</tbody></table>`));
});

app.get("/desk/customers/:id", requireAuth, async (request, response) => {
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
  const tickets = await prisma.ticket.findMany({ where, orderBy: { updatedAt: "desc" } });
  response.send(layout("Tickets", `<section class="card"><h1>Tickets</h1><form method="get" class="row"><input name="q" value="${esc(q)}" placeholder="Search tickets"><select name="status"><option value="">All statuses</option>${statusOptions(ticketStatuses, status)}</select><button>Filter</button></form></section>${ticketTable(tickets)}`));
});

app.get("/desk/tickets/:id", requireAuth, async (request, response) => {
  const ticket = await prisma.ticket.findUnique({ where: { id: Number(request.params.id) } });
  if (!ticket) return response.status(404).send(layout("Ticket not found", "<section class='card'>Ticket not found.</section>"));
  response.send(layout(ticket.ticketNumber, `<form method="post" action="/desk/tickets/${ticket.id}/update">
    <h1>${esc(ticket.ticketNumber)}</h1>
    <label>Title <input name="title" value="${esc(ticket.title)}"></label>
    <label>Status <select name="status">${statusOptions(ticketStatuses, ticket.status)}</select></label>
    <label>Appointment <input name="appointmentAt" type="datetime-local" value="${dateValue(ticket.appointmentAt)}"></label>
    <label>Diagnosis <textarea name="diagnosis">${esc(ticket.diagnosis || "")}</textarea></label>
    <label>Work Performed <textarea name="workPerformed">${esc(ticket.workPerformed || "")}</textarea></label>
    <label>Price Quoted <input name="priceQuoted" value="${money(ticket.priceQuoted)}"></label>
    <label>Final Price <input name="finalPrice" value="${money(ticket.finalPrice)}"></label>
    <label>Internal Notes <textarea name="internalNotes">${esc(ticket.internalNotes || "")}</textarea></label>
    <label>Customer Notes <textarea name="customerNotes">${esc(ticket.customerNotes || "")}</textarea></label>
    <label><input type="checkbox" name="reviewRequested" ${ticket.reviewRequested ? "checked" : ""}> Review requested</label>
    <label><input type="checkbox" name="reviewReceived" ${ticket.reviewReceived ? "checked" : ""}> Review received</label>
    <button>Save Ticket</button>
  </form>`));
});

app.post("/desk/tickets/:id/update", requireAuth, async (request, response) => {
  const data = {
    title: request.body.title || "Service Ticket",
    status: request.body.status,
    appointmentAt: request.body.appointmentAt ? new Date(request.body.appointmentAt) : null,
    diagnosis: request.body.diagnosis || null,
    workPerformed: request.body.workPerformed || null,
    priceQuoted: request.body.priceQuoted || null,
    finalPrice: request.body.finalPrice || null,
    internalNotes: request.body.internalNotes || null,
    customerNotes: request.body.customerNotes || null,
    reviewRequested: Boolean(request.body.reviewRequested),
    reviewReceived: Boolean(request.body.reviewReceived)
  };
  await prisma.ticket.update({ where: { id: Number(request.params.id) }, data });
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
});
