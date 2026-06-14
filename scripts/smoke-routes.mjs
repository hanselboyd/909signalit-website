const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:3000";

async function request(path, options = {}) {
  return fetch(new URL(path, baseUrl), {
    redirect: "manual",
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
}

async function assertOk(path, label) {
  const response = await request(path);
  if (response.status !== 200) {
    throw new Error(`${label} expected HTTP 200, got ${response.status}`);
  }
  return response;
}

function cookieHeaderFrom(response) {
  const cookie = response.headers.get("set-cookie");
  return cookie ? cookie.split(";")[0] : "";
}

async function checkDeskSignalScan() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    const response = await request("/desk/signalscan");
    const location = response.headers.get("location") || "";
    if (response.status !== 302 || location !== "/desk/login") {
      throw new Error(`/desk/signalscan expected redirect to /desk/login without auth, got ${response.status} ${location}`);
    }
    console.log("ok /desk/signalscan redirects to /desk/login without local auth");
    return;
  }

  const loginPage = await assertOk("/desk/login", "dashboard login page");
  const initialCookie = cookieHeaderFrom(loginPage);
  const body = new URLSearchParams({ username, password });
  const loginResponse = await request("/desk/login", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(initialCookie ? { cookie: initialCookie } : {})
    }
  });
  const sessionCookie = cookieHeaderFrom(loginResponse) || initialCookie;
  if (!sessionCookie) {
    throw new Error("dashboard login did not return a session cookie");
  }

  const response = await request("/desk/signalscan", {
    headers: { cookie: sessionCookie }
  });
  const text = await response.text();
  if (response.status !== 200 || !text.includes("SignalScan Launch Checklist") || !text.includes("v1.0.0 Demo Ready")) {
    throw new Error(`/desk/signalscan authenticated check failed with HTTP ${response.status}`);
  }
  console.log("ok /desk/signalscan authenticated dashboard panel");
}

const homepage = await assertOk("/", "homepage");
const homepageText = await homepage.text();
if (!homepageText.includes("/signalscan")) {
  throw new Error("homepage does not contain /signalscan link");
}
console.log("ok / homepage");

const signalScan = await assertOk("/signalscan", "SignalScan public page");
const signalScanText = await signalScan.text();
if (!signalScanText.includes("SignalScan PC Health Check by 909 Signal IT")) {
  throw new Error("/signalscan did not include the expected page title");
}
console.log("ok /signalscan");

await checkDeskSignalScan();
