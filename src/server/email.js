import { Resend } from "resend";

const notifyEmail = process.env.LEAD_NOTIFY_EMAIL || "support@909signalit.com";
const fromEmail = process.env.FROM_EMAIL;
const resendApiKey = process.env.RESEND_API_KEY;

export function isLeadNotificationConfigured() {
  return Boolean(resendApiKey && fromEmail && notifyEmail);
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
