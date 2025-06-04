const fs = require("fs");
const path = require("path");

const credentialsBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
const credentialsPath = path.join(__dirname, "lead-hunter-461815-d981f88853c3.json");

if (credentialsBase64 && !fs.existsSync(credentialsPath)) {
  fs.writeFileSync(
    credentialsPath,
    Buffer.from(credentialsBase64, "base64").toString("utf-8")
  );
}

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const { google } = require("googleapis");
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

app.post("/run-audit", async (req, res) => {
  const { website, name, email } = req.body;

  if (!website || !name || !email) {
    return res.status(400).send("Missing required fields.");
  }

  const downloadPath = path.join(__dirname, "downloads");
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath);
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  try {
    // Enable file downloads to a local folder
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
    });

    await page.goto("https://www.thehoth.com/seo-audit-tool/", {
      waitUntil: "networkidle2",
    });

    await page.type('input[name="domain"]', website);
    await page.type('input[name="first_name"]', name);
    await page.type('input[name="email"]', email);

    await Promise.all([
      page.click('input[type="submit"]'),
      page.waitForNavigation({ waitUntil: "networkidle2" }),
    ]);

    // Wait for the PDF file to be downloaded
    const waitForDownload = async () => {
      const timeout = 90000; // 90 seconds
      const start = Date.now();
      let fileName;

      while (Date.now() - start < timeout) {
        const files = fs.readdirSync(downloadPath);
        const pdfFiles = files.filter((f) => f.endsWith(".pdf"));
        if (pdfFiles.length > 0) {
          fileName = pdfFiles[0];
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!fileName) throw new Error("PDF download timed out.");
      return path.join(downloadPath, fileName);
    };

    const pdfPath = await waitForDownload();

    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });

    const drive = google.drive({ version: "v3", auth });
    const fileMetadata = { name: path.basename(pdfPath) };
    const media = {
      mimeType: "application/pdf",
      body: fs.createReadStream(pdfPath),
    };

    const uploadResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: "id",
    });

    const fileId = uploadResponse.data.id;
    const fileLink = `https://drive.google.com/file/d/${fileId}/view`;

    await browser.close();
    res.json({ auditLink: fileLink });
  } catch (error) {
    await browser.close();
    console.error("Error generating audit:", error);
    res.status(500).send("Failed to generate audit.");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Audit bot running on port ${PORT}`);
});
