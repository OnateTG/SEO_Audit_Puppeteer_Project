const fs = require("fs");
const path = require("path");

// --- Google Cloud Credentials Setup ---
// This part handles the Google service account credentials.
// It expects a base64 encoded JSON string in the GOOGLE_APPLICATION_CREDENTIALS_BASE64 environment variable.
// If the variable is set and the credentials file doesn't exist, it decodes and writes the file.
const credentialsBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64;
const credentialsPath = path.join(__dirname, "lead-hunter-461815-d981f88853c3.json");

if (credentialsBase64 && !fs.existsSync(credentialsPath)) {
  try {
    fs.writeFileSync(
      credentialsPath,
      Buffer.from(credentialsBase64, "base64").toString("utf-8")
    );
    console.log("Google Cloud credentials file created successfully.");
  } catch (error) {
    console.error("Error writing Google Cloud credentials file:", error);
    // Exit the process if credentials cannot be set up, as Google Drive won't work.
    process.exit(1);
  }
} else if (!credentialsBase64) {
  console.warn("GOOGLE_APPLICATION_CREDENTIALS_BASE64 environment variable not set. Google Drive functionality may not work.");
} else {
  console.log("Google Cloud credentials file already exists.");
}

// --- Puppeteer Setup ---
// Imports puppeteer-extra and the stealth plugin to avoid detection.
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

// --- Google APIs and Express Setup ---
// Imports Google APIs for Drive and Express for the web server.
const { google } = require("googleapis");
const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json()); // Middleware to parse JSON request bodies

// --- POST /run-audit Endpoint ---
// This is the main endpoint that triggers the SEO audit and PDF upload.
app.post("/run-audit", async (req, res) => {
  // Destructure required fields from the request body
  const { website, name, email } = req.body;

  // Basic validation for required fields
  if (!website || !name || !email) {
    return res.status(400).send("Missing required fields: 'website', 'name', and 'email' are mandatory.");
  }

  // Define a download path for the PDF and create it if it doesn't exist
  const downloadPath = path.join(__dirname, "downloads");
  if (!fs.existsSync(downloadPath)) {
    try {
      fs.mkdirSync(downloadPath);
      console.log(`Created download directory: ${downloadPath}`);
    } catch (error) {
      console.error("Error creating download directory:", error);
      return res.status(500).send("Failed to create download directory.");
    }
  }

  let browser; // Declare browser outside try-catch for proper closing

  try {
    // Launch Puppeteer browser in headless mode with necessary arguments for Render
    browser = await puppeteer.launch({
      headless: "new", // Use the new headless mode
      args: [
        "--no-sandbox", // Required for running in containerized environments like Render
        "--disable-setuid-sandbox", // Required for running in containerized environments
        "--disable-dev-shm-usage" // Recommended for environments with limited /dev/shm
      ],
    });
    console.log("Puppeteer browser launched.");

    const page = await browser.newPage();

    // Enable file downloads to the specified local folder
    const client = await page.target().createCDPSession();
    await client.send("Page.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadPath,
    });
    console.log(`Puppeteer download behavior set to: ${downloadPath}`);

    // Navigate to The Hoth SEO audit tool
    await page.goto("https://www.thehoth.com/seo-audit-tool/", {
      waitUntil: "networkidle2", // Wait until there are no more than 2 network connections for at least 500 ms.
      timeout: 60000 // 60 seconds timeout for navigation
    });
    console.log("Navigated to The Hoth SEO audit tool.");

    // Type the provided data into the form fields
    await page.type('input[name="domain"]', website);
    await page.type('input[name="first_name"]', name);
    await page.type('input[name="email"]', email);
    console.log("Form fields filled.");

    // Click the submit button and wait for navigation to complete
    await Promise.all([
      page.click('input[type="submit"]'),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }), // Wait up to 90 seconds for navigation after submit
    ]);
    console.log("Form submitted and navigated to results page.");

    // --- Wait for PDF Download ---
    // This function polls the download directory for a new PDF file.
    const waitForDownload = async () => {
      const timeout = 120000; // Increased timeout to 120 seconds (2 minutes) for download
      const start = Date.now();
      let fileName;

      while (Date.now() - start < timeout) {
        const files = fs.readdirSync(downloadPath);
        const pdfFiles = files.filter((f) => f.endsWith(".pdf"));
        if (pdfFiles.length > 0) {
          fileName = pdfFiles[0]; // Assuming only one PDF is downloaded at a time
          break;
        }
        await new Promise((r) => setTimeout(r, 2000)); // Check every 2 seconds
      }

      if (!fileName) {
        throw new Error("PDF download timed out. No PDF found in the downloads folder within the specified time.");
      }
      console.log(`PDF file downloaded: ${fileName}`);
      return path.join(downloadPath, fileName);
    };

    const pdfPath = await waitForDownload();

    // --- Google Drive Upload ---
    // Authenticate with Google Drive using the service account credentials
    const auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath, // Path to the JSON key file
      scopes: ["https://www.googleapis.com/auth/drive.file"], // Scope for uploading files
    });
    console.log("GoogleAuth client created.");

    const drive = google.drive({ version: "v3", auth });
    const fileMetadata = { name: path.basename(pdfPath) }; // Use the original PDF filename
    const media = {
      mimeType: "application/pdf",
      body: fs.createReadStream(pdfPath), // Read the PDF file stream
    };

    // Upload the PDF to Google Drive
    const uploadResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: "id", // Request only the file ID in the response
    });
    console.log("PDF uploaded to Google Drive.");

    const fileId = uploadResponse.data.id;
    const fileLink = `https://drive.google.com/file/d/${fileId}/view`; // Construct the shareable link

    // Clean up: delete the downloaded PDF file
    try {
      fs.unlinkSync(pdfPath);
      console.log(`Deleted local PDF file: ${pdfPath}`);
    } catch (unlinkError) {
      console.warn(`Could not delete local PDF file ${pdfPath}:`, unlinkError);
    }

    // Send the Google Drive link back as a JSON response
    res.json({ auditLink: fileLink });

  } catch (error) {
    console.error("Error during audit generation or upload:", error);
    // Send a 500 error response if anything goes wrong
    res.status(500).send(`Failed to generate audit: ${error.message || error}`);
  } finally {
    // Ensure the browser is closed even if an error occurs
    if (browser) {
      await browser.close();
      console.log("Puppeteer browser closed.");
    }
    // Clean up the downloads directory if it exists and is empty or contains old files
    if (fs.existsSync(downloadPath) && fs.readdirSync(downloadPath).length === 0) {
      try {
        fs.rmdirSync(downloadPath);
        console.log(`Removed empty download directory: ${downloadPath}`);
      } catch (rmdirError) {
        console.warn(`Could not remove empty download directory ${downloadPath}:`, rmdirError);
      }
    }
  }
});

// --- Server Start ---
// Listen on the port provided by Render or default to 3000
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Audit bot running on port ${PORT}`);
});
