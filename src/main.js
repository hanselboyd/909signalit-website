const toggle = document.querySelector(".nav-toggle");
const nav = document.querySelector("#site-nav");

if (toggle && nav) {
  toggle.addEventListener("click", () => {
    const isOpen = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!isOpen));
    nav.classList.toggle("is-open", !isOpen);
  });
}

const leadForms = document.querySelectorAll("[data-lead-form]");
const leadPageContext = new URLSearchParams(window.location.search).get("source");
const pageContextLabels = {
  "it-support-page": "IT Support Page",
  "services-page": "Services Page",
  "contact-page": "Contact Page"
};

leadForms.forEach((leadForm) => {
  const pageContextInput = leadForm.querySelector("input[name='pageContext']");
  if (pageContextInput && leadPageContext) {
    pageContextInput.value = pageContextLabels[leadPageContext] || leadPageContext;
  }

  const leadFormMessage = leadForm.querySelector("[data-lead-form-message]");
  if (!leadFormMessage) return;

  leadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submitButton = leadForm.querySelector("button[type='submit']");
    submitButton.disabled = true;
    leadFormMessage.textContent = "Sending your request...";
    leadFormMessage.className = "form-message";

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(leadForm)))
      });
      const result = await response.json();
      leadFormMessage.textContent = result.message || "Thanks — your request was received. 909 Signal IT will review the issue and follow up as soon as possible.";
      leadFormMessage.classList.toggle("form-error", !response.ok);
      leadFormMessage.classList.toggle("form-success", response.ok);
      if (response.ok) leadForm.reset();
    } catch {
      leadFormMessage.textContent = "Something went wrong. Please call or text 909-260-8660.";
      leadFormMessage.classList.add("form-error");
    } finally {
      submitButton.disabled = false;
    }
  });
});
