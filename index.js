const express = require('express');
const bodyParser = require('body-parser');
const Dropbox = require('dropbox').Dropbox;
const Airtable = require('airtable');
require('dotenv').config();
const cors = require('cors');
const axios = require('axios')
require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' })); // Example for a 100MB limit
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));
app.use(bodyParser.json());
app.use(express.static('public'));


// Function to refresh access token
async function refreshAccessToken() {
    try {
        const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;  // Store refresh token securely
        const clientId = process.env.DROPBOX_APP_KEY;
        const clientSecret = process.env.DROPBOX_APP_SECRET;

        const response = await axios.post('https://api.dropboxapi.com/oauth2/token', new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        }));

        // Save the new access token
        const newAccessToken = response.data.access_token;
        process.env.DROPBOX_APP_ACCESS_TOKEN = newAccessToken;

        return newAccessToken;
    } catch (error) {
        console.error('Error refreshing Dropbox access token:', error);
        throw error;
    }
}


// Dropbox OAuth Step
app.get('/auth/dropbox', (req, res) => {
    const redirectUri = process.env.REDIRECT_URI;
    const clientId = process.env.DROPBOX_APP_KEY;
    const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${clientId}&response_type=token&redirect_uri=${redirectUri}`;
    res.redirect(authUrl);
});

// Get Upload link with starting the session
app.post('/get-upload-link', async (req, res) => {
    let { fileName, fileSize } = req.body;

    let accessToken = process.env.DROPBOX_APP_ACCESS_TOKEN;

    async function startUploadSession(accessToken) {
        const dbx = new Dropbox({ accessToken });
        return dbx.filesUploadSessionStart({ close: false });
    }

    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
        const uniqueFileName = `${timestamp}_${fileName}`;
        const encodedFileName = encodeURIComponent(uniqueFileName);

    try {
        // Try to start the upload session with the current access token
        const response = await startUploadSession(accessToken);

        // If successful, extract session id and file path
        const sessionId = response.result.session_id;
        const filePathFinal = `/${encodedFileName}`;

        // Send the upload link and session info to the client
        res.json({
            uploadLink: `https://content.dropboxapi.com/2/files/upload_session/append_v2`,
            sessionId,
            filePathFinal,
            accessToken
        });

    } catch (error) {
        // Check for 401 Unauthorized (token expired)
        if (error.status === 401) {
            console.log('Access token expired, refreshing...');

            try {
                // Refresh the access token
                accessToken = await refreshAccessToken();

                // Retry starting the upload session with the new token
                const response = await startUploadSession(accessToken);

                const sessionId = response.result.session_id;
                // const filePathFinal = encodeURIComponent(`/${fileName}`);
                const filePathFinal = `/${encodedFileName}`;

                res.json({
                    uploadLink: `https://content.dropboxapi.com/2/files/upload_session/append_v2`,
                    sessionId,
                    filePathFinal,
                    accessToken,
                });

            } catch (refreshError) {
                // Handle error if the token refresh or retry fails
                console.error('Error after refreshing token:', refreshError);
                res.status(500).json({ error: 'Error refreshing token or creating upload session' });
            }
        } else {
            // Handle other errors unrelated to token expiry
            console.error('Error creating upload session:', error);
            res.status(500).json({ error: 'Error creating upload session' });
        }
    }
});

// Upload the file path after uploading all the chunk
app.post('/finish-upload-batch', async (req, res) => {
    const { cursorList, commitList } = req.body;

    let accessToken = process.env.DROPBOX_APP_ACCESS_TOKEN;

    const dbx = new Dropbox({ accessToken }); // Create a Dropbox instance with the access token

    try {
        const entries = cursorList.map((cursor, index) => {
            const commit = commitList[index];
            return {
                cursor,
                commit: {
                    ...commit,
                    path: commit.path.replace(/%20/g, ' ') // Replace URL-encoded spaces with regular spaces
                }
            };
        });

        // Call Dropbox API to finish the upload batch
        const response = await dbx.filesUploadSessionFinishBatchV2({ entries });

        // Log and send the response
        // console.log('Finish Upload Batch Response:', response.result);
        res.json(response.result);

    } catch (error) {
        console.error('Error finishing upload batch:', error);

        // Handle and send error response
        if (error.response && error.response.error && error.response.error.error_summary) {
            res.status(500).json({ error: error.response.error.error_summary });
        } else {
            res.status(500).json({ error: 'Error finishing upload batch' });
        }
    }
});

// Get Sharable and Downloadable link
app.post('/get-shareable-link', async (req, res) => {
    const { path } = req.body;

    let accessToken = process.env.DROPBOX_APP_ACCESS_TOKEN;

    try {
        const dbx = new Dropbox({ accessToken });
        const response = await dbx.sharingCreateSharedLinkWithSettings({ path });

        res.json({
            shareLink: response.result.url,
            downloadLink: response.result.url.replace('&dl=0', '&dl=1')
        });
    } catch (error) {
        console.error('Error creating shareable link:', error);
        if (error.response && error.response.error && error.response.error.error_summary) {
            res.status(500).json({ error: error.response.error.error_summary });
        } else {
            res.status(500).json({ error: 'Error creating shareable link' });
        }
    }
});

// Submit form to Airtable
app.post('/submit-form', async (req, res) => {
    const { name, email, description, downloadLink, shareLink } = req.body;
    const currentDate = new Date().toDateString();

    try {
        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
            process.env.AIRTABLE_BASE_ID
        );

        await base('Ministry').create({
            Name: name,
            Email: email,
            Description: description,
            DownloadLink: downloadLink,
            ShareLink: shareLink,
            SubmissionDate: currentDate
        });

        res.send('Form submitted successfully!');
    } catch (error) {
        console.error('Error sending form data to Airtable:', error);
        res.status(500).send('Error submitting form to Airtable');
    }
});


app.get('/', (req, res) => {
    res.send("Ministry Viniyard V2")
})

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
