import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const page = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: page("./index.html"),
        services: page("./services.html"),
        businessIt: page("./business-it.html"),
        serviceAreas: page("./service-areas.html"),
        bestLocalItSupportOntario: page("./best-local-it-support-ontario-ca.html"),
        contact: page("./contact.html"),
        reviews: page("./reviews.html"),
        resources: page("./resources.html"),
        printerOfflineResource: page("./resources/printer-keeps-going-offline-ontario-ca.html"),
        slowWifiResource: page("./resources/slow-wifi-small-business-ontario-ca.html"),
        remoteVsOnsiteResource: page("./resources/remote-it-support-vs-onsite-ontario-ca.html"),
        remoteSupport: page("./remote-support.html"),
        terms: page("./terms.html"),
        itSupportOntario: page("./it-support-ontario-ca.html"),
        computerRepairOntario: page("./computer-repair-ontario-ca.html"),
        smallBusinessItSupportOntario: page("./small-business-it-support-ontario-ca.html"),
        networkSupportOntario: page("./network-support-ontario-ca.html"),
        microsoft365EmailSupportOntario: page("./microsoft-365-email-support-ontario-ca.html"),
        wifiTroubleshootingOntario: page("./wifi-troubleshooting-ontario-ca.html"),
        printerSetupOntario: page("./printer-setup-ontario-ca.html"),
        posSupportOntario: page("./pos-support-ontario-ca.html"),
        signalscan: page("./signalscan.html")
      }
    }
  }
});
