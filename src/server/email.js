import { Resend } from "resend";

const notifyEmail = process.env.LEAD_NOTIFY_EMAIL || "support@909signalit.com";
const fromEmail = process.env.FROM_EMAIL;
const resendApiKey = process.env.RESEND_API_KEY;

export function isLeadNotificationConfigured() {
  return Boolean(resendApiKey && fromEmail && notifyEmail);
}

export function isOutboundEmailConfigured() {
  return Boolean(resendApiKey && fromEmail);
}

function clean(value) {
  return value || "Not provided";
}

function htmlEscape(value) {
  return clean(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function sendLeadNotification(lead) {
  if (!isLeadNotificationConfigured()) {
    return { skipped: true };
  }

  const resend = new Resend(resendApiKey);
  const crmUrl = `https://909signalit.com/desk/leads/${lead.id}`;
  const subject = `New 909 Signal IT Lead: ${lead.serviceRequested}`;
  const text = [
    `Name: ${clean(lead.name)}`,
    `Phone: ${clean(lead.phone)}`,
    `Email: ${clean(lead.email)}`,
    `Business name: ${clean(lead.businessName)}`,
    `Customer type: ${clean(lead.customerType)}`,
    `City: ${clean(lead.city)}`,
    `Service requested: ${clean(lead.serviceRequested)}`,
    `Urgency: ${clean(lead.urgency)}`,
    `Preferred contact: ${clean(lead.preferredContact)}`,
    `Source: ${clean(lead.source)}`,
    `Notes: ${clean(lead.notes)}`,
    "",
    "Message:",
    clean(lead.message),
    "",
    `CRM link: ${crmUrl}`
  ].join("\n");

  const html = `
    <h1>New 909 Signal IT Lead</h1>
    <p><strong>Service requested:</strong> ${htmlEscape(lead.serviceRequested)}</p>
    <ul>
      <li><strong>Name:</strong> ${htmlEscape(lead.name)}</li>
      <li><strong>Phone:</strong> ${htmlEscape(lead.phone)}</li>
      <li><strong>Email:</strong> ${htmlEscape(lead.email)}</li>
      <li><strong>Business name:</strong> ${htmlEscape(lead.businessName)}</li>
      <li><strong>Customer type:</strong> ${htmlEscape(lead.customerType)}</li>
      <li><strong>City:</strong> ${htmlEscape(lead.city)}</li>
      <li><strong>Urgency:</strong> ${htmlEscape(lead.urgency)}</li>
      <li><strong>Preferred contact:</strong> ${htmlEscape(lead.preferredContact)}</li>
      <li><strong>Source:</strong> ${htmlEscape(lead.source)}</li>
    </ul>
    <p><strong>Message:</strong></p>
    <p>${htmlEscape(lead.message).replaceAll("\n", "<br>")}</p>
    <p><strong>Notes:</strong></p>
    <p>${htmlEscape(lead.notes).replaceAll("\n", "<br>")}</p>
    <p><a href="${crmUrl}">Open lead in 909 Signal Desk</a></p>
  `;

  return resend.emails.send({
    from: fromEmail,
    to: notifyEmail,
    subject,
    text,
    html
  });
}

export async function sendLeadCustomerAcknowledgement(lead) {
  if (!isLeadNotificationConfigured() || !lead.email) {
    return { skipped: true };
  }

  const resend = new Resend(resendApiKey);
  const subject = "909 Signal IT received your request";
  const text = [
    `Hi ${clean(lead.name)},`,
    "",
    "Thanks - your request was received. 909 Signal IT will review the issue and follow up as soon as possible.",
    "",
    "If anything changes or the issue becomes urgent, call or text 909-260-8660.",
    "",
    "909 Signal IT",
    "support@909signalit.com"
  ].join("\n");

  const html = `
    <p>Hi ${htmlEscape(lead.name)},</p>
    <p>Thanks - your request was received. 909 Signal IT will review the issue and follow up as soon as possible.</p>
    <p>If anything changes or the issue becomes urgent, call or text <a href="tel:+19092608660">909-260-8660</a>.</p>
    <p>909 Signal IT<br><a href="mailto:support@909signalit.com">support@909signalit.com</a></p>
  `;

  return resend.emails.send({
    from: fromEmail,
    to: lead.email,
    subject,
    text,
    html
  });
}

export async function sendRemoteAssistLinkEmail(session, sessionLink) {
  if (!isOutboundEmailConfigured() || !session.email) {
    return { skipped: true };
  }

  const resend = new Resend(resendApiKey);
  const customerName = clean(session.clientName);
  const subject = "Your 909 Signal IT Remote Assist Link";
  const text = [
    `Hi ${customerName},`,
    "",
    "Please open this secure 909 Signal IT Remote Assist link when you are ready:",
    sessionLink,
    "",
    "Before sharing your screen, please close passwords, banking pages, medical records, private documents, or anything else you do not want visible.",
    "You can stop sharing at any time.",
    "",
    "If you need help, call or text 909-260-8660.",
    "",
    "909 Signal IT",
    "support@909signalit.com"
  ].join("\n");

  const html = `
    <p>Hi ${htmlEscape(customerName)},</p>
    <p>Please open this secure 909 Signal IT Remote Assist link when you are ready:</p>
    <p><a href="${htmlEscape(sessionLink)}">${htmlEscape(sessionLink)}</a></p>
    <p>Before sharing your screen, please close passwords, banking pages, medical records, private documents, or anything else you do not want visible.</p>
    <p>You can stop sharing at any time.</p>
    <p>If you need help, call or text <a href="tel:+19092608660">909-260-8660</a>.</p>
    <p>909 Signal IT<br><a href="mailto:support@909signalit.com">support@909signalit.com</a></p>
  `;

  return resend.emails.send({
    from: fromEmail,
    to: session.email,
    subject,
    text,
    html,
    replyTo: "support@909signalit.com"
  });
}
