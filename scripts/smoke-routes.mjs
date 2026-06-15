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

    const downloadResponse = await request("/desk/downloads/signalscan/windows");
    const downloadLocation = downloadResponse.headers.get("location") || "";
    if (downloadResponse.status !== 302 || downloadLocation !== "/desk/login") {
      throw new Error(`/desk/downloads/signalscan/windows expected redirect to /desk/login without auth, got ${downloadResponse.status} ${downloadLocation}`);
    }
    console.log("ok /desk/downloads/signalscan/windows redirects to /desk/login without local auth");
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
  if (response.status !== 200 || !text.includes("SignalScan Launch Checklist") || !text.includes("v1.0.0 Demo Ready") || !text.includes("SignalScan Package Access") || !text.includes("/desk/downloads/signalscan/windows")) {
    throw new Error(`/desk/signalscan authenticated check failed with HTTP ${response.status}`);
  }
  console.log("ok /desk/signalscan authenticated dashboard panel");

  const downloadResponse = await request("/desk/downloads/signalscan/windows", {
    headers: { cookie: sessionCookie }
  });
  if (![200, 404].includes(downloadResponse.status)) {
    throw new Error(`/desk/downloads/signalscan/windows expected HTTP 200 or dashboard-friendly 404 when authenticated, got ${downloadResponse.status}`);
  }
  if (downloadResponse.status === 404) {
    const downloadText = await downloadResponse.text();
    if (!downloadText.includes("SignalScan package is not available on this server yet.")) {
      throw new Error("/desk/downloads/signalscan/windows missing clean unavailable message");
    }
  }
  console.log("ok /desk/downloads/signalscan/windows protected authenticated route");
}

const homepage = await assertOk("/", "homepage");
const homepageText = await homepage.text();
if (!homepageText.includes("/signalscan")) {
  throw new Error("homepage does not contain /signalscan link");
}
if (homepageText.includes("/desk/downloads/signalscan/windows")) {
  throw new Error("homepage exposes the internal SignalScan package download route");
}
console.log("ok / homepage");

const signalScan = await assertOk("/signalscan", "SignalScan public page");
const signalScanText = await signalScan.text();
if (!signalScanText.includes("SignalScan PC Health Check by 909 Signal IT")) {
  throw new Error("/signalscan did not include the expected page title");
}
if (signalScanText.includes("/desk/downloads/signalscan/windows")) {
  throw new Error("/signalscan exposes the internal SignalScan package download route");
}
console.log("ok /signalscan");

await checkDeskSignalScan();
