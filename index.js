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

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  try {
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

    const downloadUrl = await page.$eval("a.download-button", (el) => el.href);

    const pdfPath = path.join(
      __dirname,
      `${website.replace(/[^a-zA-Z0-9]/g, "_")}.pdf`
    );
    const viewSource = await page.goto(downloadUrl);
    fs.writeFileSync(pdfPath, await viewSource.buffer());

    const auth = new google.auth.GoogleAuth({
      keyFile: "lead-hunter-461815-d981f88853c3.json",
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
